import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './fixtures/auth';

/**
 * TDD Step 1 (task-7-brief): the table-first shell's automatic visible
 * polling — a GM and two players share one live table, public play (a
 * session starting, a hand count changing) becomes visible to every other
 * client with no manual refresh, a hidden tab stops polling while a
 * focused/reconnected one refreshes immediately, and a duplicate command
 * application (same commandId) never double-applies.
 *
 * Privacy assertions (own face vs. others' backs) live in
 * `shared-table-privacy.spec.ts` — this file is about the sync mechanics.
 *
 * Cross-client propagation budget: the brief's acceptance bar (Gate C) is
 * "within two seconds" — enforced literally below, not loosened.
 */
const CROSS_CLIENT_BUDGET_MS = 2000;

async function createCampaignAndReadInvite(page: Page, name: string): Promise<string> {
	await page.goto('/campaigns/new');
	await page.getByLabel('Campaign name').fill(name);
	await page.getByRole('button', { name: 'Create campaign' }).click();
	await page.waitForURL(/\/campaigns\/[^/]+$/);
	return page.getByLabel('Invite link').inputValue();
}

async function joinCampaign(page: Page, invite: string): Promise<void> {
	await page.goto(invite);
	await page.getByRole('button', { name: 'Join campaign' }).click();
	await expect(page.getByText('Joined without an adventurer')).toBeVisible();
}

function campaignIdFromUrl(url: string): string {
	const match = url.match(/\/campaigns\/([^/?#]+)/);
	if (!match) throw new Error(`could not read a campaign id from ${url}`);
	return match[1];
}

/** Stubs `document.visibilityState` and fires a real `visibilitychange`
 * event — headless Chromium doesn't reliably reflect real tab-focus
 * transitions in `document.visibilityState` across pages in the same
 * context, so this exercises the store's actual listener deterministically
 * instead of depending on OS/window-manager-level tab focus. */
async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
	await page.evaluate((isHidden) => {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => (isHidden ? 'hidden' : 'visible')
		});
		document.dispatchEvent(new Event('visibilitychange'));
	}, hidden);
}

test.describe('shared table sync', () => {
	test('a session starting and a hand draw both reach every other client with no manual refresh', async ({
		browser
	}) => {
		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		await signInAs(gmPage, 'Sync GM');
		await signInAs(playerAPage, 'Sync Player A');
		await signInAs(playerBPage, 'Sync Player B');

		const invite = await createCampaignAndReadInvite(gmPage, 'Sync Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await joinCampaign(playerBPage, invite);

		// Both players open the table before any session exists.
		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByText('Waiting for the GM to start a session.')).toBeVisible();
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerBPage.getByText('Waiting for the GM to start a session.')).toBeVisible();

		// The GM starts a session on their own page (a normal form submission —
		// this is the actor's own navigation, not the "no manual refresh"
		// requirement, which is about the *other* clients below).
		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		// Both players must see the live table without reloading.
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// Player A draws — their own face appears immediately (optimistic
		// projection replacement from the command response, not a poll).
		await playerAPage.getByRole('button', { name: 'Draw a card' }).click();
		await expect(playerAPage.locator('[data-testid="hand-card"] .card')).toHaveCount(1);

		// Player B and the GM must see player A's hand count rise, with no
		// manual refresh.
		await expect(playerBPage.locator('[data-testid="other-hand-back"] .card')).toHaveCount(1, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await expect(gmPage.locator('[data-testid="other-hand-back"] .card')).toHaveCount(1, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// --- Hidden tab pauses polling; regaining visibility refreshes
		// immediately ---
		const syncRequests: string[] = [];
		playerBPage.on('request', (request) => {
			if (request.url().includes('/sync')) syncRequests.push(request.url());
		});

		await setPageHidden(playerBPage, true);
		syncRequests.length = 0;
		// Two full poll cadences (1s + up to 150ms jitter each) would produce
		// requests if polling weren't paused; wait comfortably past that.
		await playerBPage.waitForTimeout(2300);
		expect(syncRequests).toHaveLength(0);

		syncRequests.length = 0;
		await setPageHidden(playerBPage, false);
		await expect.poll(() => syncRequests.length, { timeout: 1000 }).toBeGreaterThan(0);

		// --- Reconnect triggers an immediate refresh ---
		syncRequests.length = 0;
		await playerB.setOffline(true);
		await playerBPage.waitForTimeout(100);
		await playerB.setOffline(false);
		await expect.poll(() => syncRequests.length, { timeout: 1000 }).toBeGreaterThan(0);

		// --- Duplicate click with one commandId applies once ---
		const handCountBefore = await playerAPage.locator('[data-testid="hand-card"] .card').count();
		const drawButton = playerAPage.getByRole('button', { name: 'Draw a card' });
		await Promise.all([drawButton.click(), drawButton.click()]);
		await expect
			.poll(() => playerAPage.locator('[data-testid="hand-card"] .card').count())
			.toBe(handCountBefore + 1);
		// Give any wrongly-duplicated second application time to land, then
		// confirm it never does.
		await playerAPage.waitForTimeout(500);
		expect(await playerAPage.locator('[data-testid="hand-card"] .card').count()).toBe(
			handCountBefore + 1
		);

		await gm.close();
		await playerA.close();
		await playerB.close();
	});

	test('a mobile viewport renders the public table before the phase/log drawers, in real DOM order', async ({
		browser
	}) => {
		// Review round 2: the plan/brief mandate "table first" on mobile, but
		// nothing exercised a mobile viewport before this — the drawers were
		// shipped rendering ahead of the table in actual DOM order (visually
		// hidden by CSS on desktop, but wrong on mobile, where the whole point
		// is that the table leads). Checking document order (not just visual
		// position) so a future CSS-`order`-only "fix" can't silently
		// re-introduce the same bug.
		const gm = await browser.newContext({ viewport: { width: 390, height: 844 } });
		const gmPage = await gm.newPage();
		await signInAs(gmPage, 'Mobile Order GM');

		const invite = await createCampaignAndReadInvite(gmPage, 'Mobile Order Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		void invite; // only the GM is needed for this check; no player join required.

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();
		// Confirms the mobile branch (not the desktop grid) actually rendered —
		// the drawers component only exists in the mobile layout.
		await expect(gmPage.locator('[data-testid="mobile-drawers"]')).toBeVisible();

		const order = await gmPage.evaluate(() => {
			const shell = document.querySelector('[data-testid="table-shell"]');
			if (!shell) return null;
			const nodes = Array.from(
				shell.querySelectorAll('[data-testid="public-table"], [data-testid="mobile-drawers"]')
			);
			return nodes.map((node) => node.getAttribute('data-testid'));
		});
		expect(order).toEqual(['public-table', 'mobile-drawers']);

		await gm.close();
	});

	test('the private hand scrolls horizontally instead of overflowing its border once it holds many cards', async ({
		browser
	}) => {
		// Bug fix (UI issue 1): the hand strip had no overflow handling, so more
		// than 4-5 cards spilled visually past the section border rather than
		// staying contained. Cheap DOM/style assertions — no need to actually
		// scroll or screenshot — confirm the container both declares horizontal
		// scrolling and genuinely has more content than it can show at once.
		const gm = await browser.newContext();
		const gmPage = await gm.newPage();
		await signInAs(gmPage, 'Overflow GM');

		const invite = await createCampaignAndReadInvite(gmPage, 'Overflow Table');
		void invite; // solo GM is enough to fill their own hand.

		await gmPage.goto(`/campaigns/${campaignIdFromUrl(gmPage.url())}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		const drawButton = gmPage.getByRole('button', { name: 'Draw a card' });
		await expect(drawButton).toBeVisible();

		const handCards = gmPage.locator('[data-testid="hand-card"]');
		for (let drawn = 1; drawn <= 12; drawn += 1) {
			await drawButton.click();
			await expect(handCards).toHaveCount(drawn);
		}

		const cardsContainer = gmPage.locator('[data-testid="private-hand"] .cards');
		await expect(cardsContainer).toHaveCSS('overflow-x', 'auto');

		const { scrollWidth, clientWidth } = await cardsContainer.evaluate((el) => ({
			scrollWidth: el.scrollWidth,
			clientWidth: el.clientWidth
		}));
		expect(scrollWidth).toBeGreaterThan(clientWidth);

		// Review fix: a GM "Transfer" control can never succeed — `gmHand` is
		// major-deck-only, every `hand:<userId>` zone is player-deck-only, and
		// `handleGenericMove`'s deck check rejects every cross-deck move — so
		// the GM must have no Transfer button on any hand card, only
		// Play/Play-face-down/Discard.
		await expect(handCards.getByRole('button', { name: 'Transfer', exact: false })).toHaveCount(0);
		await expect(handCards.first().getByRole('button', { name: 'Play', exact: true })).toBeVisible();

		await gm.close();
	});

	test('the deal button is disabled with a hint when no other hands are connected yet', async ({ browser }) => {
		// Bug fix (UI issue 2a): with no other campaign members, `dealToHands`
		// has no valid destination — the button must say so up front instead of
		// silently no-oping on click.
		const gm = await browser.newContext();
		const gmPage = await gm.newPage();
		await signInAs(gmPage, 'Deal Guard GM');

		await createCampaignAndReadInvite(gmPage, 'Deal Guard Table'); // no one joins
		const campaignId = campaignIdFromUrl(gmPage.url());

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		const dealButton = gmPage.getByRole('button', { name: 'Deal a card to each hand' });
		await expect(dealButton).toBeVisible();
		await expect(dealButton).toBeDisabled();
		await expect(dealButton).toHaveAttribute('title', 'No other hands to deal to yet');
		// Nothing to reject once the button is genuinely disabled — the generic
		// error banner must not appear on page load either.
		await expect(gmPage.locator('.action-error')).toHaveCount(0);

		await gm.close();
	});

	test('GM freeze/recover/end lifecycle, and restarting the session seeds a hand for a mid-session late joiner', async ({
		browser
	}) => {
		// The user's actual repro: a member who joins *after* the GM has
		// already started a session never gets a `hand:<userId>` zone (only
		// members active at `startSession` time are seeded one) — the remedy is
		// ending and restarting the session, which reseeds zones for every
		// currently-active member. This test exercises the full GM lifecycle
		// surface end-to-end and confirms that remedy actually works.
		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		await signInAs(gmPage, 'Lifecycle GM');
		await signInAs(playerAPage, 'Lifecycle Player A');
		await signInAs(playerBPage, 'Lifecycle Player B');

		const invite = await createCampaignAndReadInvite(gmPage, 'Lifecycle Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByText('Waiting for the GM to start a session.')).toBeVisible();

		// GM starts the first session before Player B joins.
		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// Player B — the late joiner — joins mid-session.
		await joinCampaign(playerBPage, invite);
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// Confirms the repro: the late joiner's hand zone was never seeded for
		// this session, so a draw is rejected — gracefully, via the store's
		// fixed generic error, never a raw server message.
		await playerBPage.getByRole('button', { name: 'Draw a card' }).click();
		await expect(playerBPage.locator('.action-error')).toBeVisible();
		await expect(playerBPage.locator('[data-testid="hand-card"]')).toHaveCount(0);

		// --- GM freezes the table ---
		await gmPage.getByRole('button', { name: 'Freeze table' }).click();
		await expect(gmPage.getByTestId('frozen-banner')).toBeVisible();
		await expect(playerAPage.getByTestId('frozen-banner')).toBeVisible({ timeout: CROSS_CLIENT_BUDGET_MS });

		// A player command against a frozen session still fails gracefully.
		await playerAPage.getByRole('button', { name: 'Draw a card' }).click();
		await expect(playerAPage.locator('.action-error')).toBeVisible();
		await expect(playerAPage.locator('[data-testid="hand-card"]')).toHaveCount(0);

		// --- GM recovers ---
		await gmPage.getByRole('button', { name: 'Resume table' }).click();
		await expect(gmPage.getByTestId('frozen-banner')).toHaveCount(0);
		await expect(playerAPage.getByTestId('frozen-banner')).toHaveCount(0, { timeout: CROSS_CLIENT_BUDGET_MS });

		// Play works again once recovered.
		await playerAPage.getByRole('button', { name: 'Draw a card' }).click();
		await expect(playerAPage.locator('[data-testid="hand-card"] .card')).toHaveCount(1);

		// The GM's own session-version snapshot only advances on its next poll
		// — wait for it to observe Player A's draw before ending, so the GM's
		// `expectedVersion` on the end PATCH isn't stale against the version
		// the draw just claimed (a real 409 the store would otherwise surface
		// as a generic, unhelpful failure here).
		await expect(gmPage.locator('[data-testid="other-hand-back"] .card')).toHaveCount(1, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// --- GM ends the session, via the required inline confirm (no
		// browser confirm() dialog — those block the automation harness) ---
		await expect(gmPage.getByTestId('end-session-confirm')).toHaveCount(0);
		await gmPage.getByRole('button', { name: 'End session', exact: true }).click();
		await expect(gmPage.getByTestId('end-session-confirm')).toBeVisible();
		await gmPage.getByRole('button', { name: 'Confirm end' }).click();

		// All three contexts land back at the no-open-session state.
		await expect(gmPage.getByRole('button', { name: 'Start session' })).toBeVisible();
		await expect(playerAPage.getByText('Waiting for the GM to start a session.')).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await expect(playerBPage.getByText('Waiting for the GM to start a session.')).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// --- GM starts a fresh session — Player B is now an active member as
		// of *this* session's start, so their hand zone is seeded this time. ---
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await playerBPage.getByRole('button', { name: 'Draw a card' }).click();
		await expect(playerBPage.locator('[data-testid="hand-card"] .card')).toHaveCount(1);
		await expect(playerBPage.locator('.action-error')).toHaveCount(0);

		await gm.close();
		await playerA.close();
		await playerB.close();
	});
});
