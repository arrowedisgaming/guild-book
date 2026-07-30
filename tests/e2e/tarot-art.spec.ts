import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';

/**
 * Issue #10 Task 4: the Archival Frame. Face-up cards render the complete,
 * uncropped scan through a responsive `<picture>` (AVIF+WebP), with a slim
 * label footer and an enlargement dialog; face-down cards render the themed
 * Adherent back, contrast-paired to the active theme. Checked on the /deck
 * playground, which renders the same `TarotCard` component the campaign
 * table uses, without needing a multi-client session.
 */

test.describe('tarot artwork rendering', () => {
	test('face-up cards render uncropped responsive art with label and enlargement dialog', async ({ page }) => {
		await signInAs(page, 'Art Viewer');
		await page.goto('/deck');

		// The draw pile is a face-down card carrying BOTH themed Adherent
		// backs, identity-free; pairing is by CONTRAST — the default
		// parchment-light theme shows the DARK treatment so face-down cards
		// pop against the light page.
		const back = page.getByRole('img', { name: 'Face-down card' }).first();
		await expect(back).toBeVisible();
		const lightSrcset = await back.locator('.back-light source[type="image/avif"]').getAttribute('srcset');
		expect(lightSrcset).toContain('/tarot/rwsa/backs/adherent-parchment-240.avif 240w');
		const darkSrcset = await back.locator('.back-dark source[type="image/avif"]').getAttribute('srcset');
		expect(darkSrcset).toContain('/tarot/rwsa/backs/adherent-dark-240.avif 240w');
		await expect(back.locator('.back-dark')).toBeVisible();
		await expect(back.locator('.back-light')).toBeHidden();

		// Flip the theme attribute: the parchment treatment takes over without
		// a reload, tracking data-theme exactly like the rest of the app.
		await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'worm-dark'));
		await expect(back.locator('.back-light')).toBeVisible();
		await expect(back.locator('.back-dark')).toBeHidden();
		await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'parchment-light'));

		// Draw a card face up.
		await page.getByRole('button', { name: /draw/i }).first().click();
		const card = page.locator('[data-card-id]').first();
		await expect(card).toBeVisible();
		const cardId = await card.getAttribute('data-card-id');
		const label = await card.getAttribute('aria-label');
		expect(cardId).toBeTruthy();
		expect(label).toBeTruthy();

		// Responsive picture: AVIF and WebP srcsets over the measured tiers.
		const avif = card.locator('source[type="image/avif"]');
		await expect(avif).toHaveAttribute('srcset', new RegExp(`/tarot/rwsa/faces/${cardId}-240\\.avif 240w`));
		await expect(avif).toHaveAttribute('srcset', /960\.avif 960w/);
		const webp = card.locator('source[type="image/webp"]');
		await expect(webp).toHaveAttribute('srcset', new RegExp(`/tarot/rwsa/faces/${cardId}-240\\.webp 240w`));

		// Uncropped by construction: `object-fit: contain`, intrinsic
		// dimensions declared, and the rendered box preserves the scan's
		// portrait ratio rather than cropping to a fixed frame.
		const img = card.locator('img');
		await expect(img).toHaveJSProperty('complete', true);
		expect(await img.evaluate((el) => getComputedStyle(el).objectFit)).toBe('contain');
		const [width, height] = await Promise.all([img.getAttribute('width'), img.getAttribute('height')]);
		expect(Number(width)).toBeGreaterThan(0);
		expect(Number(height)).toBeGreaterThan(Number(width));

		// Slim label footer inside the frame, matching the accessible name.
		await expect(card.locator('.label')).toHaveText(label as string);

		// Enlargement: a real button, a real dialog, the 960 tier, and focus
		// returned to the trigger on close.
		const enlarge = page.getByRole('button', { name: `Enlarge ${label}` }).first();
		await expect(enlarge).toBeVisible();
		await enlarge.click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('source[type="image/avif"]')).toHaveAttribute('srcset', /960\.avif 960w/);
		await dialog.getByRole('button', { name: /close/i }).click();
		await expect(dialog).not.toBeVisible();
		await expect(enlarge).toBeFocused();
	});
});
