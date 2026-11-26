import { expect, test } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';

test('custom spell components survive save and reload as gear', async ({ page }) => {
 await signInAs(page, 'Components');
 const { id } = await createTestAdventurer(page, 'Keeper of Ash');
 await page.goto(`/sheet/${id}`);
 await page.getByText('Add a spell component', { exact: true }).click();
 await page.getByLabel('Component description', { exact: true }).fill('Ash from the drowned chapel');
 await page.getByLabel('Custom spell name', { exact: true }).fill('Chapel ward');
 await page.getByRole('button', { name: 'Add spell component', exact: true }).click();
 await expect(page.locator('.save-state')).toHaveText('Saved');
 await page.reload();
 const gear = page.getByRole('region', { name: 'Gear', exact: true });
 await expect(gear.getByText('Ash from the drowned chapel', { exact: false })).toBeVisible();
 await expect(gear.getByText('Chapel ward', { exact: false })).toBeVisible();
});

test('book components can be customized and undone on a narrow screen', async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });
 await signInAs(page, 'Mobile Components');
 const { id } = await createTestAdventurer(page, 'Pocket Sorcerer');
 await page.goto(`/sheet/${id}`);
 const components = page.getByRole('region', { name: 'Spell components' });
 await components.getByText('Add a spell component', { exact: true }).click();
 await components.getByLabel('Spell', { exact: true }).first().fill('brainf');
 await components.getByRole('option', { name: /^Brainfever/ }).click();
 await expect(components.getByLabel('Component description', { exact: true })).toHaveValue(/marjoram/);
 await components.getByLabel('Component description', { exact: true }).fill('Ash and powdered thyme in a linen pouch');
 await components.getByRole('button', { name: 'Add spell component', exact: true }).click();
 await expect(page.getByText('Ash and powdered thyme in a linen pouch').first()).toBeVisible();
 await page.getByRole('button', { name: 'Undo last change', exact: true }).click();
 await expect(page.getByText('Ash and powdered thyme in a linen pouch')).toHaveCount(0);
 await expect(page.locator('.save-state')).toHaveText('Saved');
 await page.reload();
 await expect(page.getByText('Ash and powdered thyme in a linen pouch')).toHaveCount(0);
 await components.getByText('Add a spell component', { exact: true }).click();
 await components.getByLabel('Spell', { exact: true }).first().fill('brainf');
 await components.getByRole('option', { name: /^Brainfever/ }).click();
 await components.getByRole('button', { name: 'Add spell component', exact: true }).click();
 await expect(page.locator('.save-state')).toHaveText('Saved');
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
 await page.screenshot({ path: '/tmp/guildbook-character-mobile.png', fullPage: true });
});
