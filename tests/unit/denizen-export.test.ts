import { describe, it, expect } from 'vitest';
import { exportDenizenToMarkdown } from '$lib/export/denizen-markdown-export';
import { buildDenizenDocDefinition } from '$lib/export/denizen-pdf-export';
import { getBestiary } from '$lib/server/content/loader';

const byId = Object.fromEntries(getBestiary().map((d) => [d.id, d]));

describe('denizen markdown export', () => {
	it('produces frontmatter, stat line, and doom sections for a simple creature', () => {
		const md = exportDenizenToMarkdown(byId['skeleton'], 'Undead', 'Brute');
		expect(md).toContain('name: Skeleton');
		expect(md).toContain('# Skeleton');
		expect(md).toContain('_Undead Brute_');
		expect(md).toContain('**Attributes:** Swords 6 | Pentacles 1 | Cups 1 | Wands 4');
		expect(md).toContain('**Health/Defense:** 6/0');
		expect(md).toContain('### Lesser dooms');
		expect(md).toContain('- **Unearthly Fear.**');
	});

	it('renders dungeon-lord pools as their own sections', () => {
		const md = exportDenizenToMarkdown(byId['lich-yellow-king'], 'Undead', 'Dungeon Lord');
		expect(md).toContain('## Phylactery — Health/Defense: 1/0');
		expect(md).toContain('## Body — Health/Defense: 5/9');
		expect(md).not.toContain('**Health/Defense:** undefined');
	});

	it('renders sidebars as callouts', () => {
		const md = exportDenizenToMarkdown(byId['vampire'], 'Undead', 'Elite');
		expect(md).toContain('> [!sidebar] Killing the Vampire');
	});
});

describe('denizen PDF export', () => {
	it('builds a doc definition without loading pdfmake', () => {
		const doc = buildDenizenDocDefinition(byId['skeleton'], 'Undead', 'Brute');
		const flattened = JSON.stringify(doc);
		expect(flattened).toContain('Skeleton');
		expect(flattened).toContain('Undead Brute');
		expect(flattened).toContain('LESSER DOOMS');
		expect(flattened).toContain('independent production');
	});

	it('strips markdown markers from ability text', () => {
		const doc = buildDenizenDocDefinition(byId['skeleton'], 'Undead', 'Brute');
		const flattened = JSON.stringify(doc);
		expect(flattened).not.toContain('*exceed*');
		expect(flattened).toContain('exceed');
	});

	it('renders pools and sidebars for dungeon lords', () => {
		const doc = buildDenizenDocDefinition(byId['titan-sporehulk'], 'Elemental', 'Dungeon Lord');
		const flattened = JSON.stringify(doc);
		expect(flattened).toContain('LEGS — HD 4/0');
		expect(flattened).toContain('TORSO — HD 5/10');
	});
});
