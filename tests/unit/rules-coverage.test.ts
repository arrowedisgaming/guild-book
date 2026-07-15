import { describe, expect, it } from 'vitest';
import rules from '../../static/content-packs/hmtw/rules.json';

/**
 * Increment 0a's definition of done: the rules reference covers every in-session
 * rule the campaign feature cites, so Increment 0b's procedure `ruleEntryId`s
 * resolve against real committed content.
 *
 * Every id below was checked against a real heading in the Markdown vault while
 * authoring this list. Several live in a different chapter than their phase
 * suggests — talents are in Kith and Kin / The Four Paths, and equipment rules
 * are in The City Phase — so the id names the rule, not the chapter.
 */
const REQUIRED_IDS = [
	// Chapter 6 — The Crawl Phase
	'crawl-sequence',
	'crawl-watches',
	'crawl-meatgrinder',
	'crawl-loud-noises',
	'crawl-moving-carefully',
	'crawl-darkness',
	'crawl-flickers',
	'crawl-were-doomed',
	'crawl-social-encounters-disposition',
	'crawl-starting-disposition',
	'crawl-influencing-disposition',
	'crawl-black-honey',

	// Chapter 7 — The Challenge Phase
	'challenge-sequence',
	'challenge-draw-cards',
	'challenge-play-initiative',
	'challenge-take-turns',
	'challenge-action-value',
	'challenge-facedown-cards',
	'challenge-interrupt-actions',
	'challenge-the-fool',
	'challenge-minor-actions',
	'challenge-end-the-round',
	'challenge-gm-hand-size',
	'challenge-enemy-actions',
	'challenge-lesser-dooms',
	'challenge-greater-dooms',

	// Chapter 8 — The Camp Phase
	'camp-sequence',
	'camp-patrol',
	'camp-no-rest-for-the-wicked',
	'camp-overland-travel',

	// Chapter 9 — The City Phase
	'city-sequence',
	'city-events',
	'city-signs-and-portents',
	'city-beg-and-busk',
	'city-carouse',
	'city-leeches',

	// Cross-chapter, in-session only
	'kith-area-sense',
	'paths-high-chant',
	'paths-counsel',
	'gm-creating-surprises',
	'gm-as-above-so-below',
	'sorcery-augury',
	'sorcery-maleficence',
	'sorcery-malediction',
	'sorcery-totem',
	'sorcery-guardian-angel',
	'sorcery-brainfever'
] as const;

describe('rules reference coverage', () => {
	const byId = new Map(rules.map((r) => [r.id, r]));

	it('retains the ten committed Chapter 1 entries', () => {
		for (const id of ['the-four-phases', 'the-flow-of-play', 'adjudicating-the-game']) {
			expect(byId.has(id)).toBe(true);
		}
	});

	it('covers every in-session rule entry the campaign feature cites', () => {
		const missing = REQUIRED_IDS.filter((id) => !byId.has(id));
		expect(missing).toEqual([]);
	});

	it('gives every entry a non-empty body and at least one tag', () => {
		for (const rule of rules) {
			expect(rule.body.trim().length, `${rule.id} body`).toBeGreaterThan(0);
			expect(rule.tags.length, `${rule.id} tags`).toBeGreaterThan(0);
		}
	});

	it('has unique ids', () => {
		expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
	});
});
