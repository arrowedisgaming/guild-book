import { test, expect } from '@playwright/test';

test.describe('denizen reference', () => {
	test('index lists the bestiary and filters by theme and threat', async ({ page }) => {
		await page.goto('/denizens');
		await expect(page.getByRole('heading', { name: 'Dungeon Denizens', level: 1 })).toBeVisible();
		await expect(page.getByRole('link', { name: /Skeleton/ })).toBeVisible();
		await expect(page.getByRole('link', { name: /Dragon/ })).toBeVisible();

		// Filter to Undead: beasts disappear, undead remain.
		await page.getByRole('group', { name: 'Filter by theme' }).getByRole('button', { name: 'Undead' }).click();
		await expect(page.getByRole('link', { name: /Dragon/ })).toHaveCount(0);
		await expect(page.getByRole('link', { name: /Skeleton/ })).toBeVisible();

		// Add the Minion threat: only the zombie remains of the undead.
		await page.getByRole('group', { name: 'Filter by threat' }).getByRole('button', { name: 'Minion' }).click();
		await expect(page.getByRole('link', { name: /Skeleton/ })).toHaveCount(0);
		await expect(page.getByRole('link', { name: /Zombie/ })).toBeVisible();
	});

	test('search narrows by name', async ({ page }) => {
		await page.goto('/denizens');
		await page.getByRole('searchbox').fill('mimic');
		await expect(page.getByRole('link', { name: /Mimic/ })).toBeVisible();
		await expect(page.getByRole('link', { name: /Skeleton/ })).toHaveCount(0);
	});

	test('detail renders the skeleton stat block', async ({ page }) => {
		await page.goto('/denizens/skeleton');
		await expect(page.getByRole('heading', { name: 'Skeleton', level: 1 })).toBeVisible();
		await expect(page.getByText('Undead Brute')).toBeVisible();
		await expect(page.getByText('Swords 6 | Pentacles 1 | Cups 1 | Wands 4')).toBeVisible();
		await expect(page.getByText('Unearthly Fear.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Copy Markdown' })).toBeVisible();
	});

	test('detail renders a dungeon lord with pools and sidebar', async ({ page }) => {
		await page.goto('/denizens/lich-yellow-king');
		await expect(page.getByRole('heading', { name: /Phylactery — Health\/Defense: 1\/0/ })).toBeVisible();
		await expect(page.getByRole('heading', { name: /Body — Health\/Defense: 5\/9/ })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Lyric incantations' })).toBeVisible();
	});

	test('unknown denizen 404s', async ({ page }) => {
		const response = await page.goto('/denizens/nonsense');
		expect(response?.status()).toBe(404);
	});
});

test.describe('denizen builder', () => {
	test('builds a monster end to end', async ({ page }) => {
		await page.goto('/denizens/build');
		await expect(page.getByRole('heading', { name: 'Concept', level: 2 })).toBeVisible();

		await page.getByLabel('Name').fill('Locust Husk');
		await page.getByLabel('Classic monster it starts from').fill('A zombie');
		await page.getByLabel('The one exaggerated aspect').fill("it's animated by a swarm of locusts");
		await page.getByRole('button', { name: 'Next →' }).click();

		// Theme
		await expect(page.getByRole('heading', { name: 'Theme', level: 2 })).toBeVisible();
		await page.getByRole('radio', { name: 'Undead' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();

		// Threat
		await expect(page.getByRole('heading', { name: 'Threat', level: 2 })).toBeVisible();
		await page.getByRole('radio', { name: 'Brute' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();

		// Customize — seeded from Undead Brute.
		await expect(page.getByRole('heading', { name: 'Customize', level: 2 })).toBeVisible();
		await expect(page.getByLabel('Swords')).toHaveValue('6');
		await expect(page.getByLabel('Health')).toHaveValue('2');
		await page.getByLabel('Health').fill('4');
		await page.getByRole('button', { name: 'Next →' }).click();

		// Dooms — take Fear from the theme, Deadly Attack from the threat, add a custom one.
		await expect(page.getByRole('heading', { name: 'Dooms', level: 2 })).toBeVisible();
		await page.getByRole('checkbox', { name: /Fear\./ }).check();
		await page.getByRole('checkbox', { name: /Deadly Attack\./ }).check();
		await page.getByPlaceholder('Doom name').fill('Locust Cloud');
		await page.getByPlaceholder('What it does').fill('Play a greater doom card to bite everyone in the zone.');
		await page.getByRole('button', { name: 'Add as greater doom' }).click();

		// "Your dooms" is split into Lesser and Greater; the custom doom lands under Greater.
		const lesserSection = page.locator('ul.current').first();
		await expect(page.getByRole('heading', { name: 'Lesser', level: 4 })).toBeVisible();
		await expect(lesserSection.getByText('Fear.')).toBeVisible();
		const greaterList = page
			.getByRole('heading', { name: 'Greater', level: 4 })
			.locator('~ ul.current')
			.first();
		await expect(greaterList.getByText('Locust Cloud.')).toBeVisible();

		// Edit the custom doom in place.
		const locustRow = greaterList.locator('li', { hasText: 'Locust Cloud' });
		await locustRow.getByRole('button', { name: 'Edit' }).click();
		await page.getByLabel('Ability text').fill('Play a greater doom card to blind everyone in the zone.');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(greaterList.getByText(/blind everyone in the zone/)).toBeVisible();
		await page.getByRole('button', { name: 'Next →' }).click();

		// Review
		await expect(page.getByRole('heading', { name: 'Review', level: 2 })).toBeVisible();
		const preview = page.locator('.preview');
		await expect(preview.getByRole('heading', { name: 'Locust Husk' })).toBeVisible();
		await expect(preview.getByText('Undead Brute')).toBeVisible();
		await expect(preview.getByText('Swords 6 | Pentacles 4 | Cups 1 | Wands 1')).toBeVisible();
		await expect(preview.getByText('Health/Defense: 4/6')).toBeVisible();
		await expect(preview.getByText('Fear.')).toBeVisible();
		await expect(preview.getByText('Locust Cloud.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Copy Markdown' })).toBeVisible();
	});

	test('elite notes are called out as optional and can be edited or removed', async ({ page }) => {
		await page.goto('/denizens/build');
		await page.getByRole('button', { name: 'Next →' }).click();
		await page.getByRole('radio', { name: 'Elemental' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();
		await page.getByRole('radio', { name: 'Elite' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();

		// The elite threat flags its notes optional; the builder surfaces that.
		await expect(page.getByRole('heading', { name: 'Customize', level: 2 })).toBeVisible();
		await expect(page.getByText('a menu, not a package')).toBeVisible();

		// Pin the elemental immunity down to a specific element via Edit.
		const immunityRow = page.locator('ul.current li', { hasText: 'Elemental Immunity' });
		await immunityRow.getByRole('button', { name: 'Edit' }).click();
		await page.getByLabel('Ability text').fill('The huldra takes no damage from water. It cannot drown.');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('It cannot drown.')).toBeVisible();

		// Unwanted optional notes can simply be removed.
		const thresholdRow = page.locator('ul.current li', { hasText: 'Threshold' });
		await thresholdRow.getByRole('button', { name: 'Remove' }).click();
		await expect(page.locator('ul.current li', { hasText: 'Threshold' })).toHaveCount(0);
	});

	test('draft survives a reload', async ({ page }) => {
		await page.goto('/denizens/build');
		await page.getByLabel('Name').fill('Persistent Horror');
		await page.reload();
		await expect(page.getByLabel('Name')).toHaveValue('Persistent Horror');
	});
});
