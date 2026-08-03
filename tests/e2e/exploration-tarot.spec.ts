import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';
import { attachAdventurer, campaignIdFromUrl, createCampaignAndReadInvite, joinCampaign } from './fixtures/challenge';

/**
 * Increment 4 Task 4 — the finite runner end to end: a GM oracle that consults
 * the discard top, and a player procedure whose resolved table text reaches
 * every context. What only a browser test proves: the panels render entirely
 * from the server's legal set (a player never sees the GM's advance), and the
 * resolved rule text is table-visible the moment the step resolves.
 */

async function clickFinite(page: Page, locator: Locator, timeoutMs = 15000): Promise<void> {
	const [response] = await Promise.all([
		page.waitForResponse((res) => res.url().includes('/finite-commands') && res.request().method() === 'POST', { timeout: timeoutMs }),
		locator.click()
	]);
	if (!response.ok()) {
		const body = await response.text().catch(() => '<unreadable response body>');
		throw new Error(`finite command via ${locator} failed (HTTP ${response.status()}): ${body}`);
	}
}

async function clickGeneric(page: Page, locator: Locator, timeoutMs = 15000): Promise<void> {
	const [response] = await Promise.all([
		page.waitForResponse(
			(res) => res.url().includes('/commands') && !res.url().includes('-commands/') && !res.url().match(/(challenge|guided-test|camp|finite)-commands/),
			{ timeout: timeoutMs }
		),
		locator.click()
	]);
	if (!response.ok()) throw new Error(`generic command failed (HTTP ${response.status()})`);
}

test.describe('exploration and oracle procedures', () => {
	test('the GM twist consults the discard top and Random Totem resolves for the whole table', async ({ browser }) => {
		test.setTimeout(180_000);

		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();

		await signInAs(gmPage, 'Oracle GM');
		await signInAs(playerAPage, 'Oracle Player A');
		await createTestAdventurer(playerAPage, 'Seer Adalyn');

		const invite = await createCampaignAndReadInvite(gmPage, 'Oracle Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await attachAdventurer(playerAPage, 'Seer Adalyn');

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();
		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 15000 });

		// Seed the minor discard: the twist reads its top card.
		await clickGeneric(playerAPage, playerAPage.getByRole('button', { name: 'Draw a card' }));
		const discard = playerAPage.getByRole('button', { name: /^Discard/ }).first();
		await expect(discard).toBeVisible({ timeout: 15000 });
		await clickGeneric(playerAPage, discard);

		// --- GM twist through the oracle panel ---
		const oraclePicker = gmPage.getByTestId('finite-panel-cross-phase').getByTestId('finite-procedure-picker');
		await expect(oraclePicker).toBeVisible({ timeout: 15000 });
		await oraclePicker.selectOption('gm-twist');
		await clickFinite(gmPage, gmPage.getByTestId('finite-panel-cross-phase').getByTestId('finite-begin'));

		// The consult is the GM's; the player has no advance control.
		await expect(playerAPage.getByTestId('finite-advance')).toHaveCount(0);
		await clickFinite(gmPage, gmPage.getByTestId('finite-panel-cross-phase').getByTestId('finite-advance'));

		// The resolved twist text reaches both contexts, with the GM's reminder
		// that the app supplies rule text only.
		for (const page of [gmPage, playerAPage]) {
			await expect(page.getByTestId('finite-outcome-consult-discard-top').first()).toBeVisible({ timeout: 15000 });
			await expect(page.getByTestId('finite-outcome-consult-discard-top').first()).toContainText('The GM adjudicates the consequence');
		}

		await clickFinite(gmPage, gmPage.getByTestId('finite-panel-cross-phase').getByTestId('finite-complete'));
		await expect(gmPage.getByTestId('finite-outcome-consult-discard-top').first()).toHaveCount(0, { timeout: 15000 });

		// --- Random Totem: the GM names the actor, the PLAYER draws ---
		await oraclePicker.selectOption('oracle-random-totem');
		await gmPage.getByTestId('finite-panel-cross-phase').getByTestId('finite-actor-picker').selectOption({ label: 'Seer Adalyn' });
		await clickFinite(gmPage, gmPage.getByTestId('finite-panel-cross-phase').getByTestId('finite-begin'));

		await expect(gmPage.getByTestId('finite-advance')).toHaveCount(0);
		const playerAdvance = playerAPage.getByTestId('finite-panel-cross-phase').getByTestId('finite-advance');
		await expect(playerAdvance).toBeVisible({ timeout: 15000 });
		await clickFinite(playerAPage, playerAdvance);

		// The totem — a verbatim table cell — is table-visible everywhere.
		for (const page of [gmPage, playerAPage]) {
			await expect(page.getByTestId('finite-outcome-draw-totem').first()).toBeVisible({ timeout: 15000 });
		}

		await clickFinite(gmPage, gmPage.getByTestId('finite-panel-cross-phase').getByTestId('finite-complete'));

		// --- Maleficence: the mode and realm must actually reach the server ---
		// Review finding: the panel never sent `mode`/`realmTableId`, so both
		// mode-gated steps were inapplicable and the procedure completed having
		// drawn nothing.
		await oraclePicker.selectOption('oracle-maleficence');
		const panel = gmPage.getByTestId('finite-panel-cross-phase');
		await expect(panel.getByTestId('finite-mode-picker')).toBeVisible({ timeout: 15000 });
		await panel.getByTestId('finite-mode-picker').selectOption('appropriate-realm');
		await panel.getByTestId('finite-realm-picker').selectOption('maleficence-weald');
		await clickFinite(gmPage, panel.getByTestId('finite-begin'));

		await clickFinite(gmPage, panel.getByTestId('finite-advance'));
		// A real table cell resolved — not an immediately-completed no-op.
		await expect(gmPage.getByTestId('finite-outcome-draw-applicable-maleficence').first()).toBeVisible({ timeout: 15000 });
		await clickFinite(gmPage, panel.getByTestId('finite-complete'));

		await gm.close();
		await playerA.close();
	});

	test('Augury can be declined, and a flat-50% gate can answer no', async ({ browser }) => {
		test.setTimeout(180_000);

		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();

		await signInAs(gmPage, 'Fork GM');
		await signInAs(playerAPage, 'Fork Player A');
		await createTestAdventurer(playerAPage, 'Augur Rell');

		const invite = await createCampaignAndReadInvite(gmPage, 'Fork Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await attachAdventurer(playerAPage, 'Augur Rell');

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();
		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 15000 });

		const panel = gmPage.getByTestId('finite-panel-cross-phase');
		await panel.getByTestId('finite-procedure-picker').selectOption('test-augury');
		await panel.getByTestId('finite-actor-picker').selectOption({ label: 'Augur Rell' });
		await clickFinite(gmPage, panel.getByTestId('finite-begin'));

		// The GM's private draw, then the GM's parable — the player has neither.
		await expect(playerAPage.getByTestId('finite-advance')).toHaveCount(0);
		await clickFinite(gmPage, panel.getByTestId('finite-advance'));
		// The parable step is a confirm: BOTH answers are offered (review finding —
		// it used to hardcode yes).
		await expect(panel.getByTestId('finite-decline')).toBeVisible({ timeout: 15000 });
		await clickFinite(gmPage, panel.getByTestId('finite-advance'));

		// The player's choice, answered NO.
		const playerPanel = playerAPage.getByTestId('finite-panel-cross-phase');
		await expect(playerPanel.getByTestId('finite-decline')).toBeVisible({ timeout: 15000 });
		await clickFinite(playerAPage, playerPanel.getByTestId('finite-decline'));

		// The accept/decline FORK is now reachable in both directions.
		await expect(panel.getByTestId('finite-fork-accept-card')).toBeVisible({ timeout: 15000 });
		await expect(panel.getByTestId('finite-fork-decline-card')).toBeVisible();
		await clickFinite(gmPage, panel.getByTestId('finite-fork-decline-card'));

		await clickFinite(gmPage, panel.getByTestId('finite-complete'));

		await gm.close();
		await playerA.close();
	});
});
