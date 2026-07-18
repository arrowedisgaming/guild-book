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

	test('exports really produce files and clipboard content', async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/denizens/skeleton');

		// Markdown download carries the stat block.
		const mdDownload = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download .md' }).click();
		expect((await mdDownload).suggestedFilename()).toBe('skeleton.md');

		// Clipboard copy puts the same Markdown on the clipboard.
		await page.getByRole('button', { name: 'Copy Markdown' }).click();
		await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toContain('## Skeleton');
		expect(clipboard).toContain('**Health/Defense:** 6/0');

		// PDF generation fetches fonts and triggers a download.
		const pdfDownload = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download PDF' }).click();
		expect((await pdfDownload).suggestedFilename()).toBe('skeleton.pdf');
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

	test('person and pool templates are buildable with guidance', async ({ page }) => {
		await page.goto('/denizens/build');
		await page.getByRole('button', { name: 'Next →' }).click();

		// The Man theme is selectable and carries the book's guidance.
		await expect(page.getByRole('heading', { name: 'Theme', level: 2 })).toBeVisible();
		// Match the card by its exact name — hasText is a case-insensitive
		// substring match, and other cards' prose contains "man".
		const exactMan = page.locator('.pick-name', { hasText: /^Man$/ });
		await expect(page.locator('.pick-card.unavailable', { has: exactMan })).toHaveCount(0);
		const manCard = page.locator('.pick-card', { has: exactMan });
		await expect(manCard.getByRole('radio')).toHaveCount(1);
		await expect(manCard.getByText('making actual characters')).toBeVisible();

		await page.getByRole('radio', { name: 'Undead' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();

		// Dungeon lords are pool-based and fully supported by the Pools step.
		await expect(page.getByRole('heading', { name: 'Threat', level: 2 })).toBeVisible();
		await expect(page.locator('.pick-card.unavailable', { hasText: 'Dungeon Lord' })).toHaveCount(
			0
		);
		await expect(page.getByRole('radio', { name: /Dungeon Lord/ })).toBeVisible();
	});

	test('builds a person adversary end to end', async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/denizens/build');

		await page.getByLabel('Name').fill('Odo the Cannibal');
		await page.getByLabel('Classic monster it starts from').fill('A hermit');
		await page.getByLabel('The one exaggerated aspect').fill('his hunger never stops');
		await page.getByRole('button', { name: 'Next →' }).click();

		// Choosing Man swaps the path: Threat is replaced by a Person step.
		await page.getByRole('radio', { name: /Man/ }).check();
		await page.getByRole('button', { name: 'Next →' }).click();
		await expect(page.getByRole('heading', { name: 'Person', level: 2 })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Threat' })).toHaveCount(0);

		// Spread assignment swaps values instead of duplicating them — no warning.
		await page.getByLabel('Cups spread value').selectOption('4');
		await expect(page.getByLabel('Swords spread value')).toHaveValue('2');
		await expect(page.locator('.warning')).toHaveCount(0);

		// Kith is flavour, recorded as a note; a kin adds its arete talent,
		// previewed right below the pick so the GM can judge it.
		await page.getByRole('radio', { name: 'Orcs' }).check();
		await page.getByLabel('Kin', { exact: true }).selectOption({ index: 1 });
		await expect(page.locator('.arete-preview')).toBeVisible();

		// Talents: the highest attribute's path (Cups) is open; pick the first.
		await expect(page.getByRole('heading', { name: /their path/ })).toBeVisible();
		await page.locator('ul.options input[type=checkbox]').first().check();
		await page.getByRole('button', { name: 'Next →' }).click();

		// Customize: person wording, HD pre-filled for simplicity (5/1), and the
		// wound-tracking option toggles a * Health with the Wounds note.
		await expect(page.getByRole('heading', { name: 'Customize', level: 2 })).toBeVisible();
		await expect(page.getByText('pre-filled for simplicity')).toBeVisible();
		await expect(page.getByLabel('Health', { exact: true })).toHaveValue('5');
		await expect(page.getByLabel('Defense', { exact: true })).toHaveValue('1');

		const woundsToggle = page.getByRole('checkbox', { name: /Track Wounds/ });
		await woundsToggle.check();
		await expect(page.getByLabel('Health', { exact: true })).toHaveValue('*');
		await expect(page.locator('ul.current li', { hasText: 'Wounds.' })).toBeVisible();
		await woundsToggle.uncheck();
		await expect(page.getByLabel('Health', { exact: true })).toHaveValue('5');
		await expect(page.locator('ul.current li', { hasText: 'Wounds.' })).toHaveCount(0);

		await page.getByLabel('Health', { exact: true }).fill('6');
		await page.getByLabel('Defense', { exact: true }).fill('2');
		await expect(page.locator('ul.current li', { hasText: 'Kith: Orcs' })).toBeVisible();
		await expect(page.locator('ul.current li', { hasText: 'Arete talent:' })).toBeVisible();
		await expect(page.locator('ul.current li', { hasText: 'Talent:' }).first()).toBeVisible();
		await page.getByRole('button', { name: 'Next →' }).click();

		// Dooms: no template pick-lists, straight to gimmick dooms.
		await expect(page.getByRole('heading', { name: 'Dooms', level: 2 })).toBeVisible();
		await expect(page.getByText('core gimmick')).toBeVisible();
		await expect(page.getByRole('checkbox')).toHaveCount(0);
		await page.getByPlaceholder('Doom name').fill('Hunger Beyond Reason');
		await page.getByPlaceholder('What it does').fill('Play a greater doom card to bite and hold.');
		await page.getByRole('button', { name: 'Add as greater doom' }).click();
		await page.getByRole('button', { name: 'Next →' }).click();

		// Review: no threat in the type line; kith and talent notes carry over.
		await expect(page.getByRole('heading', { name: 'Review', level: 2 })).toBeVisible();
		const preview = page.locator('.preview');
		await expect(preview.getByRole('heading', { name: 'Odo the Cannibal' })).toBeVisible();
		await expect(preview.getByText('Kith: Orcs.')).toBeVisible();
		await expect(preview.getByText('Arete talent:')).toBeVisible();
		await expect(preview.getByText('Health/Defense: 6/2')).toBeVisible();

		// The Markdown export drops the threat entirely.
		await page.getByRole('button', { name: 'Copy Markdown' }).click();
		await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toContain('_Man_');
		expect(clipboard).not.toContain('threat:');
		expect(clipboard).toContain('- **Kith: Orcs.**');
		expect(clipboard).toContain('- **Hunger Beyond Reason.**');
	});

	test('switching modes stashes and restores work on both sides', async ({ page }) => {
		await page.goto('/denizens/build');
		await page.getByRole('button', { name: 'Next →' }).click();

		// Person side: pick Man and a kith.
		await page.getByRole('radio', { name: /Man/ }).check();
		await page.getByRole('button', { name: 'Next →' }).click();
		await expect(page.getByRole('heading', { name: 'Person', level: 2 })).toBeVisible();
		await page.getByRole('radio', { name: 'Orcs' }).check();

		// Creature side: switch to Undead Brute and customize Health.
		await page.getByRole('button', { name: 'Theme' }).click();
		await page.getByRole('radio', { name: 'Undead' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();
		await expect(page.getByRole('heading', { name: 'Threat', level: 2 })).toBeVisible();
		await page.getByRole('radio', { name: 'Brute' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();
		await page.getByLabel('Health', { exact: true }).fill('4');

		// Back to Man: the kith choice survived the round trip.
		await page.getByRole('button', { name: 'Theme' }).click();
		await page.getByRole('radio', { name: /Man/ }).check();
		await page.getByRole('button', { name: 'Next →' }).click();
		await expect(page.getByRole('heading', { name: 'Person', level: 2 })).toBeVisible();
		await expect(page.getByRole('radio', { name: 'Orcs' })).toBeChecked();

		// And back to Undead: the customized Health survived too.
		await page.getByRole('button', { name: 'Theme' }).click();
		await page.getByRole('radio', { name: 'Undead' }).check();
		await page.getByRole('button', { name: 'Customize' }).click();
		await expect(page.getByLabel('Health', { exact: true })).toHaveValue('4');

		// Flipping to a different creature template and back keeps it as well.
		await page.getByRole('button', { name: 'Theme' }).click();
		await page.getByRole('radio', { name: 'Sorcerous' }).check();
		await page.getByRole('button', { name: 'Threat' }).click();
		await page.getByRole('radio', { name: 'Elite' }).check();
		await page.getByRole('button', { name: 'Customize' }).click();
		await expect(page.getByLabel('Health', { exact: true })).not.toHaveValue('4'); // reseeded pair

		await page.getByRole('button', { name: 'Theme' }).click();
		await page.getByRole('radio', { name: 'Undead' }).check();
		await page.getByRole('button', { name: 'Threat' }).click();
		await page.getByRole('radio', { name: 'Brute' }).check();
		await page.getByRole('button', { name: 'Customize' }).click();
		await expect(page.getByLabel('Health', { exact: true })).toHaveValue('4');
	});

	test('stat inputs warn on a starting Health of 0', async ({ page }) => {
		await page.goto('/denizens/build');
		await page.getByRole('button', { name: 'Next →' }).click();
		await page.getByRole('radio', { name: 'Undead' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();
		await page.getByRole('radio', { name: 'Brute' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();

		await expect(page.getByRole('heading', { name: 'Customize', level: 2 })).toBeVisible();
		await page.getByLabel('Health').fill('0');
		await expect(page.getByText('Starting Health cannot be 0')).toBeVisible();
		await page.getByLabel('Health').fill('4');
		await expect(page.getByText('Starting Health cannot be 0')).toHaveCount(0);
	});

	test('draft survives a reload', async ({ page }) => {
		await page.goto('/denizens/build');
		await page.getByLabel('Name').fill('Persistent Horror');
		await page.reload();
		await expect(page.getByLabel('Name')).toHaveValue('Persistent Horror');
	});

	test('builds a dungeon lord with pools end to end', async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/denizens/build');

		await page.getByLabel('Name').fill('Gilded Horror');
		await page.getByRole('button', { name: 'Next →' }).click();
		await page.getByRole('radio', { name: 'Sorcerous' }).check();
		await page.getByRole('button', { name: 'Next →' }).click();
		await page.getByRole('radio', { name: /Dungeon Lord/ }).check();
		await page.getByRole('button', { name: 'Next →' }).click();

		// Customize: pool threats have no top-level HD; special rules instead.
		await expect(page.getByRole('heading', { name: 'Customize', level: 2 })).toBeVisible();
		await expect(page.getByLabel('Health', { exact: true })).toHaveCount(0);
		await expect(page.getByText("you'll build them on the Pools step")).toBeVisible();
		await page
			.getByLabel(/Special rules/)
			.fill('The horror regrows a defeated pool at dawn.');
		await page.getByRole('button', { name: 'Next →' }).click();

		// Pools: the path inserts a Pools step; one blank pool is seeded.
		await expect(page.getByRole('heading', { name: 'Pools', level: 2 })).toBeVisible();
		await expect(page.getByText('every pool needs both Health and Defense')).toBeVisible();
		await page.getByLabel('Pool 1 name').fill('The Crown');
		await page.getByLabel('Pool 1 Health').fill('6');
		await page.getByLabel('Pool 1 Defense').fill('3');
		await page.getByLabel('Pool 1 description').fill('Shattering the crown breaks its dominion.');
		await page.getByLabel('Pool 1 new ability name').fill('Crownfall');
		await page.getByLabel('Pool 1 new ability text').fill('The crown cracks; its court flees.');
		await page.getByRole('button', { name: 'Add lesser doom' }).click();

		await page.getByRole('button', { name: '+ Add pool' }).click();
		await page.getByLabel('Pool 2 name').fill('The Roots');
		await page.getByLabel('Pool 2 Health').fill('4');
		await page.getByLabel('Pool 2 Defense').fill('1');
		await page.getByLabel('Pool 2 new ability name').fill('Strangling Growth');
		await page.getByLabel('Pool 2 new ability text').fill('Play a greater doom to root a zone.');
		await page.getByRole('button', { name: 'Add greater doom' }).nth(1).click();
		await expect(page.getByText('every pool needs both Health and Defense')).toHaveCount(0);
		await page.getByRole('button', { name: 'Next →' }).click();

		// Dooms: pool guidance shown; dooms here apply regardless of pool.
		await expect(page.getByRole('heading', { name: 'Dooms', level: 2 })).toBeVisible();
		await expect(page.getByText(/dooms live on its pools/)).toBeVisible();
		await page.getByRole('button', { name: 'Next →' }).click();

		// Review: the preview shows both pools with their HD and dooms.
		await expect(page.getByRole('heading', { name: 'Review', level: 2 })).toBeVisible();
		const preview = page.locator('.preview');
		await expect(preview.getByText('The Crown — Health/Defense: 6/3')).toBeVisible();
		await expect(preview.getByText('The Roots — Health/Defense: 4/1')).toBeVisible();
		await expect(preview.getByText('Crownfall.')).toBeVisible();
		await expect(preview.getByText('The horror regrows a defeated pool at dawn.')).toBeVisible();

		// The real Markdown export carries the pools.
		await page.getByRole('button', { name: 'Copy Markdown' }).click();
		await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toContain('### The Crown — Health/Defense: 6/3');
		expect(clipboard).toContain('### The Roots — Health/Defense: 4/1');
		expect(clipboard).toContain('- **Strangling Growth.**');
		expect(clipboard).toContain('#### Special rules');
		expect(clipboard).not.toContain('Health/Defense: /');

		const mdDownload = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download .md' }).click();
		expect((await mdDownload).suggestedFilename()).toBe('gilded-horror.md');

		// PDF generation fetches fonts and triggers a download.
		const pdfDownload = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download PDF' }).click();
		expect((await pdfDownload).suggestedFilename()).toBe('gilded-horror.pdf');
	});
});
