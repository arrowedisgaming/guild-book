import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './fixtures/auth';

/**
 * TDD Step 1 (task-7-brief): privacy of the shared table's role-scoped
 * projections. Each player must see their own drawn card's face and every
 * other participant's hand as an opaque back/count only; the GM must see
 * both players' hands as backs/counts and never a face. Checked at the DOM
 * level (rendered card markup, attributes, page content, console output) —
 * never by trusting a wire-shape assumption.
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

test.describe('shared table privacy', () => {
	test('each participant sees only their own hand face; every other hand is an opaque back', async ({
		browser
	}) => {
		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		const consoleTexts: string[] = [];
		for (const page of [gmPage, playerAPage, playerBPage]) {
			page.on('console', (message) => consoleTexts.push(message.text()));
		}

		await signInAs(gmPage, 'Privacy GM');
		await signInAs(playerAPage, 'Privacy Player A');
		await signInAs(playerBPage, 'Privacy Player B');

		const invite = await createCampaignAndReadInvite(gmPage, 'Privacy Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await joinCampaign(playerBPage, invite);

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		await playerAPage.getByRole('button', { name: 'Draw a card' }).click();
		const ownCardA = playerAPage.locator('[data-testid="hand-card"] .card').first();
		await expect(ownCardA).toBeVisible();
		await expect(ownCardA).not.toHaveClass(/back/);
		const labelA = await ownCardA.getAttribute('aria-label');
		expect(labelA).toBeTruthy();
		expect(labelA).not.toBe('Face-down card');

		await playerBPage.getByRole('button', { name: 'Draw a card' }).click();
		const ownCardB = playerBPage.locator('[data-testid="hand-card"] .card').first();
		await expect(ownCardB).toBeVisible();
		await expect(ownCardB).not.toHaveClass(/back/);
		const labelB = await ownCardB.getAttribute('aria-label');
		expect(labelB).toBeTruthy();
		expect(labelB).not.toBe('Face-down card');
		expect(labelB).not.toBe(labelA);

		// Cross-client visibility of the *fact* a card was drawn (count/back),
		// within the sync budget.
		await expect(gmPage.locator('[data-testid="other-hand-back"] .card')).toHaveCount(2, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await expect(playerAPage.locator('[data-testid="other-hand-back"] .card')).toHaveCount(1, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await expect(playerBPage.locator('[data-testid="other-hand-back"] .card')).toHaveCount(1, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// The GM draws too (review round 2: with an empty `gmHand`, the "GM
		// never shows a face" check below was vacuously true either way —
		// `hand-card .card:not(.back)` is 0 whether or not the rendering is
		// actually correct. Drawing first gives the GM a real face of their
		// own, so the follow-up count assertion can only pass if it is
		// *exactly* their own card and nothing a player owns).
		await gmPage.getByRole('button', { name: 'Draw a card' }).click();
		const ownCardGm = gmPage.locator('[data-testid="hand-card"] .card').first();
		await expect(ownCardGm).toBeVisible();
		await expect(ownCardGm).not.toHaveClass(/back/);
		const labelGm = await ownCardGm.getAttribute('aria-label');
		expect(labelGm).toBeTruthy();
		expect(labelGm).not.toBe('Face-down card');

		// The GM's own hand shows exactly their own card — never a player's.
		await expect(gmPage.locator('[data-testid="hand-card"] .card:not(.back)')).toHaveCount(1);
		const gmBacks = gmPage.locator('[data-testid="other-hand-back"] .card');
		for (const back of await gmBacks.all()) {
			await expect(back).toHaveClass(/back/);
			await expect(back).toHaveAttribute('aria-label', 'Face-down card');
		}

		// Each player's own private hand section shows no other back beyond
		// their own face — the "other-hand-back" cards on their page must
		// themselves stay face-down.
		const playerABacks = playerAPage.locator('[data-testid="other-hand-back"] .card');
		for (const back of await playerABacks.all()) {
			await expect(back).toHaveClass(/back/);
			await expect(back).toHaveAttribute('aria-label', 'Face-down card');
		}
		const playerBBacks = playerBPage.locator('[data-testid="other-hand-back"] .card');
		for (const back of await playerBBacks.all()) {
			await expect(back).toHaveClass(/back/);
			await expect(back).toHaveAttribute('aria-label', 'Face-down card');
		}

		// Neither drawn card's identity string appears anywhere it should not:
		// not on the GM's page, not on the other player's page, and the GM's
		// own card never leaks to either player.
		const gmContent = await gmPage.content();
		expect(gmContent).not.toContain(labelA as string);
		expect(gmContent).not.toContain(labelB as string);

		const playerBContent = await playerBPage.content();
		expect(playerBContent).not.toContain(labelA as string);
		expect(playerBContent).not.toContain(labelGm as string);

		const playerAContent = await playerAPage.content();
		expect(playerAContent).not.toContain(labelB as string);
		expect(playerAContent).not.toContain(labelGm as string);

		// Never leaked to the console on any client either.
		const leaked = consoleTexts.some(
			(text) =>
				text.includes(labelA as string) ||
				text.includes(labelB as string) ||
				text.includes(labelGm as string)
		);
		expect(leaked).toBe(false);

		await gm.close();
		await playerA.close();
		await playerB.close();
	});

	test('play, discard, and face-down-then-reveal each disclose exactly what they should to every other client', async ({
		browser
	}) => {
		// UI issue 3: per-card Play/Play-face-down/Discard/Reveal controls were
		// entirely missing, so nothing exercised the projection's disclosure
		// rules for a *moved* card (as opposed to a freshly drawn one). Checked
		// at the DOM level, same discipline as the test above: a public move
		// (play, discard) must show the same face to every client; a face-down
		// placement must show only a back to everyone but the owner; a reveal
		// must disclose the identity to every client, but only after the
		// `reveal` command actually lands.
		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		await signInAs(gmPage, 'Actions GM');
		await signInAs(playerAPage, 'Actions Player A');
		await signInAs(playerBPage, 'Actions Player B');

		const invite = await createCampaignAndReadInvite(gmPage, 'Actions Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await joinCampaign(playerBPage, invite);

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// Player A draws three cards to act on — one each for play, face-down
		// (then reveal), and discard.
		const drawButton = playerAPage.getByRole('button', { name: 'Draw a card' });
		for (let drawn = 1; drawn <= 3; drawn += 1) {
			await drawButton.click();
			await expect(playerAPage.locator('[data-testid="hand-card"]')).toHaveCount(drawn);
		}
		const handCards = playerAPage.locator('[data-testid="hand-card"]');

		// --- Play: a public move — every client sees the same face ---
		const playedLabel = await handCards.first().locator('.card').getAttribute('aria-label');
		expect(playedLabel).toBeTruthy();
		await handCards.first().getByRole('button', { name: 'Play', exact: true }).click();
		await expect(handCards).toHaveCount(2);

		const playedCardSelector = '[data-testid="public-table"] div[aria-label="Played"] .cards .card';
		for (const page of [playerAPage, playerBPage, gmPage]) {
			await expect(page.locator(playedCardSelector)).toHaveCount(1, { timeout: CROSS_CLIENT_BUDGET_MS });
			await expect(page.locator(playedCardSelector)).toHaveAttribute('aria-label', playedLabel as string);
		}

		// --- Play face down: only the owner sees a face; everyone else sees an
		// opaque back, the same "Private effects" projection `PublicTable`
		// already renders for every private facedown/prepared zone ---
		await handCards.first().getByRole('button', { name: 'Play face down', exact: true }).click();
		await expect(handCards).toHaveCount(1);

		const ownFacedown = playerAPage.locator('[data-testid="private-facedown"] [data-testid="facedown-card"] .card');
		await expect(ownFacedown).toHaveCount(1);
		await expect(ownFacedown).not.toHaveClass(/back/);
		const facedownCardId = await ownFacedown.getAttribute('data-card-id');
		expect(facedownCardId).toBeTruthy();

		// Only Player A's facedown pile grew — the others' stay at 0, so this
		// text is unambiguous.
		for (const page of [playerBPage, gmPage]) {
			await expect(page.getByText('Face-down (1)', { exact: true })).toBeVisible({
				timeout: CROSS_CLIENT_BUDGET_MS
			});
			const content = await page.content();
			expect(content).not.toContain(facedownCardId as string);
		}

		// --- Reveal: the one command whose entire purpose is disclosure — the
		// card id must now reach every client's event log ---
		await playerAPage
			.locator('[data-testid="private-facedown"] [data-testid="facedown-card"]')
			.getByRole('button', { name: 'Reveal', exact: true })
			.click();

		for (const page of [playerBPage, gmPage]) {
			await expect(page.locator('[data-testid="event-log"]')).toContainText(facedownCardId as string, {
				timeout: CROSS_CLIENT_BUDGET_MS
			});
		}

		// --- Discard: a public-top pile — the discarded face becomes every
		// client's visible "top of the player discard" card ---
		const discardedLabel = await handCards.first().locator('.card').getAttribute('aria-label');
		expect(discardedLabel).toBeTruthy();
		await handCards.first().getByRole('button', { name: 'Discard', exact: true }).click();
		await expect(handCards).toHaveCount(0);

		const playerDiscardTopSelector =
			'[data-testid="phase-rail"] section[aria-label="Player deck"] .discard-top .card';
		for (const page of [playerAPage, playerBPage, gmPage]) {
			await expect(page.locator(playerDiscardTopSelector)).toHaveAttribute('aria-label', discardedLabel as string, {
				timeout: CROSS_CLIENT_BUDGET_MS
			});
		}

		await gm.close();
		await playerA.close();
		await playerB.close();
	});
});
