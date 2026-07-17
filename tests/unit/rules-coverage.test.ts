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
	// Chapter 3 — The Guild
	'guild-deeds-and-fame',

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
	'challenge-guard',
	'challenge-miscellaneous-actions',

	// Chapter 8 — The Camp Phase
	// No `camp-sequence`: `# The Flow of the Camp Phase` runs to the next `#`
	// (Overland Travel), so it cannot be sliced to the flow list — every `until`
	// anchor collides with the identically-named flow summary item. It is a
	// chapter overview no procedure cites, so it is out of scope rather than
	// imported as an 8k blob that duplicates camp-patrol.
	'camp-patrol',
	'camp-no-rest-for-the-wicked',
	'camp-overland-travel',

	// Chapter 9 — The City Phase
	// No `city-sequence`, for the same reason: it would import 23k of the whole
	// chapter, duplicating city-events, city-carouse, and the rest.
	'city-events',
	'city-signs-and-portents',
	'city-beg-and-busk',
	'city-carouse',
	'city-leeches',

	// Cross-chapter, in-session only
	// No `gm-as-above-so-below`: `### As Above, So Below` in Chapter 10 is a
	// *movie* in the Inspirational Media list, not a rule. The real City Action
	// is an Appendix D bullet (`:1066`), which `extractSection` cannot address;
	// Increment 0b reaches it with an anchor selector, as with Doomsaying and
	// Strange Communions.
	'kith-area-sense',
	'paths-high-chant',
	'paths-counsel',
	'gm-creating-surprises',
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

	/**
	 * The campaign privacy model's rulebook citation. §8.2 of the campaigns spec
	 * rests on this sentence, but it lives in an Obsidian sidebar callout, which
	 * the pipeline strips by default. `challenge-facedown-cards` opts in via
	 * `keepCallouts` so the reference actually contains the rule it is cited for.
	 */
	it('retains the facedown privacy rule the campaign privacy model cites', () => {
		const rule = byId.get('challenge-facedown-cards');
		expect(rule?.body).toContain('Nobody but the player can look at the facedown card');
		expect(rule?.body).toContain('No peeking!');
	});

	/**
	 * Both import pipelines strip `<br>`; both must replace it with a space. The
	 * table path was fixed first and the prose path was missed, so Carouse shipped
	 * with "face.• It is:" welded together. This guards the prose path.
	 */
	it('never welds two clauses together where the source had a line break', () => {
		for (const rule of rules) {
			expect(rule.body, `${rule.id} welded clause`).not.toMatch(/\S•/);
		}
		const carouse = byId.get('city-carouse');
		expect(carouse?.body).toContain('face. • It is:');
		expect(carouse?.body).toContain('burnt down [Pentacles]');
	});

	/**
	 * `keepCallouts` must convert a callout into the renderer's dialect, not
	 * preserve its blockquote syntax: src/lib/utils/markdown.ts has no blockquote
	 * branch and escapes `>` to `&gt;`, so a leaked `>` renders literally.
	 */
	it('never emits syntax the rules renderer cannot handle', () => {
		for (const rule of rules) {
			expect(rule.body, `${rule.id} leaks a blockquote`).not.toMatch(/^\s*>/m);
			expect(rule.body, `${rule.id} leaks a callout marker`).not.toContain('[!');
		}
	});
});
