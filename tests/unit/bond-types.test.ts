import { describe, expect, it } from 'vitest';
import { getBondTypes, loadWizardData } from '$lib/server/content/loader';

describe('bond types collection', () => {
	it('loads the 11 book bond types with unique ids, Ally first', () => {
		const types = getBondTypes();
		expect(types).toHaveLength(11);
		expect(types[0]).toMatchObject({ id: 'ally', label: 'Ally' });
		expect(new Set(types.map((t) => t.id)).size).toBe(types.length);
		for (const t of types) {
			expect(t.description.length).toBeGreaterThan(0);
			expect(t.charge.length).toBeGreaterThan(0);
		}
	});

	it('ships bond types in the wizard data bundle', () => {
		expect(loadWizardData().bondTypes).toHaveLength(11);
	});
});
