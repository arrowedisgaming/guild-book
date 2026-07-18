import { describe, expect, it } from 'vitest';
import {
	buildCharacterViewFromContent,
	type CharacterViewContent
} from '$lib/character/view';
import { exportToMarkdown } from '$lib/export/markdown-export';
import { buildDocDefinition } from '$lib/export/pdf-export';
import { createBlankCharacter } from '$lib/types/character';
import { load as loadCharacterBuilder } from '../../src/routes/create/hmtw/+layout.server';
import { load as loadDenizenBuilder } from '../../src/routes/denizens/build/+page.server';

describe('anonymous creation tools', () => {
	it('loads the complete adventurer builder without a session', async () => {
		const data = await loadCharacterBuilder({} as never);
		expect(data).toBeDefined();
		if (!data) throw new Error('Character builder returned no data');
		expect(data).toMatchObject({ contentPack: { id: 'hmtw' } });

		const draft = createBlankCharacter();
		draft.name = 'Anonymous Knight';
		const view = buildCharacterViewFromContent(draft, data as unknown as CharacterViewContent);
		expect(exportToMarkdown(view)).toContain('Anonymous Knight');
		expect(buildDocDefinition(view)).toMatchObject({ content: expect.any(Array) });
	});

	it('loads denizen templates without a session', async () => {
		const data = await loadDenizenBuilder({} as never);
		expect(data).toBeDefined();
		if (!data) throw new Error('Denizen builder returned no data');
		expect(data.themes.length).toBeGreaterThan(0);
		expect(data.threats.length).toBeGreaterThan(0);
	});
});
