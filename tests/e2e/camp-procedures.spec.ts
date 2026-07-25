import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';
import { attachAdventurer, campaignIdFromUrl, createCampaignAndReadInvite, joinCampaign } from './fixtures/challenge';

/**
 * Increment 4 Task 3 Step 3 — the Camp procedures end to end, across three
 * browser contexts (GM + two players).
 *
 * The load-bearing assertion is the privacy one, and it can only really be made
 * here: after a High Chant hands a card over, the RECIPIENT's browser shows the
 * face, and the bystanding player's and the GM's browsers show only a count.
 * Nothing in the unit suite can prove that no template branch leaks it.
 */

/** Clicks `locator` and waits for the `/camp-commands` POST it triggers to
 * resolve, throwing with the response body on a rejection. */
async function clickCamp(page: Page, locator: Locator, timeoutMs = 8000): Promise<void> {
	const [response] = await Promise.all([
		page.waitForResponse((res) => res.url().includes('/camp-commands') && res.request().method() === 'POST', { timeout: timeoutMs }),
		locator.click()
	]);
	if (!response.ok()) {
		const body = await response.text().catch(() => '<unreadable response body>');
		throw new Error(`camp command via ${locator} failed (HTTP ${response.status()}): ${body}`);
	}
}

/** Clicks a GENERIC table control (draw/discard) and waits for its own route. */
async function clickGeneric(page: Page, locator: Locator, timeoutMs = 8000): Promise<void> {
	const [response] = await Promise.all([
		page.waitForResponse(
			(res) => res.url().includes('/commands') && !res.url().includes('camp-commands') && res.request().method() === 'POST',
			{ timeout: timeoutMs }
		),
		locator.click()
	]);
	if (!response.ok()) {
		const body = await response.text().catch(() => '<unreadable response body>');
		throw new Error(`command via ${locator} failed (HTTP ${response.status()}): ${body}`);
	}
}

/** Puts `count` cards into the minor discard by drawing and discarding them —
 * the High Chant selects from that pile, so it must not be empty. */
async function seedMinorDiscard(page: Page, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await clickGeneric(page, page.getByRole('button', { name: 'Draw a card' }));
		const discard = page.getByRole('button', { name: /^Discard/ }).first();
		await expect(discard).toBeVisible({ timeout: 4000 });
		await clickGeneric(page, discard);
	}
}

test.describe('camp procedures', () => {
	test('High Chant: the performer selects inspiration, hands one over, and only the recipient sees its face', async ({ browser }) => {
		test.setTimeout(180_000);

		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		await signInAs(gmPage, 'Camp GM');
		await signInAs(playerAPage, 'Camp Player A');
		await signInAs(playerBPage, 'Camp Player B');
		await createTestAdventurer(playerAPage, 'Ilna Roke');
		await createTestAdventurer(playerBPage, 'Bevis Dunn');

		const invite = await createCampaignAndReadInvite(gmPage, 'Camp Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await attachAdventurer(playerAPage, 'Ilna Roke');
		await joinCampaign(playerBPage, invite);
		await attachAdventurer(playerBPage, 'Bevis Dunn');

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 4000 });
		await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 4000 });

		// A Camp Action belongs to an adventurer, never the GM.
		await expect(playerAPage.getByTestId('begin-high-chant')).toBeVisible({ timeout: 4000 });
		await expect(gmPage.getByTestId('begin-high-chant')).toHaveCount(0);

		// The pile the High Chant draws inspiration from has to exist first.
		await seedMinorDiscard(playerAPage, 2);

		await clickCamp(playerAPage, playerAPage.getByTestId('begin-high-chant'));
		await expect(playerAPage.getByTestId('chant-performer')).toHaveText('Ilna Roke', { timeout: 4000 });
		// The allowance came from the sheet's Cups, not from anything the client sent.
		await expect(playerAPage.getByTestId('chant-allowance')).not.toBeEmpty();

		// Only the performer selects.
		await expect(playerBPage.getByTestId('submit-selection')).toHaveCount(0);
		const picks = playerAPage.locator('[data-testid^="pick-"]');
		await expect(picks.first()).toBeVisible({ timeout: 4000 });
		await picks.first().check();
		await clickCamp(playerAPage, playerAPage.getByTestId('submit-selection'));

		// Hand it to Bevis.
		await expect(playerAPage.getByTestId('hand-over-card')).toBeVisible({ timeout: 4000 });
		const cardValue = await playerAPage.getByTestId('hand-over-card').locator('option').nth(1).getAttribute('value');
		if (!cardValue) throw new Error('no selected inspiration card to hand over');
		await playerAPage.getByTestId('hand-over-card').selectOption(cardValue);
		await playerAPage.getByTestId('hand-over-recipient').selectOption({ label: 'Bevis Dunn' });
		await clickCamp(playerAPage, playerAPage.getByTestId('hand-over'));

		// --- The privacy assertion ---
		// Bevis sees the face.
		await expect(playerBPage.getByTestId('my-inspiration')).toBeVisible({ timeout: 6000 });
		const bevisSees = (await playerBPage.getByTestId('my-inspiration').textContent()) ?? '';
		expect(bevisSees).toContain('Your inspiration card:');

		// Every context sees THAT Bevis holds one.
		for (const page of [gmPage, playerAPage, playerBPage]) {
			await expect(page.getByTestId('inspiration-holdings')).toContainText('Bevis Dunn holds 1 inspiration card', { timeout: 6000 });
		}

		// Nobody else's page shows the face — not the performer's, not the GM's.
		await expect(playerAPage.getByTestId('my-inspiration')).toHaveCount(0);
		await expect(gmPage.getByTestId('my-inspiration')).toHaveCount(0);
		// And the card's own label appears nowhere in their rendered Camp panels.
		const cardLabel = bevisSees.replace('Your inspiration card:', '').trim();
		expect(cardLabel.length).toBeGreaterThan(0);
		await expect(gmPage.getByTestId('camp-panel')).not.toContainText(cardLabel);
		await expect(playerAPage.getByTestId('camp-panel')).not.toContainText(cardLabel);

		// Finishing returns anything undistributed to the discard.
		await clickCamp(playerAPage, playerAPage.getByTestId('complete-camp'));
		await expect(playerAPage.getByTestId('chant-performer')).toHaveCount(0, { timeout: 4000 });
		// Ch5: inspiration lasts until used or the session ends — it survives.
		await expect(playerBPage.getByTestId('my-inspiration')).toBeVisible();

		await gm.close();
		await playerA.close();
		await playerB.close();
	});

	test('leeches: the outcome is public and the app says the table must apply it', async ({ browser }) => {
		test.setTimeout(180_000);

		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		await signInAs(gmPage, 'Leech GM');
		await signInAs(playerAPage, 'Leech Player A');
		await signInAs(playerBPage, 'Leech Player B');
		await createTestAdventurer(playerAPage, 'Surgeon Vale');
		await createTestAdventurer(playerBPage, 'Patient Orm');

		const invite = await createCampaignAndReadInvite(gmPage, 'Leech Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await attachAdventurer(playerAPage, 'Surgeon Vale');
		await joinCampaign(playerBPage, invite);
		await attachAdventurer(playerBPage, 'Patient Orm');

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 4000 });

		// Apply them to the OTHER adventurer (Ch9 is explicit about "another").
		await expect(playerAPage.getByTestId('leech-target-select')).toBeVisible({ timeout: 4000 });
		await playerAPage.getByTestId('leech-target-select').selectOption({ label: 'Patient Orm' });
		await clickCamp(playerAPage, playerAPage.getByTestId('begin-leeches'));

		// The rule text comes from the content pack's own suit sets.
		await expect(playerAPage.getByTestId('leech-rule')).toContainText('nothing happens', { timeout: 4000 });

		// Only the applier draws.
		await expect(playerBPage.getByTestId('advance-leeches')).toHaveCount(0);
		await expect(gmPage.getByTestId('advance-leeches')).toHaveCount(0);
		await clickCamp(playerAPage, playerAPage.getByTestId('advance-leeches'));

		// Public: the card and the outcome reach every context.
		for (const page of [gmPage, playerAPage, playerBPage]) {
			await expect(page.getByTestId('leech-card')).toBeVisible({ timeout: 6000 });
			await expect(page.getByTestId('leech-outcome')).toBeVisible({ timeout: 6000 });
			// The app never applied it — it says so.
			await expect(page.getByTestId('leech-outcome')).toContainText('the app does not');
		}

		await clickCamp(playerAPage, playerAPage.getByTestId('complete-camp'));
		await expect(playerAPage.getByTestId('leech-outcome')).toHaveCount(0, { timeout: 4000 });

		await gm.close();
		await playerA.close();
		await playerB.close();
	});
});
