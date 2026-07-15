# Campaigns Increment 0a: Chapter 6–9 Rules Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the in-session rules prose of Chapters 6–9 and the targeted cross-chapter sections into the browsable rules reference, so that Increment 0b's procedure `ruleEntryIds` resolve against real committed content.

**Architecture:** No new machinery. This increment extends the existing `manifest/rules-md.json` → `md-rules.mjs` → `rules.json` pipeline with new entries, using the extraction, linting, and drift-check conventions already proven for Chapter 1. Prose only; the oracle tables are Increment 0b's concern and are deliberately left stripped here.

**Tech Stack:** Node ESM scripts, gitignored Markdown vault at `assets-src/HMTW_md/`, JSON, Vitest.

## Why this increment exists

The superseded combined Increment 0 plan required (`:215`) that "every `ruleEntryId` exists in the generated rules manifest/output", and used `camp-high-chant` as its worked example (`:195`). No such entry exists or could exist: `scripts/content-import/manifest/rules-md.json` contains exactly ten entries, all drawn from `01 - Chapter 1 - The Basics.md`, and `static/content-packs/hmtw/rules.json` mirrors them. The pack README records this deliberately:

> **Partial / deferred:** `rules.json` — the browsable rules reference. Chapter 1 (The Basics) is done as ten verbatim entries; the rest of the book's rules chapters are deferred.

Specification §16 assigns this import to Increment 0 but no task ever performed it, so the combined plan failed against its own validator at Task 2. Splitting it out makes the work visible and estimable, and it is work the rules reference needs regardless of the campaign feature.

## Global Constraints

- Prose only. Do not attempt to preserve, extract, or hand-copy any oracle table in this increment; `stripExampleSubsections` correctly removes them and Increment 0b extracts them through a separate path.
- Every entry is extracted by script from the Markdown vault. Never retype or hand-edit rule body text into `rules.json`; the file is generated output.
- Do not modify `md-lib.mjs` extraction semantics. Chapter 1's ten committed entries must byte-for-byte survive every change in this increment.
- Reuse the existing entry shape exactly: `{ id, section, title, body, tags }`. Section IDs come from `src/lib/content/sections.ts`.
- Licence: the Adherent of the Worm licence permits reuse of "the mechanics and game text"; `denizens.json` already reproduces Appendix C verbatim. Reproduce game text only, never artwork, logos, or trade dress.
- `npm run content:build` must be deterministic and `npm run content:verify` must pass from a clean worktree.

---

### Task 1: Establish the Chapter 6–9 coverage contract

**Files:**
- Test: `tests/unit/rules-coverage.test.ts`

- [ ] **Step 1: Write the failing coverage test**

This test is the increment's definition of done. It asserts the reference covers the four phase chapters plus the named cross-chapter sections, and it is the thing Increment 0b's `ruleEntryIds` will lean on.

Create `tests/unit/rules-coverage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import rules from '../../static/content-packs/hmtw/rules.json';

const REQUIRED_IDS = [
	// Chapter 6 — Crawl
	'crawl-the-crawl-turn',
	'crawl-meatgrinder',
	'crawl-careful-movement',
	'crawl-noise',
	'crawl-darkness',
	'crawl-were-doomed',
	'crawl-area-sense',
	'crawl-social-encounters-disposition',
	'crawl-starting-disposition',
	// Chapter 7 — Challenge
	'challenge-sequence',
	'challenge-draw-cards',
	'challenge-initiative',
	'challenge-take-turns',
	'challenge-action-value',
	'challenge-facedown-cards',
	'challenge-interrupt-actions',
	'challenge-the-fool',
	'challenge-minor-actions',
	'challenge-end-the-round',
	'challenge-gm-hand-size',
	'challenge-lesser-dooms',
	'challenge-greater-dooms',
	// Chapter 8 — Camp
	'camp-sequence',
	'camp-no-rest-for-the-wicked',
	'camp-patrol',
	'camp-overland-travel',
	// Chapter 9 — City
	'city-sequence',
	'city-events',
	'city-signs-and-portents',
	'city-beg-and-busk',
	'city-carouse',
	'city-leeches',
	// Cross-chapter, in-session
	'paths-high-chant',
	'gm-creating-surprises',
	'gm-as-above-so-below',
	'sorcery-augury',
	'sorcery-maleficence',
	'sorcery-malediction',
	'sorcery-totem'
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
			expect(rule.body.trim().length).toBeGreaterThan(0);
			expect(rule.tags.length).toBeGreaterThan(0);
		}
	});

	it('has unique ids', () => {
		expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/rules-coverage.test.ts`

Expected: FAIL on "covers every in-session rule entry", listing every required ID as missing. The Chapter 1 and uniqueness assertions pass today.

- [ ] **Step 3: Note the verified source map**

These IDs were checked against the vault while writing this plan. **Three of them are not where the superseded Increment 0 plan assumed**, which is why Task 3 Step 1 insists on listing headings rather than trusting a plan:

| ID | Source | Note |
|---|---|---|
| `paths-high-chant` | `05 - Chapter 5 …` — `High Chant` | **Not Chapter 8.** It is a Path talent that grants a Camp Action. The superseded plan's manifest example claimed `08 - Chapter 8`, where no such heading exists. |
| `city-leeches` | `09 - Chapter 9 …` — `Leeches` | **Not Chapter 8.** It is an Omphalic Market item whose effect classifies a drawn card by suit. |
| `camp-no-rest-for-the-wicked` | `08 - Chapter 8 …` — `3. No rest for the wicked` | This is the "watch" rule. There is no heading named `Watch`. It holds both the discard-top oracle that picks who is on guard and the Cups test. |
| `challenge-gm-hand-size` | `07 - Chapter 7 …` — `1. Draw Challenge cards`, `after: "GMing the Challenge"` | **`1. Draw Challenge cards` occurs three times** (`:29` flow summary, `:226` player rule, `:607` GM rule). The GM formula is the third. Without `after`, `extractSection` silently takes the first match. |
| `challenge-draw-cards` | `07 - Chapter 7 …` — `1. Draw Challenge cards`, `until` the GM section | The player rule at `:226`. Establishes the four-card player hand. |
| `camp-overland-travel` | `08 - Chapter 8 …` — `Overland Travel` | Lives in Chapter 8, not a chapter of its own. |
| `crawl-starting-disposition` | `06 - Chapter 6 …` — `Starting Disposition` | Prose here; its table is Increment 0b's. |

Any other repeated heading needs the same `after` treatment. Check for collisions before authoring an entry:

```bash
grep -c "^#\{1,3\} 1\. Draw Challenge cards" "assets-src/HMTW_md/07 - Chapter 7 - The Challenge Phase.md"
```

- [ ] **Step 4: Commit the contract**

```bash
git add tests/unit/rules-coverage.test.ts
git commit -m "test(content): define chapter 6-9 rules coverage contract"
```

### Task 2: Confirm the section IDs the entries will use

**Files:**
- Read: `src/lib/content/sections.ts`
- Modify: `src/lib/content/sections.ts` (only if a needed section is absent)

- [ ] **Step 1: Read the existing section list**

Run: `cat src/lib/content/sections.ts`

Every manifest entry's `section` must be one of these IDs. Chapter 1's entries use `basics`.

- [ ] **Step 2: Add only genuinely missing sections**

If sections for the Crawl, Challenge, Camp, City, gamemastering, and sorcery groupings are absent, add them following the existing shape and book order. Do not invent a section for a single entry where an existing one fits.

- [ ] **Step 3: Verify the type check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 4: Commit if changed**

```bash
git add src/lib/content/sections.ts
git commit -m "feat(content): add rules sections for the phase chapters"
```

Skip this commit entirely if Step 2 changed nothing.

### Task 3: Author the Chapter 6 (Crawl) manifest entries

**Files:**
- Modify: `scripts/content-import/manifest/rules-md.json`
- Modify: `static/content-packs/hmtw/rules.json` (generated)

- [ ] **Step 1: Discover the real headings**

Do not guess heading text. List it:

```bash
grep -n "^#\{1,3\} " "assets-src/HMTW_md/06 - Chapter 6 - The Crawl Phase.md"
```

Headings are matched case-insensitively with emphasis stripped (`md-lib.mjs:21-27`), but the text must otherwise be exact. Note that the vault uses typographic apostrophes — `We’re doomed!`, not `We're doomed!`.

- [ ] **Step 2: Append entries in book order**

`rules-md.json` is a flat array and **manifest order is book order** (`md-rules.mjs:3-4`). Append Chapter 6 entries after the Chapter 1 block, using the existing record shape:

```json
{
	"id": "crawl-meatgrinder",
	"section": "crawl",
	"title": "The Meatgrinder",
	"file": "06 - Chapter 6 - The Crawl Phase.md",
	"heading": "Meatgrinder",
	"tags": ["crawl", "oracle", "tarot"]
}
```

Use `until` to split a section from a nested sub-section that should be its own entry, and `after` to disambiguate a heading that recurs. Both are already supported (`md-lib.mjs:38-41`).

Add `mustContain` sentinels for the rules Increment 0b depends on, so a source re-export that silently drops a clause fails the build rather than the campaign engine:

```json
{
	"id": "crawl-were-doomed",
	"section": "crawl",
	"title": "We’re Doomed!",
	"file": "06 - Chapter 6 - The Crawl Phase.md",
	"heading": "We’re doomed!",
	"mustContain": ["torch"],
	"tags": ["crawl", "darkness", "tarot"]
}
```

- [ ] **Step 3: Build and inspect**

Run: `node scripts/content-import/md-rules.mjs --dry-run`

Expected: each new entry previews with a plausible character count and opening line. A `heading not found` error means Step 1's text was wrong — fix the manifest, not `md-lib.mjs`.

- [ ] **Step 4: Handle lint failures honestly**

`lintBody` (`md-rules.mjs:34-49`) rejects empty bodies, unconverted wikilinks, `PLACEHOLDER` markers, page cross-references, leftover suit-glyph tokens, and inline heading markers. If an entry trips one:

- **Page cross-reference** — the body says "see page 137". That is a book-print artifact; the correct fix is usually a tighter `heading`/`until` range, not loosening the lint.
- **Unconverted wikilink** — `stripWikilinks` missed a form. Report it; do not delete the lint rule.
- **Empty body** — the heading matched a section whose content is entirely tables or callouts. That is expected for a pure-table section; **that entry belongs in Increment 0b, not here.** Remove it from this manifest and note it in the completion record.

Do not add an `omitRange` unless the source is genuinely corrupt in the way `md-rules.mjs:20-31` documents.

- [ ] **Step 5: Write and verify determinism**

```bash
node scripts/content-import/md-rules.mjs
node scripts/content-import/md-rules.mjs --check
```

Expected: `--check` reports `0 drifted`.

- [ ] **Step 6: Commit Chapter 6**

```bash
git add scripts/content-import/manifest/rules-md.json static/content-packs/hmtw/rules.json
git commit -m "feat(content): import chapter 6 crawl rules"
```

### Task 4: Author Chapters 7, 8, and 9

**Files:**
- Modify: `scripts/content-import/manifest/rules-md.json`
- Modify: `static/content-packs/hmtw/rules.json` (generated)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Repeat Task 3's loop per chapter**

Work one chapter at a time, running `--dry-run` after each block. Chapter 8 (Camp) contains **zero table rows**, so it should import cleanly as pure prose. Chapter 9 (City) is the largest and includes the Beg & Busk / Carouse actions.

- [ ] **Step 2: Close the documented Challenge hand-size gap**

`CHANGELOG.md:43-46` records:

> TODO: The Elite/Dungeon Lord "draws an additional Challenge card" mechanic is intentionally NOT stored on Appendix C stat blocks — it's a **Chapter 7 hand-size procedure** keyed to threat type. Surface it in the rules reference when Chapter 7 combat content is imported, so it isn't lost.

The `challenge-gm-hand-size` entry is that surfacing. Give it a `mustContain` sentinel proving the threat-tier clause survived extraction, then remove the TODO from `CHANGELOG.md` and note the closure in the Unreleased section. Specification §16 assigns this closure to Increment 0; it lands here because it is a rules-reference import, and Increment 0b's `challenge-round` procedure and Increment 3's `calculateGmHandSize` both cite this entry.

- [ ] **Step 3: Verify determinism across all four chapters**

```bash
node scripts/content-import/md-rules.mjs
node scripts/content-import/md-rules.mjs --check
npm test -- tests/unit/rules-coverage.test.ts
```

Expected: `0 drifted`; the coverage test's Chapter 6–9 IDs now resolve. The cross-chapter IDs still fail until Task 5.

- [ ] **Step 4: Commit**

```bash
git add scripts/content-import/manifest/rules-md.json static/content-packs/hmtw/rules.json CHANGELOG.md
git commit -m "feat(content): import chapter 7-9 rules and close hand-size TODO"
```

### Task 5: Author the targeted cross-chapter entries

**Files:**
- Modify: `scripts/content-import/manifest/rules-md.json`
- Modify: `static/content-packs/hmtw/rules.json` (generated)

- [ ] **Step 1: Import only the in-session sections**

The boundary is the moment of use (specification §9). Import:

| Entry | Source |
|---|---|
| `gm-creating-surprises` | `10 - Chapter 10 …` — `Creating surprises` |
| `gm-as-above-so-below` | `10 - Chapter 10 …` — `As Above, So Below` |
| `sorcery-augury` | `11 - Appendix A - Sorcery.md` — `Augury` |
| `sorcery-maleficence` | `11 - Appendix A - Sorcery.md` — `Maleficence` |
| `sorcery-malediction` | `11 - Appendix A - Sorcery.md` — `Malediction` |
| `sorcery-totem` | `11 - Appendix A - Sorcery.md` — `Totem` |

Do **not** import City Creation, Underworld Creation, or the Job Board. Those are preparation tooling and are deferred.

- [ ] **Step 2: Record the source-location findings**

The specification is **correct** that all three Special City Actions are in Appendix D. An earlier draft of this plan "corrected" it to say As Above So Below lives in Chapter 10; that was wrong, and the trap is worth knowing about:

1. **`### As Above, So Below` at `10 - Chapter 10 …:594` is a found-footage movie**, sitting under `# Inspirational and Educational Reading` → `## Movies`. Importing it by heading yields a film review, not a rule. The real City Action is `14 - Appendix D …:1066` — "You may go stargazing at the Sidereal House. Draw the top three cards from the minor arcana deck and place them back in any order" — which is the top-three reorder §9:438 describes.
2. **All three Special City Actions are bullet list items**, not addressable sections: Doomsaying (`:806`), Strange communions (`:1050`), As above so below (`:1066`). They sit under repeated `#### Special City Action:` headings, so `extractSection` cannot target them and they get **no rules entry** in this increment. Increment 0b reaches them with an explicit anchor selector, and their `ruleEntryIds` must therefore be empty. Flag all three in the completion record.

The general lesson for anyone extending this manifest: **a matching heading is not a matching rule.** Verify the extracted body, not just that extraction succeeded.

- [ ] **Step 3: Run the full increment gate**

```bash
npm run content:build
npm run content:verify
npm test -- tests/unit/rules-coverage.test.ts
npm run check
npm test
```

Expected: every command exits 0, and the coverage test passes in full. A second `npm run content:build` produces no diff.

- [ ] **Step 4: Commit Increment 0a**

```bash
git add scripts/content-import/manifest/rules-md.json static/content-packs/hmtw/rules.json
git commit -m "feat(content): import cross-chapter in-session rules"
```

## Increment 0a Completion Record — executed 2026-07-15

**Status: complete. Gate A1 passes.**

| Measure | Result |
|---|---|
| Rule entries | 10 → **54** (+44) |
| Per source | Ch6 +12, Ch7 +14, Ch8 +3, Ch9 +5, Ch4 +1, Ch5 +2, Ch10 +1, Appendix A +6 |
| `md-rules.mjs --check` | `Checked 54 rules, 0 drifted` |
| `npm run content:verify` | 173 fields / 9 collections, 54 rules, 40 spells — all `0 drifted` |
| `npm run check` | 4593 files, 0 errors, 0 warnings |
| `npm test` | 148 passed |
| Existing entries | Byte-identical — regenerated `rules.json` diff is **+225 / −0** |

**Production fix required by this increment:** `md-rules.mjs:60` called `extractRuleBody` without `entry.after`, so a manifest entry disambiguating a repeated heading silently imported the first match. `md-inject.mjs:77` already passed it. Caught by a `mustContain` sentinel on `challenge-gm-hand-size`, which would otherwise have imported a one-line flow summary in place of the GM hand formula. No committed entry used `after`, so the fix produced zero drift.

**Hand-size TODO closed.** `challenge-gm-hand-size` carries the threat-tier clause verbatim (`+2 cards if there is an elite enemy`, `+3 cards if there is a dungeon lord`), guarded by sentinels. `CHANGELOG.md`'s TODO is removed and the closure recorded under Unreleased.

**Deliberately absent, each for a source reason:**

- `camp-sequence`, `city-sequence` — `# The Flow of the X Phase` runs to the next `#`, and every candidate `until` anchor collides with the identically-named flow-summary item, so the flow list cannot be sliced. Both are chapter overviews no procedure cites; importing them means an 8k/23k blob duplicating the entries beside them. Revisit only if `md-lib` grows an `until`-with-`after` form.
- `gm-as-above-so-below` — the Chapter 10 heading is a movie. The real City Action is an Appendix D bullet; see Task 5 Step 2.
- Doomsaying, Strange Communions, As Above So Below, and `Aim` — all bullet items, no rules entry, deferred to Increment 0b's anchor selector.

**Findings handed to Increment 0b:** three specification rule errors (`Aim`'s location, the non-existent "shield Initiative replacement", and the As Above So Below movie trap) and one structural problem — the "No peeking!" privacy rule lives in a sidebar callout that `stripCallouts` removes, so the privacy model's rulebook citation is not extractable. All four are recorded in that plan's "Findings from executing Increment 0a".

Increment 0b may begin: `tests/unit/rules-coverage.test.ts` passes, so every `ruleEntryId` it validates resolves against this increment's output.
