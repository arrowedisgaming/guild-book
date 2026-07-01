import { describe, it, expect } from 'vitest';
import {
	assignAttributeSpread,
	buildAttributeStates,
	isValidSpread,
	highestSuit
} from '$lib/engine/attributes';
import { resolveKin, kinGrants } from '$lib/engine/kindred';
import { resolvePath, buildStartingTalents } from '$lib/engine/calling';
import { getKiths, getPaths } from '$lib/server/content/loader';

describe('attribute assignment', () => {
	it('locks the 4 to the path suit and distributes 3/2/1', () => {
		const values = assignAttributeSpread({
			pathSuit: 'swords',
			spread: [4, 3, 2, 1],
			otherSuits: ['pentacles', 'cups', 'wands']
		});
		expect(values).toEqual({ swords: 4, pentacles: 3, cups: 2, wands: 1 });
		expect(isValidSpread(values, [4, 3, 2, 1])).toBe(true);
		expect(highestSuit(values)).toBe('swords');
	});

	it('records provenance — path suit sourced from the path', () => {
		const values = assignAttributeSpread({
			pathSuit: 'cups',
			spread: [4, 3, 2, 1],
			otherSuits: ['swords', 'pentacles', 'wands']
		});
		const states = buildAttributeStates(values, {
			pathSuit: 'cups',
			pathLabel: 'Path of Cups',
			at: '2026-07-01T00:00:00Z'
		});
		expect(states.cups.value).toBe(4);
		expect(states.cups.sources[0].source).toBe('path');
		expect(states.swords.sources[0].source).toBe('personal');
	});

	it('rejects a non-permutation of the spread', () => {
		expect(isValidSpread({ swords: 4, pentacles: 4, cups: 2, wands: 1 }, [4, 3, 2, 1])).toBe(false);
	});
});

describe('kith/kin & path grants', () => {
	const kiths = getKiths();
	const paths = getPaths();

	it('resolves a kin only within its kith', () => {
		expect(resolveKin(kiths, 'fay', 'fay-wood-elf')).not.toBeNull();
		// wood-elf is a fay kin, not an orc kin
		expect(resolveKin(kiths, 'orc', 'fay-wood-elf')).toBeNull();
	});

	it('surfaces the kin mastered talent and kith arête triggers', () => {
		const resolved = resolveKin(kiths, 'fay', 'fay-wood-elf')!;
		const grants = kinGrants(resolved);
		expect(grants.masteredTalentId).toBe('kin-fay-wood-elf');
		expect(grants.areteTriggers).toHaveLength(3);
	});

	it('assembles starting talents: kin mastered, one path talent mastered', () => {
		const resolved = resolveKin(kiths, 'human', 'human-house-valerian')!;
		const path = resolvePath(paths, 'path-of-swords')!;
		const talents = buildStartingTalents({
			kin: resolved.kin,
			path,
			masteredPathTalentId: path.talentIds[0],
			at: '2026-07-01T00:00:00Z'
		});
		const mastered = talents.filter((t) => t.state === 'mastered');
		expect(talents.find((t) => t.source === 'kin')?.state).toBe('mastered');
		expect(mastered).toHaveLength(2); // kin talent + one path talent
		expect(talents.filter((t) => t.source === 'path')).toHaveLength(path.talentIds.length);
	});
});
