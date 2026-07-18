import { expect, type Page } from '@playwright/test';

let identitySequence = 0;

export async function signInAs(page: Page, role: string): Promise<string> {
	identitySequence += 1;
	const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
	const email = `${slug}-${process.pid}-${identitySequence}@example.test`;
	await page.goto('/login?callbackUrl=/characters');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Name').fill(role);
	await page.getByRole('button', { name: 'Dev Sign In' }).click();
	await page.waitForURL('**/characters');
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	await expect
		.poll(() => page.evaluate(async () => (await fetch('/api/characters')).status))
		.toBe(200);
	return email;
}

export async function createTestAdventurer(
	page: Page,
	name: string,
	options: { draft?: boolean } = {}
): Promise<{ id: string; version: number }> {
	const character = testCharacter(name, options.draft ?? false);
	return page.evaluate(async (payload) => {
		const response = await fetch('/api/characters', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ character: payload })
		});
		if (!response.ok) throw new Error(await response.text());
		return response.json() as Promise<{ id: string; version: number }>;
	}, character);
}

export async function markTestAdventurerDead(
	page: Page,
	character: { id: string; version: number }
): Promise<void> {
	await page.evaluate(async ({ id, version }) => {
		const response = await fetch(`/api/characters/${id}/life`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'mark-dead', expectedVersion: version })
		});
		if (!response.ok) throw new Error(await response.text());
	}, character);
}

export async function archiveTestAdventurer(page: Page, characterId: string): Promise<void> {
	await page.evaluate(async (id) => {
		const response = await fetch(`/api/characters/${id}`, { method: 'DELETE' });
		if (!response.ok) throw new Error(await response.text());
	}, characterId);
}

function testCharacter(name: string, isDraft: boolean) {
	const attributes = {
		swords: { value: 3, sources: [] },
		pentacles: { value: 4, sources: [] },
		cups: { value: 2, sources: [] },
		wands: { value: 1, sources: [] }
	};
	return {
		schemaVersion: 3,
		system: 'hmtw',
		contentPackId: 'hmtw',
		name,
		pronouns: '',
		appearance: '',
		portraitUrl: '',
		kithId: 'human',
		kinId: 'human-noble-house',
		pathId: 'path-of-pentacles',
		attributes,
		talents: [],
		quest: '',
		motifs: [],
		bonds: [],
		life: { status: 'alive' },
		resolve: { current: 4, max: 4 },
		arete: { triggersMet: [false, false, false], talentEarned: false },
		languages: [],
		conditions: [],
		afflictions: [],
		lore: 4,
		experience: 0,
		equipment: [],
		notes: '',
		isDraft,
		wizardStep: isDraft ? 1 : 8
	};
}
