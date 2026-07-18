import { describe, it, expect } from 'vitest';
import { saveDenizenSchema, MAX_DENIZEN_PAYLOAD_BYTES } from '$lib/schemas/denizen.schema';
import { validateSavedDenizen } from '$lib/server/validation/denizen';
import {
	createBlankDraft,
	seedFromTemplates,
	seedPersonFromTheme,
	updatePool,
	createBlankPoolDraft
} from '$lib/engine/denizen-builder';
import {
	getDenizenPersonRules,
	getDenizenThemes,
	getDenizenThreats,
	getTalents
} from '$lib/server/content/loader';

const theme = (id: string) => getDenizenThemes().find((t) => t.id === id)!;
const threat = (id: string) => getDenizenThreats().find((t) => t.id === id)!;

const bruteDraft = () =>
	seedFromTemplates({ ...createBlankDraft(), name: 'Locust Husk' }, theme('undead'), threat('brute'));

const lordDraft = () =>
	updatePool(
		seedFromTemplates({ ...createBlankDraft(), name: 'Gilded Horror' }, theme('sorcerous'), threat('dungeon-lord')),
		0,
		() => ({ ...createBlankPoolDraft(), name: 'The Crown', health: '6', defense: '3' })
	);

const personDraft = () =>
	seedPersonFromTheme(
		{ ...createBlankDraft(), name: 'Odo the Cannibal' },
		theme('man'),
		getDenizenPersonRules()
	);

describe('saveDenizenSchema', () => {
	it('accepts a real seeded draft', () => {
		expect(saveDenizenSchema.safeParse({ draft: bruteDraft() }).success).toBe(true);
		expect(saveDenizenSchema.safeParse({ draft: lordDraft() }).success).toBe(true);
		expect(saveDenizenSchema.safeParse({ draft: personDraft() }).success).toBe(true);
	});

	it('rejects garbage, wrong shapes, and unknown kinds', () => {
		expect(saveDenizenSchema.safeParse(null).success).toBe(false);
		expect(saveDenizenSchema.safeParse({}).success).toBe(false);
		expect(saveDenizenSchema.safeParse({ draft: 'nonsense' }).success).toBe(false);
		expect(saveDenizenSchema.safeParse({ draft: { ...bruteDraft(), kind: 'werewolf' } }).success).toBe(false);
		expect(
			saveDenizenSchema.safeParse({ draft: { ...bruteDraft(), notes: [{ name: 'x' }] } }).success
		).toBe(false);
	});

	it('caps the serialized payload size', () => {
		const oversized = {
			...bruteDraft(),
			flavor: 'x'.repeat(8000),
			specialRules: 'y'.repeat(8000),
			notes: Array.from({ length: 50 }, (_, i) => ({ name: `Note ${i}`, text: 'z'.repeat(4000) }))
		};
		expect(JSON.stringify(oversized).length).toBeGreaterThan(MAX_DENIZEN_PAYLOAD_BYTES);
		const result = saveDenizenSchema.safeParse({ draft: oversized });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((i) => i.message === 'Denizen is too large to save')).toBe(true);
		}
	});
});

describe('saveDenizenSchema — capacity', () => {
	it('accepts a maxed-out person (49 talents + kith, arete, wounds notes)', () => {
		const talents = getTalents();
		const notes = [
			{ name: 'Kith: Orcs', text: 'kith' },
			{ name: 'Arete talent: Jarl', text: 'arete' },
			{ name: 'Wounds', text: 'wounds' },
			...talents.map((t) => ({ name: `Talent: ${t.name}`, text: t.description }))
		];
		const draft = { ...personDraft(), notes };
		expect(notes.length).toBeGreaterThan(50); // the old cap would reject this
		expect(saveDenizenSchema.safeParse({ draft }).success).toBe(true);
	});
});

describe('validateSavedDenizen', () => {
	it('accepts complete creature, dungeon-lord, and person drafts', () => {
		expect(validateSavedDenizen(bruteDraft())).toEqual({ valid: true, errors: [] });
		expect(validateSavedDenizen(lordDraft())).toEqual({ valid: true, errors: [] });
		expect(validateSavedDenizen(personDraft())).toEqual({ valid: true, errors: [] });
	});

	it('rejects unresolvable template ids', () => {
		expect(validateSavedDenizen({ ...bruteDraft(), themeId: 'nonsense' }).valid).toBe(false);
		expect(validateSavedDenizen({ ...bruteDraft(), threatId: 'nonsense' }).valid).toBe(false);
		expect(validateSavedDenizen({ ...bruteDraft(), themeId: null }).valid).toBe(false);
	});

	it('validates person-kind against the loader, not the client flag', () => {
		// A person claiming a non-person theme is rejected server-side.
		const impostor = { ...personDraft(), themeId: 'undead' };
		const result = validateSavedDenizen(impostor);
		expect(result.valid).toBe(false);
		expect(result.errors.join(' ')).toMatch(/person-mode theme/);

		// A person with a threat id is rejected too.
		const armed = { ...personDraft(), threatId: 'brute' };
		expect(validateSavedDenizen(armed).valid).toBe(false);
	});

	it('applies the engine stat invariants', () => {
		expect(validateSavedDenizen({ ...bruteDraft(), health: '0' }).valid).toBe(false);
		expect(validateSavedDenizen({ ...bruteDraft(), defense: '' }).valid).toBe(false);
		// A pools-mode draft with no pools cannot be saved.
		expect(validateSavedDenizen({ ...lordDraft(), pools: [] }).valid).toBe(false);
	});
});
