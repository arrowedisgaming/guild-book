import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';
import { attachAdventurer, campaignIdFromUrl, createCampaignAndReadInvite, joinCampaign } from './fixtures/challenge';

/**
 * Increment 4 Task 7 — mobile behavior at 320 CSS pixels and the 200%-zoom
 * overflow rule: every procedure surface remains available, the table leads
 * (real DOM order, not CSS order), the drawers are keyboard-operable, the
 * private hand scrolls inside its own scroller, and there is no two-dimensional
 * page overflow outside that scroller.
 */

async function clickGeneric(page: Page, locator: Locator, timeoutMs = 15000): Promise<void> {
	const [response] = await Promise.all([
		page.waitForResponse(
			(res) => res.url().includes('/commands') && !res.url().match(/(challenge|guided-test|camp|finite|correction)-commands/),
			{ timeout: timeoutMs }
		),
		locator.click()
	]);
	if (!response.ok()) throw new Error(`generic command failed (HTTP ${response.status()})`);
}

test('the 320px table exposes procedure controls, leads with keyboard-operable drawers, and avoids horizontal overflow', async ({ browser }) => {
	test.setTimeout(180_000);

	const gm = await browser.newContext();
	const playerA = await browser.newContext({ viewport: { width: 320, height: 720 } });
	const gmPage = await gm.newPage();
	const playerAPage = await playerA.newPage();

	await signInAs(gmPage, 'Mobile GM');
	await signInAs(playerAPage, 'Mobile Player A');
	await createTestAdventurer(playerAPage, 'Pocket Vane');

	const invite = await createCampaignAndReadInvite(gmPage, 'Mobile Table');
	const campaignId = campaignIdFromUrl(gmPage.url());
	await joinCampaign(playerAPage, invite);
	await attachAdventurer(playerAPage, 'Pocket Vane');

	await gmPage.goto(`/campaigns/${campaignId}/table`);
	await gmPage.getByRole('button', { name: 'Start session' }).click();
	await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();
	await expect(gmPage.getByTestId('finite-panel-crawl')).toHaveCount(1);
	await expect(gmPage.getByTestId('finite-panel-cross-phase')).toHaveCount(1);
	await expect(gmPage.getByTestId('open-correction')).toHaveCount(1);

	await playerAPage.goto(`/campaigns/${campaignId}/table`);
	await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 15000 });
	await expect(playerAPage.getByTestId('finite-panel-crawl')).toHaveCount(1);
	await expect(playerAPage.getByTestId('finite-panel-cross-phase')).toHaveCount(1);
	await expect(playerAPage.getByTestId('open-correction')).toHaveCount(0);

	// Reload after setting the GM viewport so this exercises the component's
	// narrow-layout initialization path, independent of matchMedia change events.
	await gmPage.setViewportSize({ width: 320, height: 720 });
	await gmPage.reload();
	await expect(gmPage.getByTestId('mobile-drawers')).toBeAttached();
	await expect(gmPage.getByTestId('finite-panel-crawl')).toHaveCount(1);
	await expect(gmPage.getByTestId('finite-panel-cross-phase')).toHaveCount(1);
	await expect(gmPage.getByTestId('open-correction')).toHaveCount(1);

	// --- Table-first: the public table precedes the drawers in the real DOM ---
	// The "Draw a card" button being visible does not imply these two elements
	// have mounted — under machine load the gap is wide enough to lose. Wait for
	// the elements the order check actually reads before reading them.
	await expect(playerAPage.locator('[data-testid="public-table"]')).toBeAttached();
	await expect(playerAPage.locator('[data-testid="mobile-drawers"]')).toBeAttached();
	const order = await playerAPage.evaluate(() => {
		const table = document.querySelector('[data-testid="public-table"]');
		const drawers = document.querySelector('[data-testid="mobile-drawers"]');
		if (!table || !drawers) return 'missing';
		return table.compareDocumentPosition(drawers) & Node.DOCUMENT_POSITION_FOLLOWING ? 'table-first' : 'drawers-first';
	});
	expect(order).toBe('table-first');

	// --- Drawers are native disclosure widgets, keyboard-operable ---
	const firstSummary = playerAPage.locator('[data-testid="mobile-drawers"] summary').first();
	await firstSummary.focus();
	await playerAPage.keyboard.press('Enter');
	await expect(playerAPage.locator('[data-testid="mobile-drawers"] details').first()).toHaveAttribute('open', '');
	await playerAPage.keyboard.press('Enter');
	await expect(playerAPage.locator('[data-testid="mobile-drawers"] details').first()).not.toHaveAttribute('open', '');
	// Focus stayed on the summary throughout — the drawer returns focus by
	// never moving it.
	await expect(firstSummary).toBeFocused();

	// --- Draw several cards: the hand scrolls horizontally inside itself ---
	for (let i = 0; i < 4; i++) {
		await clickGeneric(playerAPage, playerAPage.getByRole('button', { name: 'Draw a card' }));
	}
	await expect(playerAPage.getByTestId('hand-card')).toHaveCount(4, { timeout: 15000 });

	// No two-dimensional page overflow at 320px: the document does not scroll
	// horizontally; any wide content scrolls inside its own container.
	const overflow = await playerAPage.evaluate(() => {
		const root = document.scrollingElement!;
		const amount = root.scrollWidth - root.clientWidth;
		const offenders: string[] = [];
		if (amount > 1) {
			for (const element of Array.from(document.querySelectorAll('*'))) {
				const rect = element.getBoundingClientRect();
				if (rect.right > root.clientWidth + 1) {
					offenders.push(`${element.tagName}.${(element as HTMLElement).className} right=${Math.round(rect.right)}`);
				}
			}
		}
		return { amount, offenders: offenders.slice(0, 10) };
	});
	if (overflow.amount > 1) console.log('OVERFLOW OFFENDERS:', overflow.offenders.join(' | '));
	expect(overflow.amount).toBeLessThanOrEqual(1);

	// --- The same rule at 200% zoom ---
	// 200% zoom is equivalent to halving the CSS viewport, so this reuses the
	// SAME signed-in member (a fresh context would be a different session) and
	// widens to 640 before doubling the page zoom — the effective CSS width is
	// 320 again, now with everything rendered twice as large.
	await playerAPage.setViewportSize({ width: 640, height: 720 });
	await playerAPage.evaluate(() => {
		(document.body.style as unknown as { zoom: string }).zoom = '2';
	});
	// Poll instead of a fixed 300 ms sleep: the reflow after the zoom change is
	// what the read depends on, so retry the read until layout settles.
	// NOTE (review of #16): "no overflow" is also the state BEFORE the zoom
	// takes effect, so a poll could in principle pass early on the pre-zoom
	// layout. It cannot here: reading `scrollWidth` forces a synchronous
	// layout, so the first read already sees the zoomed geometry. If this
	// read ever stops forcing layout (e.g. moves to a rAF or async observer),
	// this check needs a "zoom has applied" precondition first.
	await expect
		.poll(() =>
			playerAPage.evaluate(() => {
				const root = document.scrollingElement!;
				return root.scrollWidth - root.clientWidth;
			})
		)
		.toBeLessThanOrEqual(1);

	await gm.close();
	await playerA.close();
});
