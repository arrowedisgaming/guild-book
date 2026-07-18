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

		// The GM never renders a face for either player's hand.
		await expect(gmPage.locator('[data-testid="hand-card"] .card:not(.back)')).toHaveCount(0);
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
		// not on the GM's page, not on the other player's page.
		const gmContent = await gmPage.content();
		expect(gmContent).not.toContain(labelA as string);
		expect(gmContent).not.toContain(labelB as string);

		const playerBContent = await playerBPage.content();
		expect(playerBContent).not.toContain(labelA as string);

		const playerAContent = await playerAPage.content();
		expect(playerAContent).not.toContain(labelB as string);

		// Never leaked to the console on any client either.
		const leaked = consoleTexts.some(
			(text) => text.includes(labelA as string) || text.includes(labelB as string)
		);
		expect(leaked).toBe(false);

		await gm.close();
		await playerA.close();
		await playerB.close();
	});
});
