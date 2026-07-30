import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './fixtures/auth';

/**
 * Increment 5 Task 5 Step 1 — the freeze / recover / sanitized-end lifecycle,
 * end to end across three real clients.
 *
 * Why this exists: freeze and recover are the operator's only in-product tools
 * for a table that has gone wrong, and `campaign-rollback.md` tells an operator
 * to use them during an incident. Every piece is covered at the API level in
 * `tests/integration/session-api.test.ts`, but nothing verified that a *player*
 * actually finds out their table is frozen, or that play genuinely resumes
 * afterwards. An operator runbook that depends on untested UI is a runbook that
 * fails when it is needed.
 *
 * Scope note (deliberate deviation from the plan's single-file instruction):
 * Task 5 Step 1 lists six scenarios and two of them cannot honestly be written
 * as E2E specs, so they live where they can actually be asserted:
 *
 *   - "corrupt fragment / version mismatch detection → automatic freeze" needs a
 *     deliberately corrupted session fragment. Playwright drives a browser
 *     against a preview server and has no route to that state; faking it would
 *     need a test-only corruption endpoint, which is a production attack surface
 *     added for a test's convenience. It is covered in
 *     `tests/integration/session-recovery.test.ts` with direct database access.
 *   - "overnight active session across deployment" is covered where a real
 *     deployment can actually happen. `scripts/campaigns/staging-d1-smoke.mjs`
 *     redeploys the staging Worker mid-session under
 *     `CAMPAIGN_STAGING_DEPLOY_CHECK=1` and asserts the next command is still
 *     accepted against the pinned runtime; that check has been RUN, and
 *     `docs/operations/campaign-staging.md` records the result (version 3 → 4,
 *     pinned runtime intact). `tests/integration/session-runtime-pinning.test.ts`
 *     covers the mechanism underneath it — a reload after a live content-pack
 *     change still yields the originally-pinned content. Playwright drives a
 *     preview server it cannot redeploy, so re-staging this through a browser
 *     would assert less, not more.
 *
 * The four scenarios below are the ones where the browser is the only honest
 * witness.
 */

/** Spec Gate C: a public change must reach every other visible authorised
 * client within two seconds. Enforced literally here, as in
 * `shared-table.spec.ts`, rather than relaxed for convenience. */
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

test.describe('campaign freeze, recovery and sanitized end', () => {
	test('a GM freeze reaches every player, blocks archiving, and recovery restores play', async ({
		browser
	}) => {
		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		await signInAs(gmPage, 'Recovery GM');
		await signInAs(playerAPage, 'Recovery Player A');
		await signInAs(playerBPage, 'Recovery Player B');

		const invite = await createCampaignAndReadInvite(gmPage, 'Recovery Table');
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

		// Real public state before the freeze, so "public history survives" later
		// is a claim about something that actually existed.
		await playerAPage.getByRole('button', { name: 'Draw a card' }).click();
		await expect(playerAPage.locator('[data-testid="hand-card"] .card')).toHaveCount(1);

		// The GM must have POLLED UP that draw before freezing. `freeze` sends the
		// GM's tracked `expectedVersion`, and a mismatch is a deliberate hard
		// reject (`lifecycle.ts`) — so freezing while the GM's page still holds a
		// pre-draw version is refused, correctly. This wait is a real signal that
		// the GM is current, not an arbitrary settle delay.
		await expect(gmPage.locator('[data-testid="other-hand-back"] .card')).toHaveCount(1, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// --- A player has no lifecycle controls at all ---
		// Checked before the freeze: afterwards their absence would be ambiguous
		// with "hidden because the table is frozen".
		await expect(playerAPage.getByRole('button', { name: 'Freeze table' })).toHaveCount(0);
		await expect(playerAPage.getByRole('button', { name: 'Resume table' })).toHaveCount(0);
		await expect(playerAPage.getByRole('button', { name: 'End session', exact: true })).toHaveCount(0);

		// --- The GM freezes; both players must find out, unprompted ---
		await gmPage.getByRole('button', { name: 'Freeze table' }).click();
		await expect(gmPage.getByTestId('frozen-banner')).toBeVisible();

		await expect(playerAPage.getByTestId('frozen-banner')).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await expect(playerBPage.getByTestId('frozen-banner')).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		// A player is told the actionable part — that this is the GM's doing and
		// that it is temporary — not just that something is wrong.
		await expect(playerAPage.getByTestId('frozen-banner')).toContainText('Actions are paused');

		// --- Archiving is refused while a session is frozen ---
		// The archive boundary must hold for a FROZEN session, not only an active
		// one; a frozen session is exactly the state an operator is most tempted
		// to archive their way out of, and doing so would strand it.
		await gmPage.goto(`/campaigns/${campaignId}`);
		gmPage.once('dialog', (dialog) => void dialog.accept());
		await gmPage.getByRole('button', { name: 'Archive campaign' }).click();
		await expect(gmPage.getByText('End the open session before archiving the campaign.')).toBeVisible();
		// Still a live campaign, not a half-archived one.
		await expect(gmPage.getByText('Archived — read-only')).toHaveCount(0);

		// --- Recovery restores play for everyone ---
		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await expect(gmPage.getByTestId('frozen-banner')).toBeVisible();
		await gmPage.getByRole('button', { name: 'Resume table' }).click();
		await expect(gmPage.getByTestId('frozen-banner')).toHaveCount(0);

		await expect(playerAPage.getByTestId('frozen-banner')).toHaveCount(0, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await expect(playerBPage.getByTestId('frozen-banner')).toHaveCount(0, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// Recovery is only real if the table actually works afterwards. Player B
		// has not drawn yet, so this is a fresh command against a recovered
		// session rather than a replay of pre-freeze state.
		await playerBPage.getByRole('button', { name: 'Draw a card' }).click();
		await expect(playerBPage.locator('[data-testid="hand-card"] .card')).toHaveCount(1);
		await expect(gmPage.locator('[data-testid="other-hand-back"] .card')).toHaveCount(2, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		// Player A's pre-freeze card survived the freeze/recover cycle — the
		// round trip must not have quietly reset the table.
		await expect(playerAPage.locator('[data-testid="hand-card"] .card')).toHaveCount(1);

		await gm.close();
		await playerA.close();
		await playerB.close();
	});

	test('a GM can end a frozen session, clearing private hands and keeping public history', async ({
		browser
	}) => {
		// The "recovery cannot proceed" path: when a frozen table cannot be
		// resumed, the GM's escape hatch is to end it. That must be reachable
		// FROM the frozen state (not only from active), must destroy private
		// hands, and must still leave members a readable public record —
		// otherwise an incident silently costs the group their session.
		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();

		await signInAs(gmPage, 'Sanitized GM');
		await signInAs(playerAPage, 'Sanitized Player');

		const invite = await createCampaignAndReadInvite(gmPage, 'Sanitized End Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({
			timeout: CROSS_CLIENT_BUDGET_MS
		});
		await playerAPage.getByRole('button', { name: 'Draw a card' }).click();
		await expect(playerAPage.locator('[data-testid="hand-card"] .card')).toHaveCount(1);

		// As above: the GM must be current on the session version before a
		// lifecycle action, or `freeze` is correctly refused as stale.
		await expect(gmPage.locator('[data-testid="other-hand-back"] .card')).toHaveCount(1, {
			timeout: CROSS_CLIENT_BUDGET_MS
		});

		await gmPage.getByRole('button', { name: 'Freeze table' }).click();
		await expect(gmPage.getByTestId('frozen-banner')).toBeVisible();

		// End is offered while frozen — this is the whole point of the path.
		await gmPage.getByRole('button', { name: 'End session', exact: true }).click();
		await expect(gmPage.getByTestId('end-session-confirm')).toBeVisible();
		await gmPage.getByRole('button', { name: 'Confirm end' }).click();
		await expect(gmPage.getByRole('button', { name: 'Start session' })).toBeVisible({ timeout: 8000 });

		// The player's private hand is gone, and they are not left staring at a
		// frozen banner for a session that no longer exists.
		await expect(playerAPage.locator('[data-testid="hand-card"] .card')).toHaveCount(0, {
			timeout: 8000
		});
		await expect(playerAPage.getByTestId('frozen-banner')).toHaveCount(0);

		// Public history survived, and is readable by a member with a checksum.
		await playerAPage.goto(`/campaigns/${campaignId}/sessions`);
		await expect(playerAPage.getByTestId('session-list')).toBeVisible({ timeout: 4000 });
		await playerAPage.getByTestId('session-link-1').click();
		await expect(playerAPage.getByTestId('history-log')).toBeVisible({ timeout: 4000 });
		await expect(playerAPage.getByTestId('history-meta')).toContainText('checksum');

		// With the session ended, the archive boundary releases.
		await gmPage.goto(`/campaigns/${campaignId}`);
		gmPage.once('dialog', (dialog) => void dialog.accept());
		await gmPage.getByRole('button', { name: 'Archive campaign' }).click();
		await gmPage.waitForURL(/\/campaigns$/);

		await gm.close();
		await playerA.close();
	});
});
