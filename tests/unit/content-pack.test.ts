import { describe, it, expect } from 'vitest';
import {
	getContentPack,
	getKiths,
	getPaths,
	getTalents,
	getItems,
	getMotifs,
	loadWizardData
} from '$lib/server/content/loader';
import { SUIT_IDS } from '$lib/types/common';

describe('content pack — schema round-trip', () => {
	it('validates the manifest and exposes the four suit-attributes', () => {
		const pack = getContentPack();
		expect(pack.system).toBe('hmtw');
		expect(pack.attributes.map((a) => a.id).sort()).toEqual([...SUIT_IDS].sort());
	});

	it('loads every collection without throwing', () => {
		expect(() => loadWizardData()).not.toThrow();
	});
});

describe('content pack — tarot config', () => {
	const pack = getContentPack();

	it('has 14 minor-arcana ranks with the correct court values', () => {
		const { ranks } = pack.tarot;
		expect(ranks).toHaveLength(14);
		const byId = Object.fromEntries(ranks.map((r) => [r.id, r.numeric]));
		expect(byId.i).toBe(1);
		expect(byId.x).toBe(10);
		expect(byId.page).toBe(11);
		expect(byId.knight).toBe(12);
		expect(byId.queen).toBe(13);
		expect(byId.king).toBe(14);
		expect(ranks.filter((r) => r.court)).toHaveLength(4);
	});

	it('has 22 major arcana including the Fool at 0', () => {
		expect(pack.tarot.majorArcana).toHaveLength(22);
		const fool = pack.tarot.majorArcana.find((c) => c.id === 'fool');
		expect(fool?.number).toBe(0);
	});

	it('resolves a test of fate at 14+', () => {
		expect(pack.tarot.resolution.successThreshold).toBe(14);
		// Knight of Wands (12) + Pentacles 2 = 14 → a success, per the rulebook example.
		expect(12 + 2).toBeGreaterThanOrEqual(pack.tarot.resolution.successThreshold);
	});
});

describe('content pack — creation rules', () => {
	it('uses the 4/3/2/1 spread with the highest fixed to the path', () => {
		const { creation } = getContentPack();
		expect([...creation.attributeSpread].sort((a, b) => b - a)).toEqual([4, 3, 2, 1]);
		expect(creation.highestAttributeFromPath).toBe(true);
	});
});

describe('content pack — referential integrity', () => {
	const kiths = getKiths();
	const paths = getPaths();
	const talents = getTalents();
	const items = getItems();
	const talentIds = new Set(talents.map((t) => t.id));
	const itemIds = new Set(items.map((i) => i.id));

	it('every kin references talents that exist', () => {
		for (const kith of kiths) {
			for (const kin of kith.kins) {
				expect(talentIds.has(kin.masteredTalentId)).toBe(true);
				if (kin.areteTalentId) expect(talentIds.has(kin.areteTalentId)).toBe(true);
			}
		}
	});

	it('every path binds to a real suit and references talents that exist', () => {
		for (const path of paths) {
			expect((SUIT_IDS as readonly string[]).includes(path.suit)).toBe(true);
			for (const id of path.talentIds) expect(talentIds.has(id)).toBe(true);
		}
	});

	it('every talent required item exists', () => {
		for (const talent of talents) {
			for (const id of talent.requiredItemIds ?? []) {
				expect(itemIds.has(id)).toBe(true);
			}
		}
	});

	it('provides motif word banks', () => {
		const motifs = getMotifs();
		expect(motifs.descriptors.length).toBeGreaterThan(0);
		expect(motifs.professions.length).toBeGreaterThan(0);
	});
});
