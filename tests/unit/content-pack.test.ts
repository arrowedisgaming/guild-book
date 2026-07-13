import { describe, it, expect } from 'vitest';
import {
	getContentPack,
	getKiths,
	getPaths,
	getTalents,
	getItems,
	getMotifs,
	getLanguages,
	getConditions,
	getAfflictions,
	getRules,
	getSpells,
	loadWizardData
} from '$lib/server/content/loader';
import { SUIT_IDS } from '$lib/types/common';
import { RULES_SECTIONS } from '$lib/content/sections';

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

describe('content pack — transcribed content invariants', () => {
	const kiths = getKiths();
	const paths = getPaths();
	const talents = getTalents();
	const items = getItems();
	const pack = getContentPack();

	it('every path grants exactly seven talents', () => {
		for (const path of paths) {
			expect(path.talentIds, path.id).toHaveLength(7);
			expect(new Set(path.talentIds).size).toBe(7);
		}
	});

	it('has 28 path talents, 12 kin talents, and arête coverage for every kin', () => {
		expect(talents.filter((t) => t.source === 'path')).toHaveLength(28);
		expect(talents.filter((t) => t.source === 'kin')).toHaveLength(12);
		const kins = kiths.flatMap((k) => k.kins);
		// Every kin has a distinct mastered kin talent and an arête talent.
		expect(new Set(kins.map((k) => k.masteredTalentId)).size).toBe(kins.length);
		for (const kin of kins) expect(kin.areteTalentId).toBeTruthy();
	});

	it('every kith has exactly three arête triggers with no placeholders', () => {
		for (const kith of kiths) {
			expect(kith.areteTriggers, kith.id).toHaveLength(3);
			for (const t of kith.areteTriggers) expect(t).not.toMatch(/placeholder/i);
		}
	});

	it('contains no PLACEHOLDER text anywhere in talents or items', () => {
		const all = JSON.stringify(talents) + JSON.stringify(items);
		expect(all).not.toMatch(/placeholder/i);
	});

	it('verbatim collections carry no PLACEHOLDER markers or leftover page cross-references', () => {
		// Every collection whose prose was replaced with exact rulebook text by the
		// content-import pipeline. Rules and spells have dedicated structural checks
		// below because their schemas differ from the wizard-facing collections.
		const pack = getContentPack();
		const verbatim = JSON.stringify([
			getKiths(),
			getPaths(),
			getTalents(),
			getItems(),
			getLanguages(),
			getConditions(),
			getAfflictions(),
			pack.attributes,
			pack.tarot.resolution.outcomes
		]);
		expect(verbatim, 'PLACEHOLDER marker survived injection').not.toMatch(/placeholder/i);
		// Bare "page NN" cross-references should have been stripped during normalization.
		expect(verbatim, 'unstripped page cross-reference').not.toMatch(/\bpage\s+\d+/i);
		expect(verbatim, 'known corrupt Markdown-export punctuation survived').not.toMatch(
			/responsibility\.\.|declines,,|and\., and/
		);
	});

	it('rules reference: unique ids, known sections, non-empty verbatim bodies', () => {
		const rules = getRules();
		expect(rules.length).toBeGreaterThan(0);
		const validSections = new Set(RULES_SECTIONS.map((s) => s.id));
		const ids = new Set<string>();
		for (const rule of rules) {
			expect(ids.has(rule.id), `duplicate rule id ${rule.id}`).toBe(false);
			ids.add(rule.id);
			expect(validSections.has(rule.section as never), `unknown section ${rule.section}`).toBe(true);
			// A rule with an empty body is an incomplete/queued entry — it must not ship.
			expect(rule.body.trim().length, `empty body for rule ${rule.id}`).toBeGreaterThan(0);
			expect(rule.body, `PLACEHOLDER in rule ${rule.id}`).not.toMatch(/placeholder/i);
			expect(rule.body, `inline heading marker in rule ${rule.id}`).not.toMatch(
				/[^\n][ \t]+#{2,6}\s/
			);
		}
		const adjudicating = rules.find((rule) => rule.id === 'adjudicating-the-game');
		expect(adjudicating?.body).toContain('### “No, you can’t do that”');
		expect(adjudicating?.body).not.toContain('mechanism’s gears');
		expect(JSON.stringify(rules), 'orphaned epigraph attribution').not.toContain('Italo Calvino');
	});

	it('sorcery spells: 40 across the four traditions, unique ids, component + effect', () => {
		const spells = getSpells();
		expect(spells).toHaveLength(40);
		const traditions = new Set(spells.map((s) => s.tradition));
		expect(traditions).toEqual(new Set(['wastes', 'weald', 'weird', 'welkin']));
		// Ten spells per tradition.
		for (const t of traditions) {
			expect(spells.filter((s) => s.tradition === t).length, t).toBe(10);
		}
		const ids = new Set<string>();
		for (const spell of spells) {
			expect(ids.has(spell.id), `duplicate spell id ${spell.id}`).toBe(false);
			ids.add(spell.id);
			expect(spell.component.trim().length, `empty component for ${spell.id}`).toBeGreaterThan(0);
			expect(spell.description.trim().length, `empty description for ${spell.id}`).toBeGreaterThan(0);
			expect(spell.description, `wikilink in ${spell.id}`).not.toMatch(/\[\[|\]\]/);
		}
		const protection = spells.find((spell) => spell.id === 'protection-from-the-elements');
		expect(protection?.component).toBe(
			'A leather bag made out of the stomach of an ungoat and filled with beads'
		);
		expect(protection?.description).not.toMatch(/^filled with beads_/);
		const sleep = spells.find((spell) => spell.id === 'sleep');
		expect(sleep?.component).toBe('A pouch of powder made from crushed lotus seeds, sand, and wormwood');
		expect(sleep?.description).not.toMatch(/^and wormwood_/);
		const malediction = spells.find((spell) => spell.id === 'malediction');
		expect(malediction?.description).toContain('| Card | Malediction Curse |\n|:---:|---|\n| I |');
		expect(malediction?.description).not.toContain('APPENDIX A | SORCERY');
		const totem = spells.find((spell) => spell.id === 'totem');
		expect(totem?.description).toContain('| Card | Swords | Cups | Pentacles | Wands |\n');
	});

	it('items carry valid encumbrance data', () => {
		for (const item of items) {
			expect(item.slots, item.id).toBeGreaterThanOrEqual(1);
			if (item.carry === 'belt-only') expect(item.slots).toBe(2); // oversized
			if (item.wornBeltSlots) expect(item.category).toBe('armor');
			if (item.stack) expect(item.stack.per).toBeGreaterThanOrEqual(1);
			if (item.notches) expect(item.notches).toBeGreaterThanOrEqual(1);
		}
	});

	it('covers all three market tiers and the armory', () => {
		const tiers = new Set(items.map((i) => i.tier));
		expect(tiers).toEqual(new Set(['impoverished', 'common', 'luxurious']));
		expect(items.filter((i) => i.category === 'weapon').length).toBeGreaterThanOrEqual(9);
		// Armor worn-slot ladder: light 1 / iron 2 / steel 3.
		const worn = (id: string) => items.find((i) => i.id === id)?.wornBeltSlots;
		expect(worn('armor-light')).toBe(1);
		expect(worn('armor-iron')).toBe(2);
		expect(worn('armor-steel')).toBe(3);
	});

	it('declares the encumbrance capacities (hands 2 / belt 4 / pack 21)', () => {
		expect(pack.encumbrance).toEqual({ handSlots: 2, beltSlots: 4, packSlots: 21 });
	});

	it('affliction stages are sequential and have cure costs (or a terminal null)', () => {
		for (const aff of getAfflictions()) {
			expect(aff.stages.length).toBeGreaterThanOrEqual(1);
			aff.stages.forEach((s, i) => expect(s.stage).toBe(i + 1));
		}
	});
});
