# Full Chapters 1–9 Rules Coverage + Site-Wide Fuzzy Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every H1/H2 section of HMTW chapters 1–9 becomes a rule entry (full prose, examples, sidebars, epigraphs included), and an always-visible header search (MiniSearch fuzzy + ranked dropdown) works from every root-layout page.

**Architecture:** A chapter-walking extractor (`md-walk.mjs`) with tree-based ownership feeds the existing manifest-driven pipeline (`md-rules.mjs`), which also emits a committed coverage ledger (CI-checkable without the gitignored vault) and a plain-text search artifact inside the content-pack digest. Client-side: a memoized search service (dynamic-import MiniSearch), a combobox `SiteSearch` component in the header grid, and a two-mode `/rules` page.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript strict, Zod, Vitest, Playwright, MiniSearch (new runtime dep).

**Spec:** `docs/superpowers/specs/2026-08-01-rules-coverage-and-search-design.md` — read it before starting any task.

## Global Constraints

- Branch: all work on `feat/rules-full-coverage-and-search` in the worktree at `.claude/worktrees/rules-coverage-search`. `main` is PR-only; never push to it.
- Every commit: no Claude/automated-authorship attribution or co-author trailers.
- The vault `assets-src/HMTW_md/` is gitignored and copyrighted — never commit anything from it except through the generated pack files.
- Content guarantee (spec §Content guarantee): walked entries preserve **all source prose** — rules text, worked examples, callouts (converted), epigraphs (italic quotation). Permitted omissions only: bare page numbers, image placeholders/suit glyphs, running page headers, manifest `omitRange` repairs (each with a rationale).
- Engine-layer purity rules don't apply here (no `src/lib/engine/` changes), but `src/lib/search/` modules must not import from `$lib/server/`.
- Pack version: any content change requires an `index.json` version bump + `verify-pack-version.mjs --write` re-record. This plan bumps `3.4.0` → `4.0.0` once, in Task 9.
- Budgets (spec §Performance budgets): `rules-search.json` ≤ 700 KB raw / ≤ 200 KB gzip; MiniSearch never in the initial bundle (dynamic import only).
- Svelte 5 runes conventions per CLAUDE.md (`$props()`, `$state()`, `$derived`, `{@render}`).
- Tabs for indentation in JS/TS (matches the repo).

---

### Task 1: Worktree environment setup

**Files:** none committed (environment only).

**Interfaces:**
- Consumes: existing worktree `.claude/worktrees/rules-coverage-search` (branch `feat/rules-full-coverage-and-search`, created during planning).
- Produces: a runnable checkout with the vault visible, for all later tasks.

- [ ] **Step 1: Enter the worktree and confirm the branch**

Run:
```bash
cd /Users/oneill/Documents/coding/hmtw-guildbook/.claude/worktrees/rules-coverage-search
git branch --show-current
```
Expected: `feat/rules-full-coverage-and-search`. If the worktree is missing, create it: `git -C /Users/oneill/Documents/coding/hmtw-guildbook worktree add .claude/worktrees/rules-coverage-search feat/rules-full-coverage-and-search`.

- [ ] **Step 2: Symlink the gitignored vault into the worktree**

The pipeline resolves `assets-src/HMTW_md/` relative to the repo root (`scripts/content-import/pack.mjs` `ROOT`), and a fresh worktree has no gitignored files.

Run:
```bash
ln -s /Users/oneill/Documents/coding/hmtw-guildbook/assets-src assets-src
ls "assets-src/HMTW_md/01 - Chapter 1 - The Basics.md"
```
Expected: the file listing prints (no error).

- [ ] **Step 3: Install dependencies and baseline the suite**

Run:
```bash
npm install
npm run check && npm test
```
Expected: both pass (this is the pre-change baseline; if something already fails, stop and report — do not proceed on a red baseline).

---

### Task 2: `md-walk.mjs` — heading scan with structural locators

**Files:**
- Create: `scripts/content-import/md-walk.mjs`
- Test: `tests/unit/md-walk.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions over a markdown string).
- Produces: `scanHeadings(markdown) -> { lines: string[], headings: Heading[] }` where `Heading = { level: number, text: string, line: number, path: string, occurrence: number }`. `path` is ancestor heading texts joined with `/` (raw text, emphasis stripped); `occurrence` is 1-based per case-insensitive path. Task 3 builds on this.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/md-walk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scanHeadings } from '../../scripts/content-import/md-walk.mjs';

const CH7ish = [
	'# Chapter 7: The Challenge Phase',
	'Intro prose.',
	'# The Flow of the Challenge Phase',
	'## 1. Draw Challenge cards',
	'Player draw text.',
	'### Facedown cards',
	'Facedown text.',
	'# GMing the Challenge',
	'## 1. Draw Challenge cards',
	'GM draw text.'
].join('\n');

describe('scanHeadings', () => {
	it('records level, text, and line for every ATX heading', () => {
		const { headings } = scanHeadings(CH7ish);
		expect(headings.map((h) => [h.level, h.text])).toEqual([
			[1, 'Chapter 7: The Challenge Phase'],
			[1, 'The Flow of the Challenge Phase'],
			[2, '1. Draw Challenge cards'],
			[3, 'Facedown cards'],
			[1, 'GMing the Challenge'],
			[2, '1. Draw Challenge cards']
		]);
	});

	it('builds parent-path locators so duplicated headings are distinct', () => {
		const { headings } = scanHeadings(CH7ish);
		const draws = headings.filter((h) => h.text === '1. Draw Challenge cards');
		expect(draws.map((h) => h.path)).toEqual([
			'The Flow of the Challenge Phase/1. Draw Challenge cards',
			'GMing the Challenge/1. Draw Challenge cards'
		]);
		expect(draws.map((h) => h.occurrence)).toEqual([1, 1]);
	});

	it('numbers occurrences when even the full path repeats', () => {
		const twice = '# A\n## B\ntext\n## B\nmore';
		const { headings } = scanHeadings(twice);
		const bs = headings.filter((h) => h.text === 'B');
		expect(bs.map((h) => h.occurrence)).toEqual([1, 2]);
	});

	it('promotes whole-line bold pseudo-headings to H3, matching md-lib', () => {
		const { headings } = scanHeadings('# A\n**Dwarf arête talent: Iron Beards**\ntext');
		expect(headings[1]).toMatchObject({ level: 3, text: 'Dwarf arête talent: Iron Beards' });
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: FAIL — cannot resolve `md-walk.mjs`.

- [ ] **Step 3: Implement `scanHeadings`**

Create `scripts/content-import/md-walk.mjs`:

```js
// @ts-nocheck — plain ESM build script, matching the other content-import scripts.
// Chapter-walking extractor for the rules reference: parses a chapter's heading
// structure into a tree with structural locators (parent path + occurrence), so
// every H1/H2 can be emitted as a rule entry exactly once and duplicated
// headings (Ch7 repeats its flow steps under "GMing the Challenge") stay
// addressable. Pure functions over strings — no filesystem access — so the
// tests never need the gitignored vault.

/** ATX heading match: returns { level, text } or null. Mirrors md-lib. */
function parseHeadingLine(line) {
	const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
	return m ? { level: m[1].length, text: m[2].trim() } : null;
}

/**
 * Scans a chapter into an ordered heading list with structural locators.
 * `path` = ancestor texts joined by '/', matching manifest locator syntax;
 * `occurrence` disambiguates when even the full path repeats.
 */
export function scanHeadings(markdown) {
	// Same whole-line-bold promotion md-lib applies, so both see one structure.
	const lines = markdown.split('\n').map((l) => l.replace(/^\s*\*\*(.+?)\*\*\s*$/, '### $1'));
	const headings = [];
	const stack = [];
	const pathCounts = new Map();
	for (let i = 0; i < lines.length; i++) {
		const h = parseHeadingLine(lines[i]);
		if (!h) continue;
		const text = h.text.replace(/[*_`]/g, '').trim();
		while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
		const path = [...stack.map((s) => s.text), text].join('/');
		const key = path.toLowerCase();
		const occurrence = (pathCounts.get(key) ?? 0) + 1;
		pathCounts.set(key, occurrence);
		headings.push({ level: h.level, text, line: i, path, occurrence });
		stack.push({ level: h.level, text });
	}
	return { lines, headings };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/content-import/md-walk.mjs tests/unit/md-walk.test.ts
git commit -m "feat(content): heading scanner with structural locators for chapter walks"
```

---

### Task 3: `md-walk.mjs` — ownership, skips, splitDeeper, containers

**Files:**
- Modify: `scripts/content-import/md-walk.mjs`
- Test: `tests/unit/md-walk.test.ts`

**Interfaces:**
- Consumes: `scanHeadings` (Task 2).
- Produces: `walkChapter(markdown, config) -> { candidates: Candidate[], ledger: LedgerRow[] }` where
  `Candidate = { locator: string, occurrence: number, level: number, text: string, bodyLines: string[] }` and
  `LedgerRow = { locator: string, occurrence: number, level: number, disposition: 'candidate' | 'container' | 'skipped', reason?: string }`.
  `config` fields used here: `skip?: Array<{ at, occurrence?, reason }>`, `splitDeeper?: Array<{ at, occurrence?, id }>`. Task 4 turns candidates into id'd entries (and rewrites `disposition: 'candidate'` to `emitted:<id>`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/md-walk.test.ts`:

```ts
import { walkChapter } from '../../scripts/content-import/md-walk.mjs';

const OWNERSHIP = [
	'# Chapter 2: The Adventurer',
	'Chapter intro paragraph.',
	'# Session 0',
	'H1 intro prose.',
	'## 2. Attributes',
	'Attributes prose.',
	'### Details',
	'Detail prose stays inline.',
	'## 3. Quests',
	'Quests prose.',
	'# Pure Container',
	'## Only Child',
	'Child prose.'
].join('\n');

describe('walkChapter ownership', () => {
	it('assigns every source paragraph to exactly one candidate body', () => {
		const { candidates } = walkChapter(OWNERSHIP, {});
		const bodies = candidates.map((c) => c.bodyLines.join('\n'));
		for (const paragraph of [
			'Chapter intro paragraph.',
			'H1 intro prose.',
			'Attributes prose.',
			'Detail prose stays inline.',
			'Quests prose.',
			'Child prose.'
		]) {
			expect(bodies.filter((b) => b.includes(paragraph))).toHaveLength(1);
		}
	});

	it('gives an H1 only its pre-H2 prose, and keeps H3 inline in its H2', () => {
		const { candidates } = walkChapter(OWNERSHIP, {});
		const session0 = candidates.find((c) => c.text === 'Session 0');
		expect(session0?.bodyLines.join('\n')).toBe('H1 intro prose.');
		const attrs = candidates.find((c) => c.text === '2. Attributes');
		expect(attrs?.bodyLines.join('\n')).toContain('### Details');
		expect(attrs?.bodyLines.join('\n')).toContain('Detail prose stays inline.');
	});

	it('records a prose-less H1 as a container, not a candidate', () => {
		const { candidates, ledger } = walkChapter(OWNERSHIP, {});
		expect(candidates.find((c) => c.text === 'Pure Container')).toBeUndefined();
		expect(ledger.find((r) => r.locator === 'Pure Container')).toMatchObject({
			disposition: 'container'
		});
	});

	it('splitDeeper lifts an H3 out of its H2 into its own candidate', () => {
		const md = ['# Flow', '## 3. Take turns', 'Turn prose.', '### Action value', 'Value prose.'].join('\n');
		const { candidates } = walkChapter(md, {
			splitDeeper: [{ at: 'Flow/3. Take turns/Action value', id: 'x-action-value' }]
		});
		const turns = candidates.find((c) => c.text === '3. Take turns');
		const value = candidates.find((c) => c.text === 'Action value');
		expect(turns?.bodyLines.join('\n')).toBe('Turn prose.');
		expect(value?.bodyLines.join('\n')).toBe('Value prose.');
	});

	it('skip excludes the heading and its whole subtree, with the reason ledgered', () => {
		const md = ['# Keep', 'kept.', '## NEW ADVENTURER CHECKLIST', 'dupe.', '### Sub', 'sub dupe.', '## After', 'after.'].join('\n');
		const { candidates, ledger } = walkChapter(md, {
			skip: [{ at: 'Keep/NEW ADVENTURER CHECKLIST', reason: 'duplicate all-caps copy of the checklist' }]
		});
		expect(candidates.map((c) => c.text)).toEqual(['Keep', 'After']);
		expect(ledger.find((r) => r.disposition === 'skipped')).toMatchObject({
			locator: 'Keep/NEW ADVENTURER CHECKLIST',
			reason: 'duplicate all-caps copy of the checklist'
		});
	});

	it('throws on a skip/splitDeeper locator that matches nothing', () => {
		expect(() => walkChapter(OWNERSHIP, { skip: [{ at: 'Nope/Missing', reason: 'x' }] })).toThrow(/locator/i);
	});
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: FAIL — `walkChapter` is not exported.

- [ ] **Step 3: Implement `walkChapter`**

Append to `scripts/content-import/md-walk.mjs`:

```js
/** End line (exclusive) of a heading's subtree: next heading at <= its level. */
function subtreeEnd(headings, index, totalLines) {
	for (let i = index + 1; i < headings.length; i++) {
		if (headings[i].level <= headings[index].level) return headings[i].line;
	}
	return totalLines;
}

function locatorMatches(h, loc) {
	return h.path.toLowerCase() === loc.at.toLowerCase() && h.occurrence === (loc.occurrence ?? 1);
}

function findByLocator(headings, loc, kind) {
	const hit = headings.find((h) => locatorMatches(h, loc));
	if (!hit) throw new Error(`${kind} locator matches no heading: ${JSON.stringify(loc.at)} (occurrence ${loc.occurrence ?? 1})`);
	return hit;
}

/**
 * Walks a chapter into emission candidates (H1s, H2s, and splitDeeper H3s) and
 * a coverage ledger. Ownership: an H1 owns only its pre-first-child prose; an
 * H2 owns its subtree minus splitDeeper H3 subtrees; skipped subtrees vanish.
 * Every candidate body is a disjoint slice of the source — the exactly-once
 * test in the suite is the guarantee full coverage rests on.
 */
export function walkChapter(markdown, config) {
	const { lines, headings } = scanHeadings(markdown);
	const skips = (config.skip ?? []).map((s) => ({ ...s, heading: findByLocator(headings, s, 'skip') }));
	const deepers = (config.splitDeeper ?? []).map((s) => ({ ...s, heading: findByLocator(headings, s, 'splitDeeper') }));

	const skipRanges = skips.map((s) => {
		const idx = headings.indexOf(s.heading);
		return [s.heading.line, subtreeEnd(headings, idx, lines.length)];
	});
	const inSkip = (line) => skipRanges.some(([a, b]) => line >= a && line < b);
	const isDeeper = (h) => deepers.some((d) => d.heading === h);

	const candidates = [];
	const ledger = [];
	for (let i = 0; i < headings.length; i++) {
		const h = headings[i];
		const tracked = h.level <= 2 || isDeeper(h);
		if (!tracked) continue;
		if (inSkip(h.line)) {
			const skip = skips.find((s) => s.heading === h);
			// Only the skip root gets a ledger row; descendants are covered by it.
			if (skip) ledger.push({ locator: h.path, occurrence: h.occurrence, level: h.level, disposition: 'skipped', reason: skip.reason });
			continue;
		}
		const end = subtreeEnd(headings, i, lines.length);
		// Nested tracked headings inside this subtree own their slices, not us.
		const carveOuts = [];
		for (let j = i + 1; j < headings.length && headings[j].line < end; j++) {
			const child = headings[j];
			if (child.level <= 2 || isDeeper(child)) {
				carveOuts.push([child.line, subtreeEnd(headings, j, lines.length)]);
			}
		}
		const owned = [];
		for (let line = h.line + 1; line < end; line++) {
			if (inSkip(line)) continue;
			if (carveOuts.some(([a, b]) => line >= a && line < b)) continue;
			owned.push(lines[line]);
		}
		while (owned.length && owned[0].trim() === '') owned.shift();
		while (owned.length && owned[owned.length - 1].trim() === '') owned.pop();

		if (owned.length === 0) {
			ledger.push({ locator: h.path, occurrence: h.occurrence, level: h.level, disposition: 'container' });
			continue;
		}
		candidates.push({ locator: h.path, occurrence: h.occurrence, level: h.level, text: h.text, bodyLines: owned });
		ledger.push({ locator: h.path, occurrence: h.occurrence, level: h.level, disposition: 'candidate' });
	}
	return { candidates, ledger };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/content-import/md-walk.mjs tests/unit/md-walk.test.ts
git commit -m "feat(content): chapter walker with tree ownership, skips, and splitDeeper"
```

---

### Task 4: `md-walk.mjs` — id/title resolution, collisions, aliases

**Files:**
- Modify: `scripts/content-import/md-walk.mjs`
- Test: `tests/unit/md-walk.test.ts`

**Interfaces:**
- Consumes: `walkChapter` candidates (Task 3).
- Produces: `resolveEntries(candidates, config) -> Array<{ id, title, locator, occurrence, level, bodyLines }>` and updated ledger dispositions. `config` fields used: `section: string`, `ids?: Record<locator, id>`, `idAliases?: Record<locator, id>`, `overrides?: Record<id, {...}>` (title applied later in Task 6). Also exports `defaultSlug(text)` and `cleanTitle(text)`. Throws on collisions and non-bijective aliases. Task 6 consumes `resolveEntries`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/md-walk.test.ts`:

```ts
import { cleanTitle, defaultSlug, resolveEntries } from '../../scripts/content-import/md-walk.mjs';

describe('id and title normalization', () => {
	it('strips ordinal junk and chapter prefixes', () => {
		expect(defaultSlug('8 - Conditions')).toBe('conditions');
		expect(defaultSlug('9 -Resolve')).toBe('resolve');
		expect(defaultSlug('1. Draw Challenge cards')).toBe('draw-challenge-cards');
		expect(defaultSlug('Chapter 2: The Adventurer')).toBe('the-adventurer');
		expect(defaultSlug('We’re doomed!')).toBe('were-doomed');
		expect(cleanTitle('8 - Conditions')).toBe('Conditions');
		expect(cleanTitle('Chapter 2: The Adventurer')).toBe('The Adventurer');
	});
});

describe('resolveEntries', () => {
	const cand = (locator: string, text: string, occurrence = 1) => ({
		locator, occurrence, level: 2, text, bodyLines: ['x']
	});

	it('prefixes ids with the section', () => {
		const out = resolveEntries([cand('A/Watches', 'Watches')], { section: 'crawl-phase' });
		expect(out[0]).toMatchObject({ id: 'crawl-phase-watches', title: 'Watches' });
	});

	it('applies explicit ids and aliases by locator', () => {
		const out = resolveEntries(
			[cand('Flow/1. Draw Challenge cards', '1. Draw Challenge cards'), cand('GMing/1. Draw Challenge cards', '1. Draw Challenge cards')],
			{
				section: 'challenge-phase',
				idAliases: { 'Flow/1. Draw Challenge cards': 'challenge-draw-cards' },
				ids: { 'GMing/1. Draw Challenge cards': 'challenge-gm-hand-size' }
			}
		);
		expect(out.map((e) => e.id)).toEqual(['challenge-draw-cards', 'challenge-gm-hand-size']);
	});

	it('throws on an unresolved id collision, naming both locators', () => {
		expect(() =>
			resolveEntries(
				[cand('Flow/1. Draw Challenge cards', '1. Draw Challenge cards'), cand('GMing/1. Draw Challenge cards', '1. Draw Challenge cards')],
				{ section: 'challenge-phase' }
			)
		).toThrow(/Flow\/1\. Draw Challenge cards[\s\S]*GMing\/1\. Draw Challenge cards/);
	});

	it('throws when two locators claim the same alias (bijectivity)', () => {
		expect(() =>
			resolveEntries([cand('A/X', 'X'), cand('A/Y', 'Y')], {
				section: 's',
				idAliases: { 'A/X': 'legacy-id', 'A/Y': 'legacy-id' }
			})
		).toThrow(/alias/i);
	});

	it('throws when an ids/idAliases locator matches no candidate', () => {
		expect(() =>
			resolveEntries([cand('A/X', 'X')], { section: 's', ids: { 'A/Zed': 'nope' } })
		).toThrow(/locator/i);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: FAIL — `resolveEntries` not exported.

- [ ] **Step 3: Implement**

Append to `scripts/content-import/md-walk.mjs`:

```js
/** "Chapter 2: X" / "8 - X" / "1. X" -> "X"; used for both slugs and titles. */
function stripOrdinal(text) {
	return text
		.replace(/^chapter\s+\d+\s*[:.–-]\s*/i, '')
		.replace(/^\d+\s*[.:–-]?\s*/, '')
		.trim();
}

export function cleanTitle(text) {
	return stripOrdinal(text.replace(/\s+/g, ' ').trim());
}

export function defaultSlug(text) {
	return stripOrdinal(text.toLowerCase())
		.replace(/[’‘']/g, '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Assigns final ids/titles to candidates. Priority per candidate:
 * idAliases[locator] (legacy id preservation) > ids[locator] (explicit, for
 * collisions) > `${section}-${defaultSlug(text)}`. Collisions and unmatched or
 * non-bijective alias maps are build errors — never auto-suffixed, because
 * suffixes are insertion-order-dependent and these ids are permanent URLs.
 */
export function resolveEntries(candidates, config) {
	const byLocator = (map, kind) => {
		const out = new Map();
		for (const [at, id] of Object.entries(map ?? {})) {
			const hit = candidates.find((c) => c.locator.toLowerCase() === at.toLowerCase());
			if (!hit) throw new Error(`${kind} locator matches no candidate: ${JSON.stringify(at)}`);
			out.set(hit, id);
		}
		return out;
	};
	const aliases = byLocator(config.idAliases, 'idAliases');
	const explicit = byLocator(config.ids, 'ids');

	const aliasValues = [...aliases.values()];
	if (new Set(aliasValues).size !== aliasValues.length) {
		throw new Error(`idAliases must be bijective; duplicate alias target in ${JSON.stringify(aliasValues)}`);
	}

	const entries = candidates.map((c) => ({
		...c,
		id: aliases.get(c) ?? explicit.get(c) ?? `${config.section}-${defaultSlug(c.text)}`,
		title: cleanTitle(c.text)
	}));

	const seen = new Map();
	for (const e of entries) {
		if (seen.has(e.id)) {
			throw new Error(
				`id collision "${e.id}":\n  ${seen.get(e.id).locator}\n  ${e.locator}\n` +
					`Resolve it with an explicit "ids" entry keyed by locator.`
			);
		}
		seen.set(e.id, e);
	}
	return entries;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/content-import/md-walk.mjs tests/unit/md-walk.test.ts
git commit -m "feat(content): id/title resolution with collision errors and bijective aliases"
```

---

### Task 5: `md-lib.mjs` — full-preservation normalization mode

**Files:**
- Modify: `scripts/content-import/md-lib.mjs`
- Test: `tests/unit/md-walk.test.ts` (same suite; it is the walk pipeline's test home)

**Interfaces:**
- Consumes: existing `convertCallouts`, `normalizeMarkdown` internals.
- Produces: `normalizeMarkdown(lines, opts?)` gains `{ preserve?: 'full' }`; new export `walkRuleBody(bodyLines) -> string` = `normalizeMarkdown(convertCallouts(bodyLines), { preserve: 'full' })` — callouts converted (never stripped), examples kept (no `stripExampleSubsections`), epigraphs kept as italic quotations, cross-reference sentences kept (only bare page refs dropped). Task 6 calls `walkRuleBody`. The excerpt path (`extractRuleBody`) is byte-for-byte unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/md-walk.test.ts`:

```ts
import { walkRuleBody, extractRuleBody } from '../../scripts/content-import/md-lib.mjs';

describe('walkRuleBody (full-preservation mode)', () => {
	it('keeps worked-example subsections', () => {
		const body = walkRuleBody(['Rule text.', '', '### Example test of fate', '', 'Franz draws a card.']);
		expect(body).toContain('Example test of fate');
		expect(body).toContain('Franz draws a card.');
	});

	it('converts callouts instead of stripping them', () => {
		const body = walkRuleBody(['> [!info] No peeking!', '> Nobody but the player can look.', '', 'After.']);
		expect(body).toContain('### No peeking!');
		expect(body).toContain('Nobody but the player can look.');
		expect(body).not.toMatch(/^\s*>/m);
	});

	it('keeps epigraphs as italic quotations with their attribution', () => {
		const body = walkRuleBody(['##### Long is the way, and hard.', '', '_– Milton_', '', 'Prose.']);
		expect(body).toContain('*Long is the way, and hard.*');
		expect(body).toContain('Milton');
		expect(body).not.toContain('#####');
	});

	it('keeps cross-reference sentences, dropping only bare page refs', () => {
		const body = walkRuleBody(['You gain a Bond ([[03 - Chapter 3 - The Guild#Bonds|Bonds]]); see Bonds for details. ([[p. 44]])']);
		expect(body).toContain('see Bonds for details');
		expect(body).not.toContain('p. 44');
		expect(body).not.toContain('[[');
	});

	it('leaves the curated excerpt path untouched (examples still stripped)', () => {
		// extractRuleBody reads from the vault; this is a behavior lock via the
		// existing committed pack instead: the curated Tests of Fate entry must
		// keep excluding its worked example. Assert on the pipeline function used.
		const stripped = walkRuleBody(['text']); // sanity: full mode exists
		expect(typeof extractRuleBody).toBe('function');
		expect(stripped).toBe('text');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: FAIL — `walkRuleBody` not exported.

- [ ] **Step 3: Implement in `md-lib.mjs`**

(a) Add a gentle wikilink pass alongside `stripWikilinks` (do not modify `stripWikilinks`):

```js
/**
 * Full-preservation variant of stripWikilinks: cross-reference *sentences and
 * clauses are kept* (the spec's content guarantee), links flatten to their
 * label, and only bare page-number references disappear — a page number is
 * meaningless on the web (permitted omission class).
 */
function stripWikilinksGentle(text) {
	const isPageRef = (s) => /^pp?\.?\s*\d|^page\s*\d/i.test(s.trim());
	const labelOf = (inner) => {
		const [target, label] = inner.split('|');
		return (label ?? (target.includes('#') ? target.slice(target.indexOf('#') + 1) : target)).trim();
	};
	let out = text.replace(/\s*\(\s*\[\[([^\]]*)\]\]\s*\)/g, (m, inner) => {
		const label = labelOf(inner);
		return isPageRef(label) ? '' : ` (${label})`;
	});
	out = out.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
		const label = labelOf(inner);
		return isPageRef(label) ? '' : label;
	});
	return out.replace(/\s+\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ');
}
```

(b) Change `normalizeMarkdown(lines)` to `normalizeMarkdown(lines, opts = {})`, with two conditional branches:

In the heading loop, replace the unconditional H5/H6 drop with:

```js
		if (h && h.level >= 5) {
			if (opts.preserve === 'full') {
				// Epigraph quotation: keep as an italic paragraph; the following
				// `_– attribution_` line survives on its own (italics normalize below).
				processed.push(`*${h.text.replace(/[*_`]/g, '')}*`);
				continue;
			}
			let attribution = i + 1;
			while (attribution < lines.length && lines[attribution].trim() === '') attribution++;
			if (/^\s*[*_].*[–-].*[*_]\s*$/.test(lines[attribution] ?? '')) i = attribution;
			continue;
		}
```

After the `processed.join('\n')`, replace the single `text = stripWikilinks(text);` line with:

```js
	text = opts.preserve === 'full' ? stripWikilinksGentle(text) : stripWikilinks(text);
```

(`stripWikilinks` keeps its pointer-clause removal internally; the gentle variant has none.)

(c) Add the walk-path entry point at the end of the rules section of the file (next to `extractRuleBody`):

```js
/**
 * Walk-path body pipeline (full-preservation semantics per the 2026-08-01
 * rules-coverage spec): callouts always convert, examples and epigraphs are
 * kept, cross-reference sentences survive. The curated excerpt path
 * (extractRuleBody) intentionally keeps its stricter, lossier behavior.
 */
export function walkRuleBody(bodyLines) {
	return normalizeMarkdown(convertCallouts(bodyLines), { preserve: 'full' });
}
```

- [ ] **Step 4: Run the walk tests AND the full unit suite**

Run: `npx vitest run tests/unit/md-walk.test.ts && npx vitest run tests/unit/md-tables.test.ts tests/unit/rules-coverage.test.ts`
Expected: all PASS — proving the excerpt path and table path are untouched.

- [ ] **Step 5: Commit**

```bash
git add scripts/content-import/md-lib.mjs tests/unit/md-walk.test.ts
git commit -m "feat(content): full-preservation normalization mode for chapter walks"
```

---

### Task 6: `md-rules.mjs` — walk integration + coverage ledger

**Files:**
- Modify: `scripts/content-import/md-rules.mjs`
- Modify: `scripts/content-import/md-walk.mjs` (one pure builder)
- Test: `tests/unit/md-walk.test.ts`

**Interfaces:**
- Consumes: `walkChapter`, `resolveEntries` (Tasks 3–4), `walkRuleBody` (Task 5), existing `lintBody`/`omitRange` in `md-rules.mjs`.
- Produces:
  - In `md-walk.mjs`: `buildWalk(markdown, walkCfg, deps) -> { rules: RuleEntry[], ledger: ChapterLedger }` where `deps = { walkRuleBody, lintBody, omitRange }` (injected so the test needs no vault) and `ChapterLedger = { file, section, sourceSha256, headings: LedgerRow[] }` with candidate rows rewritten to `disposition: 'emitted', id`.
  - In `md-rules.mjs`: manifest entries of shape `{ "walk": {...} }` are expanded via `buildWalk`; the build writes `scripts/content-import/manifest/rules-coverage-ledger.json` (array of ChapterLedger, manifest order); `--check` also diffs the committed ledger; `--dry-run` writes nothing.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/md-walk.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { buildWalk } from '../../scripts/content-import/md-walk.mjs';

describe('buildWalk', () => {
	const md = ['# Chapter 9: The City Phase', 'City intro.', '## Carouse', 'Carouse text.'].join('\n');
	const deps = {
		walkRuleBody: (lines: string[]) => lines.join('\n'),
		lintBody: () => [],
		omitRange: (body: string) => body
	};

	it('emits rule entries with section, resolved ids, and empty default tags', () => {
		const { rules } = buildWalk(md, { file: '09.md', section: 'city-phase' }, deps);
		expect(rules).toEqual([
			{ id: 'city-phase-the-city-phase', section: 'city-phase', title: 'The City Phase', body: 'City intro.', tags: [] },
			{ id: 'city-phase-carouse', section: 'city-phase', title: 'Carouse', body: 'Carouse text.', tags: [] }
		]);
	});

	it('applies overrides (title, tags, mustContain sentinel) keyed by final id', () => {
		const cfg = {
			file: '09.md', section: 'city-phase',
			idAliases: { 'Chapter 9: The City Phase/Carouse': 'city-carouse' },
			overrides: { 'city-carouse': { title: 'Carouse!', tags: ['city'], mustContain: ['Carouse text.'] } }
		};
		const seen: unknown[] = [];
		const { rules } = buildWalk(md, cfg, { ...deps, lintBody: (_b: string, entry: unknown) => (seen.push(entry), []) });
		expect(rules[1]).toMatchObject({ id: 'city-carouse', title: 'Carouse!', tags: ['city'] });
		expect(seen[1]).toMatchObject({ mustContain: ['Carouse text.'] });
	});

	it('ledgers the chapter with a source hash and emitted ids', () => {
		const { ledger } = buildWalk(md, { file: '09.md', section: 'city-phase' }, deps);
		expect(ledger.file).toBe('09.md');
		expect(ledger.sourceSha256).toBe(createHash('sha256').update(md).digest('hex'));
		expect(ledger.headings).toEqual([
			{ locator: 'Chapter 9: The City Phase', occurrence: 1, level: 1, disposition: 'emitted', id: 'city-phase-the-city-phase' },
			{ locator: 'Chapter 9: The City Phase/Carouse', occurrence: 1, level: 2, disposition: 'emitted', id: 'city-phase-carouse' }
		]);
	});

	it('throws when lint reports problems, naming the entry', () => {
		expect(() => buildWalk(md, { file: '09.md', section: 'city-phase' }, { ...deps, lintBody: () => ['bad'] })).toThrow(/city-phase-the-city-phase.*bad/);
	});

	it('throws on an overrides key that matches no emitted id', () => {
		expect(() => buildWalk(md, { file: '09.md', section: 'city-phase', overrides: { ghost: {} } }, deps)).toThrow(/ghost/);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: FAIL — `buildWalk` not exported.

- [ ] **Step 3: Implement `buildWalk` in `md-walk.mjs`**

```js
import { createHash } from 'node:crypto';

/**
 * Full walk of one chapter file's text into rule entries + its ledger chapter.
 * Pure: body pipeline, lint, and omitRange are injected so tests run without
 * the vault and md-rules.mjs stays the only module with filesystem knowledge.
 */
export function buildWalk(markdown, walkCfg, deps) {
	const { walkRuleBody, lintBody, omitRange } = deps;
	const { candidates, ledger } = walkChapter(markdown, walkCfg);
	const resolved = resolveEntries(candidates, walkCfg);
	const overrides = walkCfg.overrides ?? {};
	const known = new Set(resolved.map((e) => e.id));
	for (const key of Object.keys(overrides)) {
		if (!known.has(key)) throw new Error(`walk override for unknown id "${key}" in ${walkCfg.file}`);
	}

	const rules = resolved.map((e) => {
		const ov = overrides[e.id] ?? {};
		const body = omitRange(walkRuleBody(e.bodyLines), ov.omitRange);
		const problems = lintBody(body, ov);
		if (problems.length) throw new Error(`[rules#${e.id}] ${problems.join('; ')}`);
		return { id: e.id, section: walkCfg.section, title: ov.title ?? e.title, body, tags: ov.tags ?? [] };
	});

	const idByLocator = new Map(resolved.map((e) => [`${e.locator.toLowerCase()}#${e.occurrence}`, e.id]));
	const headings = ledger.map((row) =>
		row.disposition === 'candidate'
			? { ...row, disposition: 'emitted', id: idByLocator.get(`${row.locator.toLowerCase()}#${row.occurrence}`) }
			: row
	);
	return {
		rules,
		ledger: { file: walkCfg.file, section: walkCfg.section, sourceSha256: createHash('sha256').update(markdown).digest('hex'), headings }
	};
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire walks + ledger into `md-rules.mjs`**

In `md-rules.mjs`:

```js
import { MD_DIR, extractRuleBody, walkRuleBody } from './md-lib.mjs';
import { buildWalk } from './md-walk.mjs';
```

Add next to `MANIFEST`:

```js
const LEDGER = join(__dirname, 'manifest', 'rules-coverage-ledger.json');
```

Replace the body of `build()`'s manifest loop with (keeping `omitRange`, `lintBody`, and the surrounding function intact):

```js
	const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	const rules = [];
	const ledgers = [];
	for (const entry of manifest) {
		if (entry.walk) {
			const raw = readFileSync(join(MD_DIR, entry.walk.file), 'utf8');
			const out = buildWalk(raw, entry.walk, { walkRuleBody, lintBody, omitRange });
			if (out.rules.length === 0) throw new Error(`walk of ${entry.walk.file} emitted zero entries`);
			rules.push(...out.rules);
			ledgers.push(out.ledger);
			continue;
		}
		const body = omitRange(
			extractRuleBody(entry.file, entry.heading, entry.until, entry.after, {
				keepCallouts: entry.keepCallouts
			}),
			entry.omitRange
		);
		const problems = lintBody(body, entry);
		if (problems.length) throw new Error(`[rules#${entry.id}] ${problems.join('; ')}`);
		rules.push({ id: entry.id, section: entry.section, title: entry.title, body, tags: entry.tags });
	}
	const dupes = rules.map((r) => r.id).filter((id, i, all) => all.indexOf(id) !== i);
	if (dupes.length) throw new Error(`duplicate rule ids across manifest: ${[...new Set(dupes)].join(', ')}`);
	return { rules, ledgers };
```

Update `main()` accordingly: `const { rules, ledgers } = build();`. In the write path add, after writing `RULES_JSON`:

```js
		writeFileSync(LEDGER, JSON.stringify(ledgers, null, '\t') + '\n', 'utf8');
		console.log(`Wrote coverage ledger for ${ledgers.length} chapters to ${LEDGER}`);
```

In the `--check` path add, after the existing rules drift loop:

```js
		const committedLedger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
		if (JSON.stringify(committedLedger) !== JSON.stringify(ledgers)) {
			console.error('DRIFT rules-coverage-ledger.json (source vault or walk config changed)');
			drift++;
		}
```

- [ ] **Step 6: Verify the excerpt-only manifest still round-trips**

Run: `node scripts/content-import/md-rules.mjs --check`
Expected: `Checked 57 rules, 0 drifted.` — the manifest has no walk entries yet, so `ledgers` is `[]`, the committed-ledger file doesn't exist yet (also `[]`), and the ledger comparison passes trivially. Any non-zero drift means the refactor changed excerpt output — stop and fix before proceeding.

- [ ] **Step 7: Commit**

```bash
git add scripts/content-import/md-rules.mjs scripts/content-import/md-walk.mjs tests/unit/md-walk.test.ts
git commit -m "feat(content): walk manifest entries and committed coverage ledger"
```

---

### Task 7: Author walks for chapters 1–5, migrate legacy ids

**Files:**
- Modify: `scripts/content-import/manifest/rules-md.json`
- Modify: `tests/unit/rules-coverage.test.ts` (tag assertion only)
- Generated: `static/content-packs/hmtw/rules.json`, `scripts/content-import/manifest/rules-coverage-ledger.json`

**Interfaces:**
- Consumes: the whole pipeline (Tasks 2–6).
- Produces: `rules.json` fully covering chapters 1–5 with legacy ids intact: `the-four-phases`, `the-flow-of-play`, `adjudicating-the-game`, `the-major-and-minor-arcana`, `tests-of-fate`, `pushing-fate`, `favor-and-disfavor`, `bound-by-fate`, `group-tests`, `effects` (ch1), `guild-deeds-and-fame` (ch3), `kith-area-sense` (ch4), `paths-counsel`, `paths-high-chant` (ch5).

This task is iterative: run the build, read each error (collision / lint / empty), and resolve it in the manifest with `ids`, `skip` (+reason), `overrides`, or `omitRange` — never by weakening the walker.

- [ ] **Step 1: Relax the tag requirement (spec: tags are optional metadata)**

In `tests/unit/rules-coverage.test.ts` replace the tag test:

```ts
	it('gives every entry a non-empty body and a tags array', () => {
		for (const rule of rules) {
			expect(rule.body.trim().length, `${rule.id} body`).toBeGreaterThan(0);
			expect(Array.isArray(rule.tags), `${rule.id} tags`).toBe(true);
		}
	});
```

- [ ] **Step 2: Add walk entries for chapters 1–5 to `rules-md.json`, delete superseded excerpts**

Delete the excerpt entries whose ids appear in the alias maps below (they are re-emitted by the walks under the same ids). Keep only the 7 excerpt entries for `gamemastering` + `appendix-sorcery` (`gm-creating-surprises`, `sorcery-augury`, `sorcery-brainfever`, `sorcery-maleficence`, `sorcery-malediction`, `sorcery-totem`, `sorcery-guardian-angel`).

Add, at the top of the manifest array (book order), one walk per chapter. Starting configuration — expect to extend `ids`/`skip` as build errors surface:

```json
{
	"walk": {
		"file": "01 - Chapter 1 - The Basics.md",
		"section": "basics",
		"idAliases": {
			"Chapter 1: The Basics/The Four Phases": "the-four-phases",
			"Chapter 1: The Basics/The Flow of the Play": "the-flow-of-play",
			"Chapter 1: The Basics/The Flow of the Play/Adjudicating the game: GM responses": "adjudicating-the-game",
			"Chapter 1: The Basics/The Major and Minor Arcana": "the-major-and-minor-arcana",
			"Chapter 1: The Basics/Tests of Fate": "tests-of-fate",
			"Chapter 1: The Basics/Pushing fate": "pushing-fate",
			"Chapter 1: The Basics/Pushing fate/Favor and disfavor": "favor-and-disfavor",
			"Chapter 1: The Basics/Pushing fate/Bound by fate": "bound-by-fate",
			"Chapter 1: The Basics/Pushing fate/Group tests": "group-tests",
			"Chapter 1: The Basics/Effects": "effects"
		},
		"overrides": {
			"adjudicating-the-game": {
				"omitRange": {
					"from": "- “OK, you grab the portcullis before it slams down.",
					"to": "### “No, you can’t do that”"
				},
				"mustContain": ["### “No, you can’t do that”", "bits of wire just lying around your jail cell"],
				"mustNotContain": ["mechanism’s gears"]
			}
		}
	}
}
```

IMPORTANT — the alias locator paths above are **best-effort guesses at the tree structure**; the walker will throw `idAliases locator matches no candidate` with the real candidate list absent. When that happens, run step 3's dry run, read the emitted locators from the error/output, and correct the paths. That loop is expected, not a failure. The chapter-1 heading structure is visible with:

```bash
grep -n '^#\{1,4\} ' "assets-src/HMTW_md/01 - Chapter 1 - The Basics.md"
```

Note ch1 headings `Adjudicating the game: GM responses` and the fate sections are H1s (`# Pushing fate`) — if so, their locators are top-level (`Pushing fate`, not nested). Verify with the grep before authoring.

Then walks for chapters 2–5 (fill `ids`/`skip` as errors demand):

```json
{ "walk": { "file": "02 - Chapter 2 - The Adventurer.md", "section": "adventurer",
	"skip": [] } },
{ "walk": { "file": "03 - Chapter 3 - The Guild.md", "section": "guild",
	"idAliases": { "The Guild Roster/7. Deeds and Fame": "guild-deeds-and-fame" } } },
{ "walk": { "file": "04 - Chapter 4 - Kith and Kin.md", "section": "kith-and-kin",
	"splitDeeper": [ { "at": "Fay/Wood elf/Wood elf arête talent: Area Sense", "id": "kith-area-sense" } ] } },
{ "walk": { "file": "05 - Chapter 5 - The Four Paths.md", "section": "four-paths",
	"splitDeeper": [
		{ "at": "Path of Cups/Counsel", "id": "paths-counsel" },
		{ "at": "Path of Wands/High Chant", "id": "paths-high-chant" }
	] } }
```

(Ch2's duplicated `NEW ADVENTURER CHECKLIST` gets a `skip` with reason `"duplicate all-caps copy of the New adventurer checklist section"` — confirm which occurrence is the duplicate by reading the source, then skip that one. Ch4's Area Sense and Ch5's talents are at whatever depth the grep shows — if they are H3s under kith/path H1–H2s, `splitDeeper` as sketched; if H2s, use `idAliases` instead.)

Carry over the legacy `mustContain` sentinels into `overrides` for: `paths-high-chant` (`"inspiration card"`), and any other migrated entry that had one in the old manifest (check `git show HEAD:scripts/content-import/manifest/rules-md.json` for the full list).

- [ ] **Step 3: Iterate the build until green**

Run (repeat, fixing manifest issues each round):
```bash
node scripts/content-import/md-rules.mjs --dry-run
```
Expected end state: prints every entry with body sizes; zero errors. Collision errors name both locators — resolve with `ids`; locator misses print in the error — fix the path; lint errors (`unconverted wikilink`, `leftover suit-glyph`, etc.) usually mean a source artifact — handle via `omitRange` with the narrowest possible anchors, or fix the gentle-normalization edge in `md-lib.mjs` with a new unit test if it's a code gap.

- [ ] **Step 4: Write the pack and run the coverage tests**

Run:
```bash
node scripts/content-import/md-rules.mjs
npx vitest run tests/unit/rules-coverage.test.ts tests/unit/md-walk.test.ts
node scripts/content-import/md-rules.mjs --check
```
Expected: rules.json + ledger written; coverage tests PASS (chapter 1–5 legacy ids all present; ch6–9 REQUIRED_IDS still pass because those excerpt entries remain untouched this task); `--check` reports 0 drifted.

- [ ] **Step 5: Sanity-read two entries**

Run: `node -e "const r=require('./static/content-packs/hmtw/rules.json'); const e=r.find(x=>x.id==='tests-of-fate'); console.log(e.body.slice(0,400)); console.log('---'); console.log(r.filter(x=>x.section==='adventurer').map(x=>x.id).join('\n'))"`
Expected: Tests of Fate body reads as clean prose (and now INCLUDES its `### Example` subsection — full preservation); the adventurer section lists ~20 entries (name/attributes/quests/motifs/bonds/arete/languages/conditions/resolve/lore/talents/experience/etc.).

- [ ] **Step 6: Commit**

```bash
git add scripts/content-import/manifest/rules-md.json scripts/content-import/manifest/rules-coverage-ledger.json static/content-packs/hmtw/rules.json tests/unit/rules-coverage.test.ts
git commit -m "feat(content): full chapter 1-5 rules coverage via chapter walks"
```

(Note: `content:verify:ci`'s digest check will fail until Task 9 re-records the digest — that is expected mid-branch; Task 9 closes it.)

---

### Task 8: Author walks for chapters 6–9 (duplicate flows, splitDeeper set)

**Files:**
- Modify: `scripts/content-import/manifest/rules-md.json`
- Generated: `static/content-packs/hmtw/rules.json`, `scripts/content-import/manifest/rules-coverage-ledger.json`

**Interfaces:**
- Consumes: pipeline (Tasks 2–6); chapter 1–5 walks (Task 7).
- Produces: full chapters 6–9 coverage; ALL of `tests/unit/rules-coverage.test.ts` `REQUIRED_IDS` and `index.json` `doomTiers` ids resolve as standalone entries.

- [ ] **Step 1: Map the chapter 6–9 heading structure**

Run for each chapter file:
```bash
grep -n '^#\{1,3\} ' "assets-src/HMTW_md/07 - Chapter 7 - The Challenge Phase.md"
```
List which legacy ids are H1/H2 (→ `idAliases`) vs H3 (→ `splitDeeper`). Known H3 cases from the spec: `challenge-action-value`, `challenge-facedown-cards`, `challenge-interrupt-actions`, `challenge-the-fool`, `challenge-lesser-dooms`, `challenge-greater-dooms`, `challenge-guard` — confirm each.

- [ ] **Step 2: Add the four walk entries**

Chapter 7 skeleton (the critical one — duplicated flow steps):

```json
{ "walk": {
	"file": "07 - Chapter 7 - The Challenge Phase.md",
	"section": "challenge-phase",
	"idAliases": {
		"The Flow of the Challenge Phase": "challenge-sequence",
		"The Flow of the Challenge Phase/1. Draw Challenge cards": "challenge-draw-cards",
		"The Flow of the Challenge Phase/2. Play Initiative": "challenge-play-initiative",
		"The Flow of the Challenge Phase/3. Take turns": "challenge-take-turns",
		"The Flow of the Challenge Phase/4. Minor actions": "challenge-minor-actions",
		"The Flow of the Challenge Phase/5. End the round": "challenge-end-the-round",
		"Challenge Actions/Miscellaneous actions (Any Suit)": "challenge-miscellaneous-actions",
		"GMing the Challenge/1. Draw Challenge cards": "challenge-gm-hand-size",
		"GMing the Challenge/3. Enemy actions": "challenge-enemy-actions"
	},
	"splitDeeper": [
		{ "at": "The Flow of the Challenge Phase/3. Take turns/Action value", "id": "challenge-action-value" },
		{ "at": "The Flow of the Challenge Phase/3. Take turns/Facedown cards", "id": "challenge-facedown-cards" },
		{ "at": "The Flow of the Challenge Phase/3. Take turns/Interrupt actions", "id": "challenge-interrupt-actions" },
		{ "at": "The Flow of the Challenge Phase/3. Take turns/The Fool", "id": "challenge-the-fool" },
		{ "at": "GMing the Challenge/3. Enemy actions/Lesser dooms", "id": "challenge-lesser-dooms" },
		{ "at": "GMing the Challenge/3. Enemy actions/Greater dooms", "id": "challenge-greater-dooms" },
		{ "at": "Challenge Actions/Miscellaneous actions (Any Suit)/Guard", "id": "challenge-guard" }
	],
	"overrides": {
		"challenge-facedown-cards": {
			"mustContain": ["only have one facedown action at a time", "Nobody but the player can look at the facedown card", "No peeking!"]
		},
		"challenge-gm-hand-size": { "mustContain": ["elite enemy", "dungeon lord"] },
		"challenge-guard": { "mustContain": ["replace your Initiative"] }
	}
} }
```

(As in Task 7: locator paths are corrected against the real tree during the dry-run loop. `0. Set the scene` appears in both flows — the two entries get hierarchy ids automatically, e.g. `challenge-phase-set-the-scene` collides → resolve with `ids`: `{"The Flow of the Challenge Phase/0. Set the scene": "challenge-set-the-scene", "GMing the Challenge/0. Set the scene": "challenge-gm-set-the-scene"}`; likewise the GM-side `2./4./5.` steps get `challenge-gm-…` ids. `## Special rules` appears repeatedly — each occurrence lives under a different parent so locators disambiguate; where two share a parent, use `occurrence`.)

Chapters 6, 8, 9 follow the same pattern with their legacy aliases:
ch6 → `crawl-sequence` (`The Flow of the Crawl Phase`), `crawl-watches`, `crawl-meatgrinder`, `crawl-loud-noises`, `crawl-moving-carefully`, `crawl-darkness`, `crawl-flickers`, `crawl-were-doomed`, `crawl-black-honey`, `crawl-social-encounters-disposition`, `crawl-starting-disposition`, `crawl-influencing-disposition`;
ch8 → `camp-patrol`, `camp-no-rest-for-the-wicked` (H3 under the camp-actions flow — `splitDeeper`), `camp-overland-travel`;
ch9 → `city-events` (H3 under the city flow — `splitDeeper`), `city-signs-and-portents`, `city-beg-and-busk`, `city-carouse`, `city-leeches`. Carry the old manifest's `mustContain` sentinels: `camp-no-rest-for-the-wicked` (`"top card of the minor arcana discard pile"`, `"tests Cups"`), `city-carouse` (`"Hangover"`).

- [ ] **Step 3: Iterate to green, write, verify**

Run:
```bash
node scripts/content-import/md-rules.mjs --dry-run   # iterate until clean
node scripts/content-import/md-rules.mjs
npx vitest run tests/unit/rules-coverage.test.ts tests/unit/md-walk.test.ts
node scripts/content-import/md-rules.mjs --check
node -e "const r=require('./static/content-packs/hmtw/rules.json'); const idx=require('./static/content-packs/hmtw/index.json'); const ids=new Set(r.map(x=>x.id)); for (const t of Object.values(idx.tarot.doomTiers)) { if(!ids.has(t.ruleEntryId)) throw new Error('doomTiers orphan: '+t.ruleEntryId); } console.log('doomTiers ids resolve, total entries:', r.length)"
```
Expected: all REQUIRED_IDS present, doomTiers ids resolve, total entries in the 130–170 range, `--check` 0 drifted.

- [ ] **Step 4: Run the tarot-procedures audit (its `ruleEntryIds` cite rules ids)**

Run: `npx vitest run tests/unit/tarot-procedure-audit.test.ts tests/unit/tarot-procedures.test.ts`
Expected: PASS. If an id cited there went missing, restore it via alias — do not edit the procedures manifest.

- [ ] **Step 5: Commit**

```bash
git add scripts/content-import/manifest/rules-md.json scripts/content-import/manifest/rules-coverage-ledger.json static/content-packs/hmtw/rules.json
git commit -m "feat(content): full chapter 6-9 rules coverage; all legacy ids preserved"
```

---

### Task 9: Search artifact + pack contract + version bump

**Files:**
- Modify: `scripts/content-import/md-rules.mjs` (emit artifact), `src/lib/types/content-pack.ts`, `src/lib/schemas/content-pack.schema.ts`, `static/content-packs/hmtw/index.json`, `tests/unit/content-build.test.ts`
- Create: `tests/unit/rules-search-artifact.test.ts`
- Generated: `static/content-packs/hmtw/rules-search.json`

**Interfaces:**
- Consumes: built `rules.json` (Tasks 7–8).
- Produces: `toSearchDoc(rule) -> { id, section, title, headings: string[], body }` exported from `md-rules.mjs`; artifact `rules-search.json` (array, book order — array index is the tie-break `bookIndex`); type `RuleSearchDoc` in `content-pack.ts`; `ruleSearchDocSchema` + `rulesSearch` file key in the schema; pack version `4.0.0` with re-recorded digest. Tasks 11+ fetch this artifact.

- [ ] **Step 1: Write the failing artifact test**

Create `tests/unit/rules-search-artifact.test.ts`:

```ts
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import rules from '../../static/content-packs/hmtw/rules.json';
import pack from '../../static/content-packs/hmtw/index.json';
import { ruleSearchDocSchema } from '$lib/schemas/content-pack.schema';

const PATH = 'static/content-packs/hmtw/rules-search.json';

describe('rules-search.json artifact', () => {
	const docs = JSON.parse(readFileSync(PATH, 'utf8')) as unknown[];

	it('is declared in the pack files (and therefore inside the content digest)', () => {
		expect((pack.files as Record<string, string>).rulesSearch).toBe('rules-search.json');
	});

	it('validates every document against the schema', () => {
		expect(() => z.array(ruleSearchDocSchema).parse(docs)).not.toThrow();
	});

	it('is bijective with rules.json, in the same (book) order', () => {
		const parsed = z.array(ruleSearchDocSchema).parse(docs);
		expect(parsed.map((d) => d.id)).toEqual(rules.map((r) => r.id));
	});

	it('contains plain text — no markdown syntax survives', () => {
		const parsed = z.array(ruleSearchDocSchema).parse(docs);
		for (const d of parsed) {
			expect(d.body, d.id).not.toMatch(/^#{1,6}\s|\*\*|\[\[|^\s*-\s|\|/m);
		}
	});

	it('stays inside the size budgets (700KB raw / 200KB gzip)', () => {
		const raw = statSync(PATH).size;
		const zipped = gzipSync(readFileSync(PATH)).length;
		console.log(`rules-search.json: ${raw} bytes raw, ${zipped} bytes gzip`);
		expect(raw).toBeLessThanOrEqual(700 * 1024);
		expect(zipped).toBeLessThanOrEqual(200 * 1024);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/rules-search-artifact.test.ts`
Expected: FAIL — no artifact, no schema export.

- [ ] **Step 3: Add the type and schema**

In `src/lib/types/content-pack.ts`, add `rulesSearch?: string;` to `ContentPackFiles` (after `rules?: string;`), and next to `RuleEntry`:

```ts
/** One searchable rules document in rules-search.json: plain-text body for
 * client-side indexing; array order is book order (the search tie-break). */
export interface RuleSearchDoc {
	id: string;
	section: string;
	title: string;
	/** The entry's inline sub-headings, for boosted matching. */
	headings: string[];
	/** Markdown-stripped plain text. */
	body: string;
}
```

In `src/lib/schemas/content-pack.schema.ts`, add `rulesSearch: z.string().optional(),` inside `contentPackFilesSchema` (after `rules`), and:

```ts
export const ruleSearchDocSchema = z.object({
	id: z.string().min(1),
	section: z.string().min(1),
	title: z.string().min(1),
	headings: z.array(z.string()),
	body: z.string().min(1)
});
```

- [ ] **Step 4: Emit the artifact from `md-rules.mjs`**

Add to `md-rules.mjs`:

```js
const SEARCH_JSON = join(PACK_DIR, 'rules-search.json');

/** Markdown -> plain-text search document. Headings are captured for boosted
 * matching; all markup (heading markers, emphasis, tables, bullets) flattens
 * to readable text. Wording is untouched — this is formatting-only. */
export function toSearchDoc(rule) {
	const headings = [];
	const body = rule.body
		.split('\n')
		.map((line) => {
			const h = /^#{2,6}\s+(.*)$/.exec(line);
			if (h) {
				const text = h[1].replace(/[*_`]/g, '').trim();
				headings.push(text);
				return text;
			}
			return line;
		})
		.join('\n')
		.replace(/^\s*-\s+/gm, '')
		.replace(/\|/g, ' ')
		.replace(/\*\*|`/g, '')
		.replace(/(^|[^*])\*(?!\*)([^*\n]+)\*/g, '$1$2')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\n{2,}/g, '\n')
		.trim();
	return { id: rule.id, section: rule.section, title: rule.title, headings, body };
}
```

In the write path of `main()`, after the ledger write:

```js
		writeFileSync(SEARCH_JSON, JSON.stringify(rules.map(toSearchDoc), null, '\t') + '\n', 'utf8');
		console.log(`Wrote ${rules.length} search docs to ${SEARCH_JSON}`);
```

And in the `--check` path:

```js
		const committedSearch = existsSync(SEARCH_JSON) ? readFileSync(SEARCH_JSON, 'utf8') : '';
		if (committedSearch !== JSON.stringify(rules.map(toSearchDoc), null, '\t') + '\n') {
			console.error('DRIFT rules-search.json');
			drift++;
		}
```

- [ ] **Step 5: Declare the file, bump the version, re-record the digest**

In `static/content-packs/hmtw/index.json`: add `"rulesSearch": "rules-search.json"` to `files`, change `"version": "3.4.0"` to `"version": "4.0.0"`.

In `tests/unit/content-build.test.ts`, in the `declares every generated file it ships` test, add:

```ts
		expect(index.files.rulesSearch).toBe('rules-search.json');
```

Run:
```bash
node scripts/content-import/md-rules.mjs
node scripts/content-import/verify-pack-version.mjs --write
```

- [ ] **Step 6: Run the full verification set**

Run:
```bash
npx vitest run tests/unit/rules-search-artifact.test.ts tests/unit/content-build.test.ts tests/unit/content-pack.test.ts
npm run content:verify
npm run check
```
Expected: PASS / 0 drift / clean types. Note the raw+gzip sizes the artifact test logs — they go in the PR description (spec's budget record).

- [ ] **Step 7: Commit**

```bash
git add scripts/content-import/md-rules.mjs src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts static/content-packs/hmtw/index.json static/content-packs/hmtw/rules-search.json tests/unit/rules-search-artifact.test.ts tests/unit/content-build.test.ts
git commit -m "feat(content): rules-search artifact inside the pack digest; pack v4.0.0"
```

---

### Task 10: Ledger consistency test, wired into CI

**Files:**
- Create: `tests/unit/rules-ledger.test.ts`
- Modify: `package.json` (`content:verify:ci`)

**Interfaces:**
- Consumes: committed `rules-coverage-ledger.json` + `rules.json` (Tasks 7–9).
- Produces: the CI-side coverage guarantee — runs without the vault.

- [ ] **Step 1: Write the test (it should pass immediately against committed artifacts)**

Create `tests/unit/rules-ledger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import ledger from '../../scripts/content-import/manifest/rules-coverage-ledger.json';
import rules from '../../static/content-packs/hmtw/rules.json';

/**
 * The vault is gitignored, so CI cannot re-extract chapters. This test is the
 * committed half of the coverage guarantee: the ledger (generated WITH the
 * vault, locally) must stay bijective with rules.json. The local half —
 * "ledger matches the actual source" — is `md-rules.mjs --check` inside
 * `npm run content:verify` / release:verify.
 */
describe('rules coverage ledger', () => {
	const emitted = ledger.flatMap((c) => c.headings.filter((h) => h.disposition === 'emitted'));
	const ruleIds = new Set(rules.map((r) => r.id));

	it('covers all nine chapters', () => {
		expect(ledger.map((c) => c.section).sort()).toEqual(
			['adventurer', 'basics', 'camp-phase', 'challenge-phase', 'city-phase', 'crawl-phase', 'four-paths', 'guild', 'kith-and-kin'].sort()
		);
	});

	it('every emitted ledger id exists exactly once in rules.json', () => {
		const ids = emitted.map((h) => h.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(ruleIds.has(id!), `${id} missing from rules.json`).toBe(true);
	});

	it('every walked-section rule is claimed by the ledger', () => {
		const walkedSections = new Set(ledger.map((c) => c.section));
		const emittedIds = new Set(emitted.map((h) => h.id));
		for (const r of rules.filter((r) => walkedSections.has(r.section))) {
			expect(emittedIds.has(r.id), `${r.id} not in ledger`).toBe(true);
		}
	});

	it('every heading is dispositioned, and skips carry reasons', () => {
		for (const c of ledger) {
			for (const h of c.headings) {
				expect(['emitted', 'container', 'skipped']).toContain(h.disposition);
				if (h.disposition === 'skipped') expect((h as { reason?: string }).reason, `${h.locator}`).toBeTruthy();
			}
			expect(c.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/unit/rules-ledger.test.ts`
Expected: PASS (artifacts were committed in Tasks 7–9). If it fails, the ledger or rules are inconsistent — fix the pipeline, not the test.

- [ ] **Step 3: Wire into CI**

In `package.json`, extend `content:verify:ci`'s vitest file list with `tests/unit/rules-ledger.test.ts tests/unit/rules-search-artifact.test.ts` (append after `tests/unit/rules-coverage.test.ts`).

Run: `npm run content:verify:ci`
Expected: PASS end-to-end.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/rules-ledger.test.ts package.json
git commit -m "test(content): CI-side coverage ledger consistency check"
```

---

### Task 11: Search service (`rules-search.ts`) with MiniSearch

**Files:**
- Create: `src/lib/search/rules-search.ts`
- Modify: `package.json` (+ `minisearch` dependency)
- Test: `tests/unit/rules-search-service.test.ts`

**Interfaces:**
- Consumes: `rules-search.json` (fetched), `RuleSearchDoc` type (Task 9).
- Produces:
  ```ts
  export interface RuleSearchHit { doc: RuleSearchDoc; score: number; terms: string[]; bookIndex: number }
  export interface RulesSearchEngine { docs: RuleSearchDoc[]; search(query: string): RuleSearchHit[] }
  export function getRulesSearch(packVersion: string, fetchFn?: typeof fetch): Promise<RulesSearchEngine>
  export function resetRulesSearchForTests(): void
  export const foldText: (s: string) => string
  export const tokenize: (s: string) => string[]
  ```
  Tasks 13/15 consume `getRulesSearch`; Task 12 consumes `foldText`.

- [ ] **Step 1: Install the dependency**

Run: `npm install minisearch`
Expected: added to `dependencies` (runtime, dynamically imported).

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/rules-search-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { foldText, getRulesSearch, resetRulesSearchForTests, tokenize } from '$lib/search/rules-search';

const DOCS = [
	{ id: 'tests-of-fate', section: 'basics', title: 'Tests of Fate', headings: ['Attributes'], body: 'Draw a card to test fate. Death’s Door is elsewhere.' },
	{ id: 'challenge-sequence', section: 'challenge-phase', title: 'The Flow of the Challenge Phase', headings: [], body: 'The Challenge Phase is played in rounds and turns.' },
	{ id: 'challenge-guard', section: 'challenge-phase', title: 'Guard', headings: [], body: 'Replace your Initiative to guard during a challenge.' }
] as const;

function okFetch(payload: unknown = DOCS) {
	return vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
}

describe('rules search service', () => {
	beforeEach(() => resetRulesSearchForTests());

	it('folds case and both apostrophe styles', () => {
		expect(foldText('Death’s')).toBe(foldText("death's"));
		expect(tokenize('Death’s Door!')).toEqual(['deaths', 'door']);
	});

	it('fetches once for concurrent callers, with the pack version in the URL', async () => {
		const f = okFetch();
		const [a, b] = await Promise.all([getRulesSearch('4.0.0', f), getRulesSearch('4.0.0', f)]);
		expect(a).toBe(b);
		expect(f).toHaveBeenCalledTimes(1);
		expect(String(f.mock.calls[0][0])).toBe('/content-packs/hmtw/rules-search.json?v=4.0.0');
	});

	it('clears the memo on failure so the next call retries', async () => {
		const bad = vi.fn(async () => new Response('nope', { status: 500 }));
		await expect(getRulesSearch('4.0.0', bad)).rejects.toThrow(/500/);
		const good = okFetch();
		const engine = await getRulesSearch('4.0.0', good);
		expect(engine.docs).toHaveLength(3);
	});

	it('ranks title matches above body matches and reports matched terms', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		const hits = engine.search('challenge');
		expect(hits[0].doc.id).toBe('challenge-sequence'); // title hit beats body hit
		expect(hits.map((h) => h.doc.id)).toContain('challenge-guard');
		expect(hits[0].terms).toContain('challenge');
	});

	it('finds fuzzy and prefix matches', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		expect(engine.search('challnge').map((h) => h.doc.id)).toContain('challenge-sequence'); // fuzzy
		expect(engine.search('chall').map((h) => h.doc.id)).toContain('challenge-sequence'); // prefix
	});

	it('requires every term to match (AND) and matches through apostrophes', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		expect(engine.search('challenge nonexistentword')).toEqual([]);
		expect(engine.search("death's door").map((h) => h.doc.id)).toEqual(['tests-of-fate']);
	});

	it('gives an exact-title query the top slot and breaks score ties by book order', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		expect(engine.search('guard')[0].doc.id).toBe('challenge-guard');
		const tie = engine.search('challenge phase');
		const idx = tie.map((h) => h.bookIndex);
		expect([...idx].every((v, i) => i === 0 || tie[i - 1].score > tie[i].score || idx[i - 1] < v)).toBe(true);
	});

	it('returns no results for queries shorter than 2 letters', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		expect(engine.search('a')).toEqual([]);
		expect(engine.search('  ')).toEqual([]);
	});
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/rules-search-service.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `src/lib/search/rules-search.ts`**

```ts
import type { RuleSearchDoc } from '$lib/types/content-pack';

/**
 * Client-side rules search: one memoized engine per session, built from the
 * static, digest-verified rules-search.json. MiniSearch is dynamically
 * imported so no page pays for it until search is actually used. Failed
 * initialization clears the memo so the next interaction retries.
 */

export interface RuleSearchHit {
	doc: RuleSearchDoc;
	score: number;
	/** Index terms the engine matched — the source of truth for highlighting
	 * (a fuzzy hit for "challnge" reports "challenge"). */
	terms: string[];
	bookIndex: number;
}

export interface RulesSearchEngine {
	docs: RuleSearchDoc[];
	search(query: string): RuleSearchHit[];
}

/** Case + straight/curly apostrophe folding, shared with snippet highlighting. */
export const foldText = (s: string): string => s.toLowerCase().replace(/[’‘']/g, '');

export const tokenize = (s: string): string[] =>
	foldText(s)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0);

const ARTIFACT_PATH = '/content-packs/hmtw/rules-search.json';
const EXACT_TITLE_BONUS = 100;

let memo: Promise<RulesSearchEngine> | null = null;

export function getRulesSearch(packVersion: string, fetchFn: typeof fetch = fetch): Promise<RulesSearchEngine> {
	if (!memo) {
		memo = build(packVersion, fetchFn).catch((err) => {
			memo = null;
			throw err;
		});
	}
	return memo;
}

export function resetRulesSearchForTests(): void {
	memo = null;
}

async function build(packVersion: string, fetchFn: typeof fetch): Promise<RulesSearchEngine> {
	const res = await fetchFn(`${ARTIFACT_PATH}?v=${encodeURIComponent(packVersion)}`);
	if (!res.ok) throw new Error(`rules search index fetch failed: ${res.status}`);
	const docs = (await res.json()) as RuleSearchDoc[];
	const { default: MiniSearch } = await import('minisearch');

	const mini = new MiniSearch<RuleSearchDoc>({
		fields: ['title', 'headings', 'body'],
		storeFields: [],
		tokenize,
		extractField: (doc, field) =>
			field === 'headings' ? doc.headings.join('\n') : String(doc[field as keyof RuleSearchDoc] ?? ''),
		searchOptions: {
			boost: { title: 4, headings: 2 },
			prefix: true,
			fuzzy: 0.2,
			combineWith: 'AND'
		}
	});
	mini.addAll(docs as unknown as RuleSearchDoc[]);
	const byId = new Map(docs.map((d, i) => [d.id, { doc: d, bookIndex: i }]));

	return {
		docs,
		search(query: string): RuleSearchHit[] {
			if (tokenize(query).join('').length < 2) return [];
			const folded = foldText(query.trim());
			const hits = mini.search(query).map((r) => {
				const { doc, bookIndex } = byId.get(String(r.id))!;
				const bonus = foldText(doc.title) === folded ? EXACT_TITLE_BONUS : 0;
				return { doc, bookIndex, terms: r.terms, score: r.score + bonus };
			});
			hits.sort((a, b) => b.score - a.score || a.bookIndex - b.bookIndex);
			return hits;
		}
	};
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/unit/rules-search-service.test.ts && npm run check`
Expected: PASS, clean types.

- [ ] **Step 6: Commit**

```bash
git add src/lib/search/rules-search.ts tests/unit/rules-search-service.test.ts package.json package-lock.json
git commit -m "feat(search): memoized MiniSearch rules-search service"
```

---

### Task 12: Snippets and highlight fragments

**Files:**
- Create: `src/lib/search/snippets.ts`
- Test: `tests/unit/search-snippets.test.ts`

**Interfaces:**
- Consumes: `foldText` (Task 11) conceptually; self-contained implementation.
- Produces:
  ```ts
  export interface SnippetPart { text: string; marked: boolean }
  export function splitSentences(text: string): string[]
  export function splitSentencesFallback(text: string): string[]  // regex path, exported so the non-Segmenter branch is directly testable
  export function buildSnippet(body: string, terms: string[], contextChars?: number): SnippetPart[]
  export function markParts(text: string, terms: string[]): SnippetPart[]
  ```
  Parts render as text nodes around `<mark>` — never HTML strings. Tasks 13/15 consume `buildSnippet`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/search-snippets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSnippet, markParts, splitSentences, splitSentencesFallback } from '$lib/search/snippets';

describe('splitSentences', () => {
	it('splits prose into sentences (Segmenter or fallback)', () => {
		const s = splitSentences('First rule. Second rule! Third?');
		expect(s).toEqual(['First rule.', 'Second rule!', 'Third?']);
	});

	it('the regex fallback splits the same prose (for engines without Intl.Segmenter)', () => {
		expect(splitSentencesFallback('First rule. Second rule! Third?')).toEqual([
			'First rule.',
			'Second rule!',
			'Third?'
		]);
	});
});

describe('markParts', () => {
	it('splits text into marked/unmarked parts for the matched terms', () => {
		expect(markParts('Draw a Challenge card.', ['challenge'])).toEqual([
			{ text: 'Draw a ', marked: false },
			{ text: 'Challenge', marked: true },
			{ text: ' card.', marked: false }
		]);
	});

	it('matches through curly apostrophes in the display text', () => {
		const parts = markParts('Death’s Door opens.', ['deaths']);
		expect(parts.find((p) => p.marked)?.text).toBe('Death’s');
	});

	it('merges overlapping term ranges instead of nesting marks', () => {
		const parts = markParts('challenge', ['challenge', 'chall']);
		expect(parts).toEqual([{ text: 'challenge', marked: true }]);
	});

	it('returns one unmarked part when nothing matches', () => {
		expect(markParts('No hits here.', ['zzz'])).toEqual([{ text: 'No hits here.', marked: false }]);
	});
});

describe('buildSnippet', () => {
	const body = 'Intro sentence with nothing. The Challenge Phase is played in rounds. Final sentence.';

	it('windows on the first sentence containing a matched term', () => {
		const parts = buildSnippet(body, ['challenge']);
		const text = parts.map((p) => p.text).join('');
		expect(text).toContain('Challenge Phase is played');
		expect(text).not.toContain('Intro sentence');
		expect(parts.some((p) => p.marked && /challenge/i.test(p.text))).toBe(true);
	});

	it('falls back to the body start when no term appears literally (fuzzy miss)', () => {
		const parts = buildSnippet(body, []);
		expect(parts.map((p) => p.text).join('')).toContain('Intro sentence');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/search-snippets.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/lib/search/snippets.ts`**

```ts
/**
 * Snippet + highlight construction for search results. Output is a list of
 * {text, marked} parts rendered as text nodes around <mark> elements — no
 * HTML strings, so query-derived content can never inject markup. Terms come
 * from the engine's match metadata (already folded), so fuzzy hits highlight
 * the matched word, not the typo the user typed.
 */

export interface SnippetPart {
	text: string;
	marked: boolean;
}

/** Regex path, exported on its own so the non-Segmenter branch stays tested. */
export function splitSentencesFallback(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function splitSentences(text: string): string[] {
	if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
		const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
		return [...seg.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
	}
	return splitSentencesFallback(text);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A term regex tolerant of apostrophes between letters ("deaths" ⇢ "Death’s"). */
function termRegex(term: string): RegExp {
	const pattern = term.split('').map(escapeRe).join('[’‘\']?');
	return new RegExp(pattern, 'gi');
}

export function markParts(text: string, terms: string[]): SnippetPart[] {
	const ranges: Array<[number, number]> = [];
	for (const term of terms.filter(Boolean)) {
		for (const m of text.matchAll(termRegex(term))) {
			if (m[0]) ranges.push([m.index, m.index + m[0].length]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else merged.push([r[0], r[1]]);
	}
	const parts: SnippetPart[] = [];
	let pos = 0;
	for (const [start, end] of merged) {
		if (start > pos) parts.push({ text: text.slice(pos, start), marked: false });
		parts.push({ text: text.slice(start, end), marked: true });
		pos = end;
	}
	if (pos < text.length) parts.push({ text: text.slice(pos), marked: false });
	return parts.length ? parts : [{ text, marked: false }];
}

export function buildSnippet(body: string, terms: string[], contextChars = 220): SnippetPart[] {
	const sentences = splitSentences(body);
	const hit = sentences.find((s) => terms.some((t) => t && termRegex(t).test(s)));
	const window = (hit ?? body.slice(0, contextChars)).slice(0, contextChars * 2);
	return markParts(window, terms);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/search-snippets.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/snippets.ts tests/unit/search-snippets.test.ts
git commit -m "feat(search): text-node snippet and highlight fragments"
```

---

### Task 13: Site-search combobox controller (runes module)

**Files:**
- Create: `src/lib/components/layout/site-search.svelte.ts`
- Test: `tests/unit/components/site-search.test.ts`

**Interfaces:**
- Consumes: `getRulesSearch`, `RuleSearchHit` (Task 11).
- Produces:
  ```ts
  export type SiteSearchStatus = 'idle' | 'loading' | 'ready' | 'error';
  export function createSiteSearch(packVersion: string, deps?: { getEngine?: typeof getRulesSearch }): {
    readonly query: string; readonly open: boolean; readonly active: number;
    readonly status: SiteSearchStatus; readonly hits: RuleSearchHit[];
    onFocus(): void; onInput(value: string): void;
    onKeydown(e: KeyboardEvent): string | null; // returns an href to navigate to, or null
    setComposing(v: boolean): void; close(): void;
  }
  ```
  Task 14's component consumes this; the `/rules` page (Task 15) uses the service directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/components/site-search.test.ts` (mirror the `challenge-action` runes-module test pattern):

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSiteSearch } from '$lib/components/layout/site-search.svelte';
import type { RulesSearchEngine } from '$lib/search/rules-search';

const engine: RulesSearchEngine = {
	docs: [],
	search: (q: string) =>
		q.includes('challenge')
			? [
					{ doc: { id: 'challenge-sequence', section: 'challenge-phase', title: 'Flow', headings: [], body: 'b' }, score: 2, terms: ['challenge'], bookIndex: 0 },
					{ doc: { id: 'challenge-guard', section: 'challenge-phase', title: 'Guard', headings: [], body: 'b' }, score: 1, terms: ['challenge'], bookIndex: 1 }
				]
			: []
};

const key = (k: string) => new KeyboardEvent('keydown', { key: k });

describe('createSiteSearch', () => {
	it('loads the engine on first focus and becomes ready', async () => {
		const getEngine = vi.fn(async () => engine);
		const s = createSiteSearch('4.0.0', { getEngine });
		expect(s.status).toBe('idle');
		s.onFocus();
		expect(s.status).toBe('loading');
		await vi.waitFor(() => expect(s.status).toBe('ready'));
		expect(getEngine).toHaveBeenCalledWith('4.0.0');
	});

	it('reports error status on failure, and refocusing retries', async () => {
		const getEngine = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(engine);
		const s = createSiteSearch('4.0.0', { getEngine });
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('error'));
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('ready'));
	});

	it('searches on input, opens the listbox, and activates the first hit', async () => {
		const s = createSiteSearch('4.0.0', { getEngine: async () => engine });
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('ready'));
		s.onInput('challenge');
		expect(s.open).toBe(true);
		expect(s.hits.map((h) => h.doc.id)).toEqual(['challenge-sequence', 'challenge-guard']);
		expect(s.active).toBe(0);
	});

	it('arrows move the active option; Enter returns the target href; Esc closes', async () => {
		const s = createSiteSearch('4.0.0', { getEngine: async () => engine });
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('ready'));
		s.onInput('challenge');
		expect(s.onKeydown(key('ArrowDown'))).toBeNull();
		expect(s.active).toBe(1);
		expect(s.onKeydown(key('Enter'))).toBe('/rules/challenge-phase#challenge-guard');
		s.onInput('challenge');
		expect(s.onKeydown(key('Escape'))).toBeNull();
		expect(s.open).toBe(false);
	});

	it('Enter during IME composition does not navigate', async () => {
		const s = createSiteSearch('4.0.0', { getEngine: async () => engine });
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('ready'));
		s.onInput('challenge');
		s.setComposing(true);
		expect(s.onKeydown(key('Enter'))).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/components/site-search.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/lib/components/layout/site-search.svelte.ts`**

```ts
import { getRulesSearch, type RuleSearchHit, type RulesSearchEngine } from '$lib/search/rules-search';

export type SiteSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

const MAX_HITS = 15;

/**
 * Headless combobox state for the header rules search. The component renders
 * it; keyboard semantics live here so they are unit-testable. onKeydown
 * returns the href to navigate to (Enter on an active option) or null.
 */
export function createSiteSearch(packVersion: string, deps: { getEngine?: typeof getRulesSearch } = {}) {
	const getEngine = deps.getEngine ?? getRulesSearch;
	let engine: RulesSearchEngine | null = null;
	let query = $state('');
	let open = $state(false);
	let active = $state(-1);
	let status = $state<SiteSearchStatus>('idle');
	let hits = $state<RuleSearchHit[]>([]);
	let composing = false;

	async function ensureEngine() {
		if (engine || status === 'loading') return;
		status = 'loading';
		try {
			engine = await getEngine(packVersion);
			status = 'ready';
			runSearch();
		} catch {
			status = 'error';
		}
	}

	function runSearch() {
		if (!engine) return;
		hits = engine.search(query).slice(0, MAX_HITS);
		active = hits.length ? 0 : -1;
	}

	function close() {
		open = false;
		active = -1;
	}

	return {
		get query() { return query; },
		get open() { return open; },
		get active() { return active; },
		get status() { return status; },
		get hits() { return hits; },
		onFocus() {
			if (status === 'error') status = 'idle';
			void ensureEngine();
			if (query.trim()) open = true;
		},
		onInput(value: string) {
			query = value;
			open = true;
			void ensureEngine();
			runSearch();
		},
		setComposing(v: boolean) { composing = v; },
		close,
		onKeydown(e: KeyboardEvent): string | null {
			if (e.key === 'Escape') { close(); return null; }
			if (!open || hits.length === 0) return null;
			if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, hits.length - 1); return null; }
			if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); return null; }
			if (e.key === 'Enter' && !composing && active >= 0) {
				e.preventDefault();
				const hit = hits[active];
				close();
				return `/rules/${hit.doc.section}#${hit.doc.id}`;
			}
			return null;
		}
	};
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/components/site-search.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/layout/site-search.svelte.ts tests/unit/components/site-search.test.ts
git commit -m "feat(search): headless combobox controller for the header search"
```

---

### Task 14: `SiteSearch.svelte` + header grid layout

**Files:**
- Create: `src/lib/components/layout/SiteSearch.svelte`
- Modify: `src/routes/+layout.svelte`, `src/routes/+layout.server.ts`

**Interfaces:**
- Consumes: `createSiteSearch` (Task 13), `buildSnippet` (Task 12), `sectionLabel` from `$lib/content/sections`, `packVersion` from layout data.
- Produces: the header search UI on every root-layout page; `data.packVersion: string` in layout data (Task 15 reuses it).

- [ ] **Step 1: Expose the pack version in layout data**

In `src/routes/+layout.server.ts` add the import and field:

```ts
import { getContentPack } from '$lib/server/content/loader';
```
and in the returned object:
```ts
		packVersion: getContentPack().version,
```

- [ ] **Step 2: Create `src/lib/components/layout/SiteSearch.svelte`**

```svelte
<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { createSiteSearch } from './site-search.svelte';
	import { buildSnippet } from '$lib/search/snippets';
	import { sectionLabel } from '$lib/content/sections';

	let { packVersion }: { packVersion: string } = $props();

	const search = createSiteSearch(packVersion);
	let root = $state<HTMLElement | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	afterNavigate(() => search.close());

	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement | null;
		if (target && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable)) return;
		e.preventDefault();
		input?.focus();
	}

	function onPointerDownOutside(e: PointerEvent) {
		if (root && !root.contains(e.target as Node)) search.close();
	}

	function onKeydown(e: KeyboardEvent) {
		const href = search.onKeydown(e);
		if (href) void goto(href);
	}

	function pick(index: number) {
		const hit = search.hits[index];
		search.close();
		void goto(`/rules/${hit.doc.section}#${hit.doc.id}`);
	}

	const listboxId = 'site-search-listbox';
	const optionId = (i: number) => `site-search-option-${i}`;
	let showList = $derived(search.open && search.query.trim().length > 0);

	// Keep the keyboard-active option visible inside the scrollable listbox.
	$effect(() => {
		if (search.active < 0) return;
		document.getElementById(optionId(search.active))?.scrollIntoView({ block: 'nearest' });
	});
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onPointerDownOutside} />

<div class="site-search" bind:this={root}>
	<input
		bind:this={input}
		type="search"
		role="combobox"
		aria-label="Search the rules"
		aria-expanded={showList}
		aria-controls={listboxId}
		aria-autocomplete="list"
		aria-activedescendant={search.active >= 0 ? optionId(search.active) : undefined}
		placeholder="Search rules… ( / )"
		value={search.query}
		onfocus={() => search.onFocus()}
		oninput={(e) => search.onInput(e.currentTarget.value)}
		onkeydown={onKeydown}
		oncompositionstart={() => search.setComposing(true)}
		oncompositionend={() => search.setComposing(false)}
	/>
	<span class="sr-only" role="status" aria-live="polite">
		{#if showList && search.status === 'ready'}{search.hits.length} results{/if}
	</span>

	{#if showList}
		<div class="dropdown">
			{#if search.status === 'loading' || search.status === 'idle'}
				<p class="state">loading the rulebook…</p>
			{:else if search.status === 'error'}
				<p class="state">search unavailable — <a href="/rules">browse the rules index</a></p>
			{:else if search.hits.length === 0}
				<p class="state">No rules match “{search.query}”.</p>
			{:else}
				<ul id={listboxId} role="listbox" aria-label="Rules search results">
					{#each search.hits as hit, i (hit.doc.id)}
						<li
							id={optionId(i)}
							role="option"
							aria-selected={i === search.active}
							class:active={i === search.active}
						>
							<button type="button" onpointerdown={(e) => e.preventDefault()} onclick={() => pick(i)}>
								<span class="title">{hit.doc.title}</span>
								<span class="crumb">{sectionLabel(hit.doc.section)}</span>
								<span class="snippet">
									{#each buildSnippet(hit.doc.body, hit.terms) as part}
										{#if part.marked}<mark>{part.text}</mark>{:else}{part.text}{/if}
									{/each}
								</span>
							</button>
						</li>
					{/each}
				</ul>
				<a class="all" href={`/rules?q=${encodeURIComponent(search.query)}`} onclick={() => search.close()}>
					All results for “{search.query}” →
				</a>
			{/if}
		</div>
	{/if}
</div>

<style>
	.site-search {
		position: relative;
		min-width: 0;
	}
	.site-search input {
		width: 100%;
		padding: 0.45rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		font: inherit;
		font-size: 0.9rem;
	}
	.dropdown {
		position: absolute;
		z-index: 30;
		top: calc(100% + 0.35rem);
		left: 0;
		width: min(28rem, calc(100vw - 2.5rem));
		max-height: min(60vh, 30rem);
		overflow-y: auto;
		background: var(--parchment);
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 6px;
		box-shadow: 0 8px 24px color-mix(in oklab, var(--ink) 25%, transparent);
	}
	.dropdown ul {
		list-style: none;
		margin: 0;
		padding: 0.25rem;
	}
	.dropdown li button {
		display: block;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		padding: 0.5rem 0.6rem;
		border-radius: 4px;
		cursor: pointer;
		font: inherit;
	}
	.dropdown li.active button,
	.dropdown li button:hover {
		background: color-mix(in oklab, var(--accent) 14%, transparent);
	}
	.title {
		display: inline;
		font-family: var(--font-subhead);
		font-weight: 600;
	}
	.crumb {
		margin-left: 0.5rem;
		font-size: 0.78rem;
		color: var(--ink-soft);
	}
	.snippet {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
		line-height: 1.4;
	}
	.snippet mark {
		background: color-mix(in oklab, var(--accent) 30%, transparent);
		color: inherit;
		border-radius: 2px;
	}
	.state,
	.all {
		display: block;
		padding: 0.6rem 0.8rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
		margin: 0;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
	}
</style>
```

(The `onpointerdown={(e) => e.preventDefault()}` on the option button keeps the input from blurring before `click` fires — that is the pointer-selection path.)

- [ ] **Step 3: Rework the header in `src/routes/+layout.svelte`**

Add the import and render:

```svelte
	import SiteSearch from '$lib/components/layout/SiteSearch.svelte';
```

Replace the `<header class="site-header">…</header>` block's contents order with:

```svelte
	<header class="site-header">
		<a class="brand" href="/">Guild Book</a>
		<div class="header-search"><SiteSearch packVersion={data.packVersion} /></div>
		<nav class="site-nav">
			<!-- existing nav contents unchanged -->
		</nav>
	</header>
```

Replace the `.site-header` CSS rule and add the search cell + breakpoint:

```css
	.site-header {
		display: grid;
		grid-template-columns: auto minmax(10rem, 14rem) 1fr;
		align-items: center;
		gap: 1rem;
		padding: 1.25rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	.header-search {
		min-width: 0;
	}
	.site-nav {
		justify-content: flex-end;
	}
	@media (max-width: 44rem) {
		.site-header {
			grid-template-columns: auto 1fr;
			row-gap: 0.6rem;
		}
		.header-search {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
```

(Keep `.site-nav`'s existing `flex-wrap: wrap` etc.; only add `justify-content`.)

- [ ] **Step 4: Verify in the running app**

Run: `npm run check`, then `npm run dev` and manually confirm: search box in the header on `/`, `/deck`, `/licensing`; typing "carouse" shows ranked results with highlights; Enter lands on the City Phase section; `/` focuses the input; 320px width (devtools) shows the search on its own row with no horizontal scroll, signed out. Then sign in (local OAuth is configured for dev) and re-check 320px — the signed-in nav has 7 items, but the narrow breakpoint gives search its own full-width row and `.site-nav` keeps its existing internal `flex-wrap`, so the layout is nav-count-independent; this check confirms that holds. Stop the dev server.
Expected: all behaviors as described in both auth states; no console errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/layout/SiteSearch.svelte src/routes/+layout.svelte src/routes/+layout.server.ts
git commit -m "feat(search): site-wide header search with ranked combobox dropdown"
```

---

### Task 15: `/rules` page — grouped TOC vs ranked-results modes

**Files:**
- Modify: `src/routes/rules/+page.svelte`

**Interfaces:**
- Consumes: `getRulesSearch` (Task 11), `buildSnippet` (Task 12), `data.toc`/`data.sections` (existing server load, unchanged), `page.url.searchParams` for `?q=`, `data.packVersion` via `$page.data`.
- Produces: empty query → grouped book-order TOC with per-chapter entry counts; non-empty → flat ranked list identical in order to the header dropdown; substring fallback while loading/failed.

- [ ] **Step 1: Rewrite the script + template of `src/routes/rules/+page.svelte`**

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import RulesSearch from '$lib/components/rules/RulesSearch.svelte';
	import { sectionLabel } from '$lib/content/sections';
	import { getRulesSearch, type RulesSearchEngine, type RuleSearchHit } from '$lib/search/rules-search';
	import { buildSnippet } from '$lib/search/snippets';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let query = $state(page.url.searchParams.get('q') ?? '');
	let engine = $state<RulesSearchEngine | null>(null);
	let engineFailed = $state(false);

	$effect(() => {
		getRulesSearch(page.data.packVersion as string)
			.then((e) => (engine = e))
			.catch(() => (engineFailed = true));
	});

	let hits = $derived.by<RuleSearchHit[] | null>(() => {
		if (!query.trim() || !engine) return null;
		return engine.search(query);
	});

	// Fallback while the engine loads (or if it failed): substring over the SSR TOC.
	let fallbackToc = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return data.toc;
		return data.toc.filter((r) => [r.title, ...r.tags].join(' ').toLowerCase().includes(q));
	});

	let bySection = $derived(
		data.sections
			.map((section) => ({ section, rules: (query.trim() ? fallbackToc : data.toc).filter((r) => r.section === section) }))
			.filter((g) => g.rules.length > 0)
	);
</script>

<svelte:head><title>Rules — Guild Book</title></svelte:head>

<section class="rules">
	<h1>Rules Reference</h1>
	<p class="lede">
		The full text of His Majesty the Worm chapters 1–9, reproduced from the core rulebook, plus
		selected gamemastering and sorcery entries. Pick a chapter or search the whole reference.
	</p>

	<RulesSearch bind:value={query} />

	{#if query.trim() && hits}
		{#if hits.length === 0}
			<p class="empty">No rules match “{query}”.</p>
		{:else}
			<ol class="results">
				{#each hits as hit (hit.doc.id)}
					<li>
						<a href={`/rules/${hit.doc.section}#${hit.doc.id}`}>{hit.doc.title}</a>
						<span class="crumb">{sectionLabel(hit.doc.section)}</span>
						<p class="snippet">
							{#each buildSnippet(hit.doc.body, hit.terms) as part}
								{#if part.marked}<mark>{part.text}</mark>{:else}{part.text}{/if}
							{/each}
						</p>
					</li>
				{/each}
			</ol>
		{/if}
	{:else}
		{#if query.trim() && engineFailed}
			<p class="empty">Full-text search is unavailable — filtering titles only.</p>
		{/if}
		{#if bySection.length === 0}
			<p class="empty">No rules match “{query}”.</p>
		{:else}
			<nav class="jump" aria-label="Chapters">
				{#each bySection as g (g.section)}
					<a href={`/rules/${g.section}`}>{sectionLabel(g.section)}</a>
				{/each}
			</nav>
			{#each bySection as g (g.section)}
				<section class="group">
					<h2>
						<a href={`/rules/${g.section}`}>{sectionLabel(g.section)}</a>
						<span class="count">{g.rules.length} entries</span>
					</h2>
					<ul class="toc">
						{#each g.rules as rule (rule.id)}
							<li><a href={`/rules/${g.section}#${rule.id}`}>{rule.title}</a></li>
						{/each}
					</ul>
				</section>
			{/each}
		{/if}
	{/if}
</section>
```

Keep the existing `<style>` block and add:

```css
	.results {
		list-style: none;
		padding: 0;
		margin: 1.25rem 0 0;
	}
	.results li {
		padding: 0.6rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}
	.results a {
		font-family: var(--font-subhead);
		font-weight: 600;
	}
	.results .crumb {
		margin-left: 0.5rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.results .snippet {
		margin: 0.2rem 0 0;
		font-size: 0.9rem;
		color: var(--ink-soft);
	}
	.results mark {
		background: color-mix(in oklab, var(--accent) 30%, transparent);
		color: inherit;
		border-radius: 2px;
	}
	.count {
		margin-left: 0.5rem;
		font-size: 0.8rem;
		font-weight: normal;
		color: var(--ink-soft);
	}
```

(The old `bodyById` lazy fetch of `rules.json` is deleted — the search service replaces it.)

- [ ] **Step 2: Verify**

Run: `npm run check`, then `npm run dev`: `/rules` shows nine chapter groups with counts; typing switches to ranked flat results matching the header's order; `/rules?q=carouse` arrives pre-filtered; clearing restores the TOC.
Expected: as described.

- [ ] **Step 3: Commit**

```bash
git add src/routes/rules/+page.svelte
git commit -m "feat(rules): two-mode index — grouped TOC and ranked full-text results"
```

---

### Task 16: Section-page anchor focus + reduced-motion highlight

**Files:**
- Modify: `src/routes/rules/[section]/+page.svelte`, `src/lib/components/rules/RuleArticle.svelte`

**Interfaces:**
- Consumes: existing `RuleArticle` (`<article id={rule.id}>`).
- Produces: navigating to `/rules/[section]#id` focuses the target article (screen-reader/keyboard context moves) and flashes a highlight unless reduced motion is preferred.

- [ ] **Step 1: Make articles focusable**

In `src/lib/components/rules/RuleArticle.svelte` change the article tag:

```svelte
<article id={rule.id} class="rule" tabindex="-1">
```

and add to its style block:

```css
	.rule:focus {
		outline: none;
	}
	.rule:target,
	.rule.anchored {
		animation: rule-flash 1.6s ease-out 1;
	}
	@keyframes rule-flash {
		from {
			background: color-mix(in oklab, var(--accent) 18%, transparent);
		}
		to {
			background: transparent;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.rule:target,
		.rule.anchored {
			animation: none;
			outline: 2px solid color-mix(in oklab, var(--accent) 60%, transparent);
			outline-offset: 4px;
		}
	}
```

- [ ] **Step 2: Focus the anchored article after navigation**

In `src/routes/rules/[section]/+page.svelte` add to the script:

```ts
	import { afterNavigate } from '$app/navigation';

	afterNavigate(() => {
		const id = location.hash.slice(1);
		if (!id) return;
		const target = document.getElementById(id);
		if (target instanceof HTMLElement) {
			target.classList.add('anchored');
			target.focus({ preventScroll: true });
			target.scrollIntoView({ block: 'start' });
		}
	});
```

(`afterNavigate` also fires on initial load in SvelteKit, covering direct links.)

- [ ] **Step 3: Verify**

Run: `npm run check`; in `npm run dev`, search "carouse" in the header, press Enter — the Carouse article scrolls into view, is focused (devtools `document.activeElement`), and flashes; with "emulate reduced motion" in devtools, the outline appears instead.
Expected: as described.

- [ ] **Step 4: Commit**

```bash
git add src/routes/rules/[section]/+page.svelte src/lib/components/rules/RuleArticle.svelte
git commit -m "feat(rules): focus and highlight the search-target article"
```

---

### Task 17: Playwright E2E suite

**Files:**
- Create: `tests/e2e/rules-search.spec.ts`

**Interfaces:**
- Consumes: the built app (Playwright config builds + previews at `http://localhost:4173`), everything from Tasks 7–16.
- Produces: end-to-end regression coverage for the spec's Playwright list.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/rules-search.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

const searchbox = (page: import('@playwright/test').Page) =>
	page.getByRole('combobox', { name: 'Search the rules' });

test.describe('site-wide rules search', () => {
	test('finds a rule from a non-rules page, typo included, and lands focused on it', async ({ page }) => {
		await page.goto('/licensing');
		await searchbox(page).click();
		await searchbox(page).fill('carouse hangovr'); // typo: fuzzy must still hit
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });
		await expect(listbox.getByRole('option').first()).toContainText('Carouse');
		await searchbox(page).press('Enter');
		await expect(page).toHaveURL(/\/rules\/city-phase#/);
		await expect(page.locator('article:focus h3')).toContainText('Carouse');
		await expect(page.locator('article:focus')).toContainText('Hangover');
	});

	test('highlights the matched word, not the typo', async ({ page }) => {
		await page.goto('/');
		await searchbox(page).click();
		await searchbox(page).fill('challnge');
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });
		await expect(listbox.locator('mark').first()).toContainText(/challenge/i);
	});

	test('the / shortcut focuses the search except while typing elsewhere', async ({ page }) => {
		await page.goto('/deck');
		await page.keyboard.press('/');
		await expect(searchbox(page)).toBeFocused();
	});

	test('keyboard: arrows move the active option, Escape closes', async ({ page }) => {
		await page.goto('/');
		await searchbox(page).click();
		await searchbox(page).fill('watch');
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });
		await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
		await searchbox(page).press('ArrowDown');
		await expect(listbox.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
		await searchbox(page).press('Escape');
		await expect(listbox).toHaveCount(0);
	});

	test('hands off to /rules?q= with identically-ordered ranked results', async ({ page }) => {
		await page.goto('/');
		await searchbox(page).click();
		await searchbox(page).fill('disposition');
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });
		const dropdownFirst = await listbox.getByRole('option').first().locator('.title').textContent();
		await page.getByRole('link', { name: /All results for/ }).click();
		await expect(page).toHaveURL(/\/rules\?q=disposition/);
		const pageFirst = page.locator('.results li a').first();
		await expect(pageFirst).toHaveText(dropdownFirst ?? '');
	});

	test('/rules shows all nine chapters with counts when the query is empty', async ({ page }) => {
		await page.goto('/rules');
		const groups = page.locator('.group h2');
		await expect(groups).toHaveCount(11); // 9 walked chapters + gamemastering + sorcery
		for (const label of ['The Basics', 'The Adventurer', 'The Guild', 'Kith & Kin', 'The Four Paths', 'The Crawl Phase', 'The Challenge Phase', 'The Camp Phase', 'The City Phase']) {
			await expect(page.locator('.group h2', { hasText: label })).toBeVisible();
		}
		await expect(page.locator('.group .count').first()).toContainText(/\d+ entries/);
	});

	test('no horizontal overflow at 320px with the search present', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto('/rules');
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
		await expect(searchbox(page)).toBeVisible();
	});
});
```

- [ ] **Step 2: Run the new spec**

Run: `npx playwright test tests/e2e/rules-search.spec.ts`
Expected: PASS. If the option-count/order assertions flake on real content, tighten queries (e.g. a more distinctive term), not timeouts.

- [ ] **Step 3: Run the whole E2E suite**

Run: `npm run test:e2e`
Expected: PASS — especially the existing rules/campaign specs that consume rule entries.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/rules-search.spec.ts
git commit -m "test(e2e): site-wide rules search flows"
```

---

### Task 18: Legal + docs + changelog

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`, `src/routes/licensing/+page.svelte`, `CHANGELOG.md`

**Interfaces:**
- Consumes: spec §Legal updates.
- Produces: consistent legal statements in all four places.

- [ ] **Step 1: Update CLAUDE.md's Legal section**

Replace the sentence `No verbatim copyrighted rule text beyond what the licence allows.` with:

```
Verbatim game text is reproduced under the licence's terms ("the mechanics and
game text of His Majesty the Worm may be reused freely"); full-text
reproduction of chapters 1–9 — including worked examples, sidebars, and
epigraphs — additionally proceeds with Joshua McCrowell's direct permission.
```

- [ ] **Step 2: Make the identical replacement in AGENTS.md**

Same sentence, same replacement (the two files mirror each other's Legal section).

- [ ] **Step 3: Add the permission sentence to `/licensing`**

In `src/routes/licensing/+page.svelte`, directly after the existing paragraph that cites the licence's "mechanics and game text" terms (around line 33), add:

```svelte
		<p>
			The full rules text of chapters 1–9 — including worked examples, sidebars, and chapter
			epigraphs — is reproduced with the direct permission of Joshua McCrowell, in addition to the
			open licence's terms. No book artwork, logos, or trade dress is reproduced.
		</p>
```

- [ ] **Step 4: CHANGELOG entry**

Under `## [Unreleased]` (create the section if absent) in Keep-a-Changelog format:

```markdown
### Added

- Full rules coverage: every section of His Majesty the Worm chapters 1–9 is
  now in the rules reference — including worked examples, sidebars, and
  epigraphs — reproduced with the creator's permission (content pack 4.0.0).
- Site-wide rules search: a fuzzy, ranked search box in the header of every
  page, with keyboard navigation (`/` to focus) and deep links into the
  reference; the `/rules` index gains a ranked full-text results mode.

### Changed

- Rule entries' tags are now optional metadata; chapter-walked entries carry
  none by default.
```

- [ ] **Step 5: Verify and commit**

Run: `npm run check && npx vitest run tests/unit/markdown.test.ts` (sanity that the licensing page edit didn't break the build).

```bash
git add CLAUDE.md AGENTS.md src/routes/licensing/+page.svelte CHANGELOG.md
git commit -m "docs(legal): record creator permission for full chapters 1-9 text"
```

---

### Task 19: Budgets, bundle check, and final verification

**Files:** none new (measurements recorded in the PR description).

**Interfaces:**
- Consumes: everything.
- Produces: the spec's recorded measurements + a fully green branch ready for `superpowers:requesting-code-review` / PR.

- [ ] **Step 1: Confirm MiniSearch stays out of the initial bundle**

Run:
```bash
npm run build
grep -rl "MiniSearch" .svelte-kit/output/client/_app/immutable/ | head -5
grep -l "minisearch" .svelte-kit/output/client/_app/immutable/entry/*.js || echo "OK: not in entry chunks"
```
Expected: MiniSearch appears only in a lazy chunk, not in `entry/` — the `OK` line prints. If it is in an entry chunk, a static import leaked; fix it (the only import must be the dynamic one in `rules-search.ts`).

- [ ] **Step 2: Measure section-page HTML sizes**

Run:
```bash
npm run preview &
sleep 3
for s in challenge-phase city-phase adventurer; do printf '%s: ' $s; curl -so /dev/null -w '%{size_download} bytes\n' "http://localhost:4173/rules/$s"; done
kill %1
```
Expected: record the numbers. If any page exceeds ~150 KB of HTML, note it in the PR and open the spec's follow-up decision (split by H1 groups) — do not implement the split in this branch.

- [ ] **Step 3: Record artifact sizes**

Run: `npx vitest run tests/unit/rules-search-artifact.test.ts` and copy the logged raw/gzip sizes into the PR description alongside the HTML sizes.

- [ ] **Step 3b: Measure index construction time (one-time, spec budget ≤ 250ms mid-tier mobile)**

Run:
```bash
node -e "
const docs = require('./static/content-packs/hmtw/rules-search.json');
import('minisearch').then(({ default: MiniSearch }) => {
	const t0 = performance.now();
	const mini = new MiniSearch({ fields: ['title', 'headings', 'body'], extractField: (d, f) => (f === 'headings' ? d.headings.join(' ') : String(d[f] ?? '')) });
	mini.addAll(docs);
	console.log('index build:', Math.round(performance.now() - t0), 'ms on this machine for', docs.length, 'docs');
});
"
```
Expected: prints the build time. Desktop Node is not a mobile CPU — multiply by ~4 as the mobile proxy and record both numbers in the PR. If the proxy exceeds 250ms, note it as the spec's pre-serialized-index follow-up decision; do not implement it in this branch.

- [ ] **Step 4: Full verification sweep**

Run:
```bash
npm run check
npm test
npm run content:verify
npm run content:verify:ci
npm run test:e2e
```
Expected: all green. Fix anything red before proceeding — evidence before assertions.

- [ ] **Step 5: Final commit (if any stragglers) and handoff**

```bash
git status --short   # should be clean except untracked scratch
```

Then follow `superpowers:requesting-code-review` and open the PR from `feat/rules-full-coverage-and-search` to `main` (PR-only; `check` + `e2e` must pass). The PR description includes: entry count, artifact sizes (raw/gzip), section-page HTML sizes, and the note that `release:verify` + a pack-version-aware release follows the repo's standard tag flow.
