# Campaigns Increment 0b: Tarot Procedure Contract and Oracle Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an audited, deterministic, content-pack-driven inventory of every in-session tarot procedure, including the verbatim oracle lookup tables the guided procedures resolve against.

**Architecture:** A committed manifest names source headings and normalized procedure records. A new Node importer extracts both procedure definitions and oracle tables from the Markdown vault through a table-preserving extraction path, while Zod validates build output and Worker-bundled runtime imports. The audit document is generated from the same manifest so scope and implementation cannot drift independently.

**Tech Stack:** Node ESM scripts, gitignored Markdown vault at `assets-src/HMTW_md/`, JSON, TypeScript, Zod, Vitest.

## Scope decision: full lookup

The project owner decided on 2026-07-15 that oracle procedures **resolve the drawn card to its outcome text and log it**, rather than drawing a card and asking the GM to type an interpretation. This confirms specification §9:425 ("all draw counts, deck choices, **value tables** … live in a validated `tarot-procedures.json`"), §9's Sorcery row ("Configured private draw, reveal, **oracle**, selection, and reorder controls"), and §17.1's requirement for referential tests over "**lookup ranges**".

The superseded combined Increment 0 plan silently contradicted this: its contract had no field capable of holding a table, and Increment 4 Task 4 Step 3 resolved the gap with "The GM records a bounded free-text interpretation/outcome. The app does not generate prose." That sentence is withdrawn; see the Increment 4 amendment.

The licence permits this. The Adherent of the Worm licence reads "the mechanics and game text of His Majesty the Worm may be reused freely", and `denizens.json` already reproduces Appendix C verbatim.

## Two source facts that shape this plan

Both were verified against the vault, and both are why this increment cannot reuse the rules-import path wholesale.

**1. The rules path drops the two largest tables and structurally flattens the rest.** Two distinct problems, both verified by running the pipeline:

- `extractRuleBody` (`md-lib.mjs:240-244`) runs `stripExampleSubsections`, which drops any sub-section whose heading matches `/^example\b/i`. The two biggest oracle tables are titled `## Example Meatgrinder table` and `## Example City Events`, so extracting Meatgrinder through the rules path yields **zero table rows**. They are gone.
- Every *other* oracle table survives — We're Doomed (10 rows), Starting Disposition (9), Maleficence of the Wastes (16), Carouse/Hangover (23) — but only as **Markdown text inside a prose body**. There are no typed keys, so a range like `I–VII` is a string in a paragraph; and `stripWikilinks` (`md-lib.mjs:136-152`) has already flattened `[[13 - Appendix C - Dungeon Denizens#Imp|imp]]` to the bare word `imp`, destroying the reference target the coverage tests need.

Both behaviors are correct for the rules reference and must not be changed. Neither output is usable as structured lookup data, so this increment adds a parallel extraction path rather than reusing or modifying the rules path.

**2. The tables are structured data, not prose.** Verified shapes:

| Table | Deck | Axis | Key shape |
|---|---|---|---|
| Meatgrinder, City Events | minor | `card` | single numerals |
| Hangover | major | `card` | `I`–`XXI` |
| Maleficence ×4, Malediction | minor | `card` | `I`–`King` |
| We’re Doomed, Starting Disposition | minor | `card` | **ranges** — `I–VII`, `I–II` |
| Random Totem | minor | `card-by-suit` | 14 ranks × 4 suits |
| Doomsaying | minor | `suit-by-step` | 4 suits × 4 steps, four draws |

Range keys use an **en-dash** (`I–VII`), not a hyphen. Suit header cells contain `<img src="images/suit-swords.svg" …>` markup followed by the visible label. Six table cells contain live-value tokens — `[value]`, `[odd]`, `[even]`, `[discard]`, `[adventurers]` — which Chapter 9 defines: "Anything in brackets [ ] refers to the top card of the minor arcana discard pile." Four table cells contain wikilink cross-references to Appendix C denizens and Appendix B alchemy.

## Findings from an adversarial review (Codex gpt-5.5, 2026-07-15)

Seven issues found after 0b/0.5 merged. All fixed on `fix/campaigns-oracle-review-findings`. Recorded because the *pattern* matters more than the individual bugs.

**Three were the same mistake: reading where a rule is printed, not where it is used.** See roadmap decision D7.

1. **Signs and Portents was wrong, and so was the decision built on it.** Modelled as a fresh draw; Ch9:130 says the GM *looks at the top card of the minor arcana discard pile*. See the withdrawn D6.
2. **`gm-twist` consumed a card it should only read.** Ch10:354: "Glance at the top of the minor arcana discard pile." In a shared session a `draw` mutates the deck and changes later odds.
3. **The bracket convention was under-modelled.** Ch9:275 declares it for the Hangover table: *every* bracket refers to the discard top. The flat enum only matched `[value]`/`[odd]`/`[even]`, so `[Swords]`, `[1–2]` and `[9–King]` extracted as `tokens: []` — the suit- and range-branches, i.e. most of the rule. Now a typed union, opt-in per table so City Events' `[Curiosity]` labels are not mistyped as selectors.
4. **`<br>` was stripped without a space**, welding clauses: `"…on your face.• It is:"`. The Hangover rows were materially corrupted.
5. **`--check-generated` never verified table declarations.** It copied committed tables back in and compared only procedures/modifiers/formulas, so changing a table's `deck` or `source` in the manifest passed CI silently. Now checks every declared attribute; proven by tampering.
6. **`resolveTestOfFate` did not enforce the push precondition.** `canPush` is an output hint and cannot guard a caller. An initial success could be pushed into an automatic great failure. **The engine's own test was constructing that illegal state** (a 17 being pushed) and passed only because the guard was absent.
7. **The header comment overstated what CI proves.** `--check-generated` cannot prove row text matches the book — it has no book. Committed rows have *tamper-evidence* via the digest, not re-derivation. Now stated precisely.

**Test-quality lesson:** the token test matched cell text against the same enum the parser used — asserting the implementation back at itself, structurally unable to catch #3. Both replacements are mutation-tested: reintroduce the bug and they fail.

## Findings from executing Increment 0a

Four things surfaced while importing the rules prose. Each changes this increment's work, and each was verified against the vault.

**1. Three specification rule errors. Reconcile before authoring the manifest.**

| §9 / §8.7 claim | Source reality | Consequence |
|---|---|---|
| `Aim` is a Challenge modifier owned by the Challenge module (§8.7) | `Aim` appears **twice in the entire vault**, both in `09 - Chapter 9 …:760-762`, as a bullet inside the **Bows equipment** entry. There is no Chapter 7 heading. | The mechanic is real ("play your card facedown… reveal the card and add its value to your total Attack") and belongs in v1, but it is an equipment-granted action with no heading. `challenge-aim` needs a bullet anchor and cites no rules entry. |
| ~~"shield **Initiative replacement**" (§8.6, §8.7)~~ — **resolved, removed** | **No such mechanic exists.** `### Shield` (`09 - Chapter 9 …:683`) is about absorbing Notches. The only Initiative-adjacent shield rule is a **tie-break**: "Ties go to the attacker unless the defender has a shield" (`07 - Chapter 7 …:263`, `:415`, `:431`), which decides whether a Wound lands — and §8.6 excludes wound application from v1. | The specification was amended on 2026-07-15 to drop it, and Increment 3's `shield-initiative` modifier and `replace-initiative-with-shield` command were removed. **Do not author a manifest entry for it.** Both the described mechanic and the real one are out of scope. |
| Doomsaying, Strange Communions, As Above So Below are Appendix D Special City Actions (§9:444) | **Correct.** All three are bullets: `:806`, `:1050`, `:1066`. Beware `### As Above, So Below` at `10 - Chapter 10 …:594` — it is a *movie* in the Inspirational Media list. | All three need bullet anchors. `city-as-above-so-below` is a `reorder-top` over the minor deck's top three. |

**2. The privacy model's rulebook citation — resolved in 0a.** "No peeking!" — the design review's primary justification for hidden hands, and what §8.2 leans on — lives in an Obsidian **sidebar callout** (`07 - Chapter 7 …:338-340`), which `stripCallouts` removed by design, so `challenge-facedown-cards` did not contain the rule it is cited for.

Fixed with an opt-in `keepCallouts` manifest flag, chosen by the project owner on 2026-07-15. It **converts** the callout into the renderer's dialect (title → `###` sub-heading, body → paragraphs) rather than preserving it: `renderMarkdown` (`src/lib/utils/markdown.ts`) has no blockquote branch and escapes `>` to `&gt;`, so a retained `>` would render literally on the page. Callouts are still stripped by default. `challenge-facedown-cards` is the only entry that opts in — the regenerated `rules.json` diff was `+1/−1` — and its `mustContain` sentinel now fails the build if the privacy sentence ever drops out.

So `ruleEntryIds: ["challenge-facedown-cards"]` is a valid citation for the privacy model. **The "Four aces" poker-face sidebar (`:391-399`) is still unimported** — it sits under `3. Take turns`, not `Facedown cards`. If the audit wants it as a second privacy citation, add `keepCallouts` to `challenge-take-turns` and check the resulting diff; it will pull in that section's other callouts too.

**3. `md-rules.mjs` ignored the `after` anchor.** Fixed during 0a (`extractRuleBody` was called without `entry.after`, so a disambiguating entry silently imported the first match). `md-procedures.mjs` must pass `after` from the start — Chapter 7's `1. Draw Challenge cards` occurs three times, and the GM hand formula is the third.

**4. Not every table is stripped, and that matters for the audit.** See "Two source facts" below. Tables that survive into `rules.json` are prose with flattened cross-references; the same table extracted here must be the structured record. Expect the same text to exist in both files in different shapes — that is intended, not duplication to eliminate.

## Global Constraints

- Depends on Increment 0a. Every `ruleEntryId` must resolve against the committed `rules.json`; do not begin until `tests/unit/rules-coverage.test.ts` passes.
- Start from the approved procedure coverage in specification sections 8–9; do not infer preparation tooling back into v1.
- Classify each discovered occurrence as `supported-v1`, `deferred-preparation`, or `not-applicable-non-tarot`.
- Keep Doomsaying, Strange Communions, and As Above, So Below; defer the Job Board and other GM preparation generators.
- Retain the game's flat 50% manual non-tarot choice as a typed manual step; do not simulate it with a card draw.
- Table text is extracted by script and never retyped. A cell's verbatim text is generated output.
- Do not weaken `stripExampleSubsections` or any other rules-path behavior. Chapter 1–9 entries in `rules.json` must survive this increment byte-for-byte.
- A generated runtime session snapshot must remain below D1's 2 MB row limit.

---

### Task 1: Define the procedure and lookup contract

**Files:**
- Modify: `src/lib/types/content-pack.ts`
- Modify: `src/lib/schemas/content-pack.schema.ts`
- Modify: `static/content-packs/hmtw/index.json`
- Test: `tests/unit/content-pack.test.ts`

- [ ] **Step 1: Write the failing schema test**

```ts
import { getTarotProcedures } from '$lib/server/content/loader';

it('loads a unique, versioned tarot procedure catalog', () => {
	const file = getTarotProcedures();
	expect(file.schemaVersion).toBe(1);
	expect(file.procedures.length).toBeGreaterThan(0);
	expect(new Set(file.procedures.map((p) => p.id)).size).toBe(file.procedures.length);
	expect(file.procedures.every((p) => p.steps.length > 0)).toBe(true);
});

it('resolves every lookupTableId and every ruleEntryId', () => {
	const file = getTarotProcedures();
	const tableIds = new Set(file.lookupTables.map((t) => t.id));
	for (const procedure of file.procedures) {
		for (const step of procedure.steps) {
			if (step.lookupTableId) expect(tableIds.has(step.lookupTableId)).toBe(true);
		}
	}
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/content-pack.test.ts`

Expected: FAIL because `getTarotProcedures` and the manifest file key do not exist.

- [ ] **Step 3: Add the typed contract**

Specification §9:446 requires ten fields per definition: stable ID, title, exact rule-source citation, **deck**, visibility, **draw count or formula**, **lookup table if any**, legal actors, **result visibility**, completion boundary, and **recovery behavior**. The superseded plan carried only five of them. Add all of them to `src/lib/types/content-pack.ts`:

```ts
export type TarotProcedurePhase = 'crawl' | 'challenge' | 'camp' | 'city' | 'cross-phase';
export type TarotProcedureScope =
	| 'supported-v1'
	| 'deferred-preparation'
	| 'not-applicable-non-tarot';

export type TarotDeckId = 'major' | 'minor';

export type TarotOperation =
	| 'draw'
	| 'deal'
	| 'play'
	| 'place-facedown'
	| 'reveal'
	| 'discard'
	| 'transfer'
	| 'select-from-discard'
	| 'reorder-top'
	| 'mulligan'
	| 'consult-discard-top'
	| 'manual-choice';

/** A draw is either a fixed count or a named formula the engine implements. */
export type TarotDrawSpec =
	| { kind: 'fixed'; count: number }
	| { kind: 'formula'; formulaId: string };

/** Where a step's result becomes visible once resolved. */
export type TarotResultVisibility = 'public' | 'actor-private' | 'gm-private';

/** What happens to a partially-resolved step when a session is recovered or ended. */
export type TarotRecovery = 'discard-pending' | 'return-to-draw' | 'retain-pending';

export interface TarotProcedureStepDefinition {
	id: string;
	actor: 'gm' | 'player' | 'system';
	operation: TarotOperation;
	deck?: TarotDeckId;
	draw?: TarotDrawSpec;
	lookupTableId?: string;
	visibility: 'public' | 'actor-private' | 'recipient-private';
	resultVisibility: TarotResultVisibility;
	completion: 'automatic' | 'actor-confirmed' | 'gm-confirmed';
	recovery: TarotRecovery;
}

export interface TarotProcedureDefinition {
	id: string;
	title: string;
	phase: TarotProcedurePhase;
	scope: TarotProcedureScope;
	source: { file: string; heading: string };
	ruleEntryIds: string[];
	steps: TarotProcedureStepDefinition[];
	modifierIds: string[];
}
```

Then add the lookup contract. The three axes are dictated by the source, not invented:

```ts
/** Roman/court numeral key. `from`/`to` are equal for a single-card row. */
export interface TarotLookupKeyRange {
	kind: 'card-range';
	from: string;
	to: string;
}
export interface TarotLookupKeySuit {
	kind: 'suit';
	suit: string;
}
export type TarotLookupKey = TarotLookupKeyRange | TarotLookupKeySuit;

/** A live reference to table state, from the bracket convention in Ch9. */
export type TarotLookupToken = 'value' | 'suit' | 'odd' | 'even' | 'discard' | 'adventurers';

/** A cross-reference the source expressed as a wikilink. */
export interface TarotLookupReference {
	collection: 'denizens' | 'alchemy' | 'rules';
	entryId: string;
	label: string;
}

export interface TarotLookupCell {
	columnId: string;
	text: string;
	tokens: TarotLookupToken[];
	references: TarotLookupReference[];
}

export interface TarotLookupRow {
	key: TarotLookupKey;
	cells: TarotLookupCell[];
}

export interface TarotLookupTable {
	id: string;
	title: string;
	deck: TarotDeckId;
	axis: 'card' | 'card-by-suit' | 'suit-by-step';
	columns: { id: string; label: string }[];
	rows: TarotLookupRow[];
	source: { file: string; heading: string };
}

export interface TarotProceduresFile {
	schemaVersion: 1;
	procedures: TarotProcedureDefinition[];
	lookupTables: TarotLookupTable[];
	modifiers: SessionModifierDefinition[];
	formulas: TarotFormulaDefinition[];
}
```

Finally, add the modifier and formula catalogs. Both are required by specification §9:425 ("all draw counts … **modifiers**, and rule references live in a validated `tarot-procedures.json`") and both were referenced by downstream increments with no definition anywhere: Increment 2 consumes `modifiers: SessionModifierDefinition[]` in its runtime snapshot, Increment 3 asserts `challenge?.modifierIds` contains `'black-honey'`, and Increment 3's `calculateGmHandSize(config, enemies)` had no content source at all. Without these, `modifierIds: string[]` is a free-form string with nothing behind it.

```ts
/** A typed rule hook a procedure composes, e.g. Counsel's private transfer. */
export interface SessionModifierDefinition {
	id: string;
	title: string;
	/** The procedure whose hooks this modifier attaches to. */
	phase: TarotProcedurePhase;
	source: { file: string; heading: string };
	ruleEntryIds: string[];
	/** Named behavior the engine implements; content supplies parameters only. */
	behaviorId: string;
	params: Record<string, number | string | boolean>;
}

/** Parameters for a named formula the engine implements (e.g. the GM hand size). */
export interface TarotFormulaDefinition {
	id: string;
	title: string;
	source: { file: string; heading: string };
	ruleEntryIds: string[];
	params: Record<string, number>;
}
```

The GM per-round hand formula is the worked example. Chapter 7's GM section specifies "draw 3 Challenge cards from the **major arcana deck**" plus a list of additive modifiers, recomputed every round. Transcribed from the source:

```json
{
	"id": "gm-hand-size",
	"title": "GM Challenge hand size",
	"source": {
		"file": "07 - Chapter 7 - The Challenge Phase.md",
		"heading": "1. Draw Challenge cards",
		"after": "GMing the Challenge"
	},
	"ruleEntryIds": ["challenge-gm-hand-size"],
	"params": {
		"base": 3,
		"perEnemyType": 1,
		"enemiesOutnumberAdventurers": 1,
		"enemiesDoubleAdventurers": 1,
		"perLargerThanHumanEnemy": 1,
		"eliteEnemyPresent": 2,
		"dungeonLordPresent": 3
	}
},
{
	"id": "player-hand-size",
	"title": "Player Challenge hand size",
	"source": { "file": "07 - Chapter 7 - The Challenge Phase.md", "heading": "1. Draw Challenge cards" },
	"ruleEntryIds": ["challenge-draw-cards"],
	"params": { "base": 4 }
}
```

Two details this example exists to flag. **`1. Draw Challenge cards` occurs three times in Chapter 7** (`:29` flow summary, `:226` player rule, `:607` GM rule); without `after: "GMing the Challenge"`, `extractSection` silently takes the first match and the formula is wrong with no error. And the `eliteEnemyPresent: 2` / `dungeonLordPresent: 3` params are precisely the mechanic `CHANGELOG.md:43-46` deliberately kept off the Appendix C stat blocks and asked to be surfaced "when Chapter 7 combat content is imported" — Increment 0a's `challenge-gm-hand-size` entry is that surfacing, which is why the TODO sits on the critical path rather than being a loose end.

Increment 3's `calculateGmHandSize` reads this entry rather than defining its own `ChallengeConfig` literal, and `playerBaseHandSize` comes from `player-hand-size`. **Re-verify both against the source during Task 3 rather than trusting the transcription above.**

Modifier IDs are namespaced by their procedure, matching the manifest's procedure IDs: `challenge-black-honey`, `challenge-stun`, `challenge-counsel`, `camp-high-chant`. Increment 3 currently expects bare `'black-honey'`; the namespaced form wins, and Increment 3's test is amended to match.

Add required `tarotProcedures: string` to `ContentPackFiles`, mirror every union with Zod enums, and add `tarotProceduresFileSchema`. Add `"tarotProcedures": "tarot-procedures.json"` to `index.json` without changing the pack version yet; Task 5 performs the version bump.

- [ ] **Step 4: Run the focused type check**

Run: `npm run check`

Expected: **FAIL with ~9 errors, all in `tests/unit/tarot-procedures.test.ts`** — "has no exported member 'getTarotProcedures'" plus the implicit-`any` errors that cascade from it. `.svelte-kit/tsconfig.json` includes `../tests/**/*.ts`, so `check` typechecks tests, and the Step 1 test forward-references a loader export that Task 4 adds. The contract, the generated JSON, and the loader must land together before `check` can be green; it goes green at Task 4 Step 4.

Do not "fix" this by deleting the test or stubbing the loader against a JSON file that does not exist yet — the import would fail too. Prove the contract independently instead:

```bash
npx tsx -e "import { tarotProceduresFileSchema } from './src/lib/schemas/content-pack.schema';
  console.log(tarotProceduresFileSchema.safeParse(/* a representative record */).success)"
```

A representative record means one with a `card-range` key, a bracket token, and a denizen reference — the parts most likely to be mis-specified.

- [ ] **Step 5: Commit the contract**

```bash
git add src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts static/content-packs/hmtw/index.json tests/unit/content-pack.test.ts
git commit -m "feat(content): define tarot procedure and lookup catalog"
```

### Task 2: Add a table-preserving extraction path

**Files:**
- Modify: `scripts/content-import/md-lib.mjs`
- Test: `tests/unit/md-tables.test.ts`

- [ ] **Step 1: Write the failing extraction test**

Create `tests/unit/md-tables.test.ts`. These fixtures are real vault content, so this suite only runs where the vault is present:

```ts
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MD_DIR, extractTable } from '../../scripts/content-import/md-lib.mjs';

describe.skipIf(!existsSync(MD_DIR))('oracle table extraction', () => {
	it('preserves a table the rules path deliberately strips', () => {
		const table = extractTable('06 - Chapter 6 - The Crawl Phase.md', 'Example Meatgrinder table');
		expect(table.rows.length).toBeGreaterThan(0);
		expect(table.rows[0].cells[0].text).toContain('Torches gutter');
	});

	it('parses an en-dash range key without splitting it', () => {
		const table = extractTable('06 - Chapter 6 - The Crawl Phase.md', 'We’re doomed!');
		expect(table.rows[0].key).toEqual({ kind: 'card-range', from: 'I', to: 'VII' });
	});

	it('reads suit columns through the img markup', () => {
		const table = extractTable('11 - Appendix A - Sorcery.md', 'Random Totem');
		expect(table.columns.map((c) => c.label)).toEqual(['Swords', 'Cups', 'Pentacles', 'Wands']);
		expect(table.rows).toHaveLength(14);
	});

	it('retains wikilink cross-references instead of flattening them', () => {
		const table = extractTable('11 - Appendix A - Sorcery.md', 'Maleficence of the Wastes');
		const first = table.rows[0].cells[0];
		expect(first.references).toContainEqual({ collection: 'denizens', entryId: 'imp', label: 'imp' });
	});

	it('types bracket tokens', () => {
		const table = extractTable('09 - Chapter 9 - The City Phase.md', 'Carouse');
		const withValue = table.rows.find((r) => r.cells[0].tokens.includes('value'));
		expect(withValue).toBeDefined();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/md-tables.test.ts`

Expected: FAIL — `extractTable` is not exported.

- [ ] **Step 3: Implement `extractTable`**

Add to `md-lib.mjs` **without touching** `extractRuleBody`, `stripExampleSubsections`, or `normalizeMarkdown`. The new path deliberately diverges from the rules path in three ways, each for a verified reason:

1. It does **not** call `stripExampleSubsections` — the tables live under `Example …` headings.
2. It does **not** call `stripWikilinks` — the cross-references are data (`Maleficence I` → Appendix C imp).
3. It reads `<img alt="…">` before stripping HTML — the suit columns are identified by that alt text.

```js
/** Roman numerals plus the four court ranks, in minor-arcana order. */
const MINOR_KEYS = ['I','II','III','IV','V','VI','VII','VIII','IX','X','Page','Knight','Queen','King'];
const MAJOR_KEYS = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX','XXI'];
const TOKEN_RE = /\[(value|suit|odd|even|discard|adventurers)\]/g;

/** `I–VII` (en-dash) -> {from:'I', to:'VII'}; `I` -> {from:'I', to:'I'}. */
export function parseCardKey(raw) {
	const text = raw.replace(/<[^>]+>/g, '').trim();
	const m = /^(\S+)\s*[–-]\s*(\S+)$/.exec(text);
	return m
		? { kind: 'card-range', from: m[1], to: m[2] }
		: { kind: 'card-range', from: text, to: text };
}
```

`extractTable(file, heading, after)` calls `extractSection` directly, finds the first contiguous `|`-delimited block, splits the header row into columns (taking each cell's `<img alt>` when present, else its text), skips the `:---:` delimiter row, and maps each remaining row to `{ key, cells }`. For each cell: collect `tokens` via `TOKEN_RE`, collect `references` by parsing `[[<file>#<anchor>|<label>]]` into `{collection, entryId, label}`, then produce `text` by removing the wikilink syntax down to its label and stripping HTML. Sort nothing; source order is the table's order.

Derive `axis` from the header: a first column labelled `Suit` is `suit-by-step`; more than two columns whose labels are all suit names is `card-by-suit`; otherwise `card`.

- [ ] **Step 4: Run the extraction test**

Run: `npm test -- tests/unit/md-tables.test.ts`

Expected: PASS.

- [ ] **Step 5: Prove the rules path is untouched**

Run: `node scripts/content-import/md-rules.mjs --check`

Expected: `0 drifted`. If this reports drift, `md-lib.mjs` was changed in a way that leaked into the rules path — revert and re-isolate.

- [ ] **Step 6: Commit the extraction path**

```bash
git add scripts/content-import/md-lib.mjs tests/unit/md-tables.test.ts
git commit -m "feat(content): extract oracle tables without stripping examples"
```

### Task 3: Build the source manifest and coverage audit

**Files:**
- Create: `scripts/content-import/manifest/tarot-procedures-md.json`
- Create: `scripts/content-import/md-procedures.mjs`
- Create: `docs/rules/tarot-procedure-audit.md`
- Test: `tests/unit/tarot-procedure-audit.test.ts`

- [ ] **Step 1: Write the failing audit completeness test**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import manifest from '../../scripts/content-import/manifest/tarot-procedures-md.json';

const required = [
	'test-of-fate', 'group-test', 'challenge-round', 'challenge-black-honey',
	'challenge-stun', 'challenge-brainfever', 'challenge-counsel',
	'challenge-guardian-angel', 'challenge-aim',
	'camp-high-chant', 'camp-leeches', 'camp-watch', 'crawl-area-sense',
	'overland-travel', 'test-augury', 'city-doomsaying', 'city-strange-communions',
	'city-as-above-so-below', 'oracle-maleficence', 'oracle-malediction',
	'oracle-random-totem', 'gm-twist', 'denizen-disposition'
] as const;

describe('tarot procedure audit manifest', () => {
	it('classifies every required v1 procedure exactly once', () => {
		const ids = manifest.entries.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of required) expect(ids).toContain(id);
	});

	it('keeps preparation tools out of supported v1 scope', () => {
		const jobBoard = manifest.entries.find((entry) => entry.id === 'city-job-board');
		expect(jobBoard?.scope).toBe('deferred-preparation');
	});

	it('cites a real rules entry wherever one exists', () => {
		const known = new Set(
			JSON.parse(
				readFileSync('static/content-packs/hmtw/rules.json', 'utf8')
			).map((r) => r.id)
		);
		const supported = manifest.entries.filter((e) => e.scope === 'supported-v1');
		for (const entry of supported) {
			for (const id of entry.ruleEntryIds) expect(known).toContain(id);
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/tarot-procedure-audit.test.ts`

Expected: FAIL because the JSON manifest is absent.

**Two namespaces, deliberately distinct.** A procedure ID is the application's name for a flow; a `ruleEntryId` points at Increment 0a's rules entry, which is named after the book's heading. They frequently differ, and that is correct: procedure `camp-high-chant` cites rule entry `paths-high-chant` (Chapter 5), and procedure `camp-watch` cites `camp-no-rest-for-the-wicked` (the book has no heading named "Watch"). Do not rename either namespace to match the other.

- [ ] **Step 3: Author every manifest entry from the local Markdown**

Search the vault:

```bash
rg -n -i "tarot|arcana|card|draw|deal|discard|hand|fool|doom|initiative|oracle|augury|chant|leeches" assets-src/HMTW_md
```

For each match, record its source heading and one of the three scope statuses. Use this record shape:

```json
{
	"id": "camp-high-chant",
	"title": "High Chant",
	"phase": "camp",
	"scope": "supported-v1",
	"source": { "file": "05 - Chapter 5 - The Four Paths.md", "heading": "High Chant" },
	"ruleEntryIds": ["paths-high-chant"],
	"modifierIds": ["camp-high-chant"],
	"steps": [
		{
			"id": "select-inspiration",
			"actor": "player",
			"operation": "select-from-discard",
			"deck": "minor",
			"draw": { "kind": "formula", "formulaId": "high-chant-selection" },
			"visibility": "actor-private",
			"resultVisibility": "actor-private",
			"completion": "actor-confirmed",
			"recovery": "return-to-draw"
		},
		{
			"id": "transfer-card",
			"actor": "player",
			"operation": "transfer",
			"deck": "minor",
			"visibility": "recipient-private",
			"resultVisibility": "actor-private",
			"completion": "actor-confirmed",
			"recovery": "return-to-draw"
		}
	]
}
```

**Note the `source.file` above.** The superseded plan's example claimed `08 - Chapter 8 - The Camp Phase.md`, where no `High Chant` heading exists — it is a Chapter 5 Path talent that grants a Camp Action, and its rule entry is Increment 0a's `paths-high-chant`. Its selection count is "a number of cards from the minor arcana discard pile equal to your Cups", which is a per-character formula, not a fixed count — hence `formulaId`. `camp-leeches` is likewise sourced from Chapter 9, not Chapter 8. Verify every `source` against the vault; do not trust an example.

An entry that resolves a table adds a `lookupTable` block naming the source to extract:

```json
{
	"id": "oracle-maleficence",
	"title": "Maleficence",
	"phase": "cross-phase",
	"scope": "supported-v1",
	"source": { "file": "11 - Appendix A - Sorcery.md", "heading": "Maleficence" },
	"ruleEntryIds": ["sorcery-maleficence"],
	"modifierIds": [],
	"lookupTables": [
		{ "id": "maleficence-wastes", "title": "Maleficence of the Wastes", "deck": "minor",
			"source": { "file": "11 - Appendix A - Sorcery.md", "heading": "Maleficence of the Wastes" } }
	],
	"steps": [
		{
			"id": "draw-result",
			"actor": "gm",
			"operation": "draw",
			"deck": "minor",
			"draw": { "kind": "fixed", "count": 1 },
			"lookupTableId": "maleficence-wastes",
			"visibility": "public",
			"resultVisibility": "public",
			"completion": "gm-confirmed",
			"recovery": "discard-pending"
		}
	]
}
```

**Four entries need a bullet anchor, not a heading.** All are bullet list items no `extractSection` call can address:

| Entry | Source | Mechanic |
|---|---|---|
| `city-doomsaying` | `14 - Appendix D …:806` | Four minor draws; suit selects the row, step selects the column |
| `city-strange-communions` | `14 - Appendix D …:1050` | Draw Challenge cards from deck top, discard top, or a mix |
| `city-as-above-so-below` | `14 - Appendix D …:1066` | `reorder-top` over the minor deck's top three |
| `challenge-aim` | `09 - Chapter 9 …:760-762` | Bow equipment grants a facedown Swords action; reveal adds value to Attack |

Give those manifest entries an `anchor` field holding the bullet's exact leading text (`"- **Doomsaying:**"`), and have the importer locate the section by `after` + anchor rather than by heading alone. Their `ruleEntryIds` are `[]` — Increment 0a records why.

`extractSection` must never be pointed at `10 - Chapter 10 …:594` for As Above So Below; that heading is a movie review. §9:444 is right that all three City Actions are in Appendix D.

The importer calls `extractSection` for every declared file/heading so renamed or missing source headings fail the local build. It verifies every `ruleEntryId` exists in the committed `rules.json`. The manifest includes unsupported audit-only entries with an empty `steps` array; the generated runtime JSON filters those out, while the audit retains them.

- [ ] **Step 4: Implement deterministic generation and audit rendering**

```js
export function compileProcedureContent(entries, tables) {
	return {
		schemaVersion: 1,
		procedures: entries
			.filter((entry) => entry.scope === 'supported-v1')
			.sort((a, b) => a.id.localeCompare(b.id)),
		lookupTables: [...tables].sort((a, b) => a.id.localeCompare(b.id))
	};
}

export function renderAudit(entries) {
	const rows = [...entries]
		.sort((a, b) =>
			a.source.file.localeCompare(b.source.file) ||
			a.source.heading.localeCompare(b.source.heading) ||
			a.id.localeCompare(b.id)
		)
		.map((entry) =>
			`| ${entry.id} | ${entry.title.replaceAll('|', '\\|')} | ${entry.scope} | ${entry.source.file} — ${entry.source.heading.replaceAll('|', '\\|')} |`
		);
	return ['# Tarot Procedure Audit', '', '| ID | Procedure | Scope | Source |', '|---|---|---|---|', ...rows, ''].join('\n');
}
```

Sort entries by source file, source heading, then ID. Escape pipe characters in titles/headings. Do not include timestamps or local absolute paths. The executable writes both generated destinations in normal mode and compares byte-for-byte in `--check` mode, following `md-rules.mjs` conventions.

- [ ] **Step 5: Run and inspect the audit**

Run: `node scripts/content-import/md-procedures.mjs`

Expected: creates `static/content-packs/hmtw/tarot-procedures.json` and `docs/rules/tarot-procedure-audit.md` with deterministic ordering.

Run: `npm test -- tests/unit/tarot-procedure-audit.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the audited source map**

```bash
git add scripts/content-import/manifest/tarot-procedures-md.json scripts/content-import/md-procedures.mjs docs/rules/tarot-procedure-audit.md tests/unit/tarot-procedure-audit.test.ts static/content-packs/hmtw/tarot-procedures.json
git commit -m "feat(content): audit in-session tarot procedures"
```

### Task 4: Bundle, validate, and prove table coverage

**Files:**
- Modify: `src/lib/server/content/loader.ts`
- Modify: `tests/unit/content-pack.test.ts`
- Test: `tests/unit/tarot-procedures.test.ts`

- [ ] **Step 1: Add failing semantic and coverage tests**

The lookup-range coverage test is the one specification §17.1 names. It is the reason `card-range` keys are modelled rather than flattened:

```ts
import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildMajorDeck, buildPlayerDeck } from '$lib/engine/tarot-deck';

describe('tarot procedure semantics', () => {
	it('uses unique step ids and only supported runtime entries', () => {
		for (const procedure of getTarotProcedures().procedures) {
			expect(procedure.scope).toBe('supported-v1');
			expect(new Set(procedure.steps.map((s) => s.id)).size).toBe(procedure.steps.length);
			expect(procedure.steps.length).toBeGreaterThan(0);
		}
	});

	it('does not replace the manual 50 percent choice with a draw', () => {
		const manual = getTarotProcedures().procedures
			.flatMap((procedure) => procedure.steps)
			.find((step) => step.id === 'flat-fifty-percent-choice');
		expect(manual?.operation).toBe('manual-choice');
	});
});

describe('oracle lookup coverage', () => {
	it('covers every card of its deck exactly once, with no gaps or overlaps', () => {
		for (const table of getTarotProcedures().lookupTables) {
			if (table.axis === 'suit-by-step') continue; // keyed by suit, not card
			const hits = new Map<string, number>();
			for (const row of table.rows) {
				for (const key of expandRange(table.deck, row.key)) {
					hits.set(key, (hits.get(key) ?? 0) + 1);
				}
			}
			const expected = table.deck === 'major' ? 21 : 14;
			expect(hits.size, `${table.id} key count`).toBe(expected);
			for (const [key, count] of hits) {
				expect(count, `${table.id} key ${key} claimed ${count}x`).toBe(1);
			}
		}
	});

	it('resolves every cross-reference to a real content entry', () => {
		const denizens = new Set(/* load denizens.json ids */);
		for (const table of getTarotProcedures().lookupTables) {
			for (const row of table.rows) {
				for (const cell of row.cells) {
					for (const ref of cell.references) {
						if (ref.collection === 'denizens') expect(denizens.has(ref.entryId)).toBe(true);
					}
				}
			}
		}
	});
});
```

`expandRange` is a small test helper that walks the deck's ordered key list from `from` to `to` inclusive. This test is what catches a mis-transcribed `I–VII`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/tarot-procedures.test.ts`

Expected: FAIL because the loader does not export the catalog.

- [ ] **Step 3: Add the Worker-safe static import and cache**

```ts
import type { TarotProceduresFile } from '$lib/types/content-pack';
import { tarotProceduresFileSchema } from '$lib/schemas/content-pack.schema';
import tarotProceduresJson from '../../../../static/content-packs/hmtw/tarot-procedures.json';

let cachedTarotProcedures: TarotProceduresFile | null = null;

export function getTarotProcedures(): TarotProceduresFile {
	if (!cachedTarotProcedures) {
		cachedTarotProcedures = parseOrThrow(
			tarotProceduresFileSchema,
			tarotProceduresJson,
			'tarot-procedures.json'
		);
	}
	return cachedTarotProcedures;
}
```

Add `tarotProcedures: getTarotProcedures()` only to server-side bundles that need session startup; do not add it to the character wizard payload.

- [ ] **Step 4: Run content and unit checks**

```bash
npm test -- tests/unit/content-pack.test.ts tests/unit/tarot-procedures.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit runtime loading**

```bash
git add src/lib/server/content/loader.ts tests/unit/content-pack.test.ts tests/unit/tarot-procedures.test.ts
git commit -m "feat(content): load tarot procedure and lookup catalog"
```

### Task 5: Make content generation and version drift enforceable

**Files:**
- Modify: `package.json`
- Create: `scripts/content-import/verify-pack-version.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `static/content-packs/hmtw/index.json`
- Test: `tests/unit/content-build.test.ts`

- [ ] **Step 1: Add failing deterministic-build and size tests**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('generated session content', () => {
	it('fits within one D1 row with safety margin', () => {
		const bytes = readFileSync('static/content-packs/hmtw/tarot-procedures.json').byteLength;
		expect(bytes).toBeLessThan(1_900_000);
	});

	it('declares the post-import pack version', () => {
		const index = JSON.parse(readFileSync('static/content-packs/hmtw/index.json', 'utf8'));
		expect(index.version).not.toBe('1.0.0');
	});
});
```

- [ ] **Step 2: Run the test to verify the version assertion fails**

Run: `npm test -- tests/unit/content-build.test.ts`

Expected: FAIL while `index.json` is still version `1.0.0`.

- [ ] **Step 3: Wire build and check scripts**

```json
{
	"content:build": "node scripts/content-import/md-inject.mjs && node scripts/content-import/md-rules.mjs && node scripts/content-import/md-spells.mjs && node scripts/content-import/md-procedures.mjs",
	"content:verify": "node scripts/content-import/md-inject.mjs --check && node scripts/content-import/md-rules.mjs --check && node scripts/content-import/md-spells.mjs --check && node scripts/content-import/md-procedures.mjs --check && node scripts/content-import/verify-pack-version.mjs"
}
```

`verify-pack-version.mjs` computes SHA-256 over the generated content files in manifest-key order and compares it with a committed `contentDigest` field in `index.json`. Add that required field to `GuildBookContentPack` and `contentPackSchema` as a 64-character lowercase hexadecimal string. The verifier exits nonzero if current bytes do not match the digest. When `CONTENT_BASE_REF` is supplied, it reads the base revision's `index.json` with `git show`; if the digest changed but the semantic version did not, it exits nonzero. Use Node `createHash` and `execFileSync('git', ['show', ...])`; do not add a dependency or construct a shell command.

The digest input is exactly:

```js
const orderedFiles = Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b));
for (const [key, file] of orderedFiles) {
	hash.update(key);
	hash.update('\0');
	hash.update(readFileSync(join(packDir, file)));
	hash.update('\0');
}
```

- [ ] **Step 4: Bump the content pack and record its digest**

Set `index.json` to the next **major** pack version. The superseded plan said minor on the grounds that procedure capability is additive; that is no longer true. Increment 0a added Chapters 6–9 to `rules.json` and this increment adds a required `tarotProcedures` file key and a required `contentDigest` field, so a consumer pinned to `1.x` cannot read the new pack.

```bash
node scripts/content-import/verify-pack-version.mjs --write
npm run content:verify
```

Expected: PASS and `index.json` contains a 64-character lowercase `contentDigest`.

Add `md-procedures.mjs --check-generated`, which renders runtime JSON/audit from the committed manifest without opening the ignored Markdown, while the normal `--check` also validates every local source heading and re-extracts every table. Add:

```json
{
	"content:verify:ci": "node scripts/content-import/md-procedures.mjs --check-generated && node scripts/content-import/verify-pack-version.mjs && npm test -- tests/unit/content-pack.test.ts tests/unit/tarot-procedure-audit.test.ts tests/unit/tarot-procedures.test.ts tests/unit/content-build.test.ts"
}
```

Note the asymmetry `--check-generated` must respect: it can verify that committed procedure/table JSON matches what the committed manifest implies, but it cannot re-extract table *text* without the vault. Table text is therefore covered by digest integrity in CI and by full re-extraction locally. State that explicitly in the script's header comment rather than implying CI proves extraction fidelity.

Update both CI checkout steps to use full history, then add this source-free validation to the `check` job after `npm ci`:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- name: Verify generated content and pack version
  run: npm run content:verify:ci
  env:
    CONTENT_BASE_REF: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
```

CI must not require or download the ignored copyrighted Markdown source. `verify-pack-version.mjs` treats an absent/all-zero base on a repository's first push as current-integrity-only validation and prints that degraded comparison explicitly.

- [ ] **Step 5: Run the complete increment gate**

```bash
npm run content:build
npm run content:verify
npm test -- tests/unit/content-pack.test.ts tests/unit/tarot-procedure-audit.test.ts tests/unit/tarot-procedures.test.ts tests/unit/content-build.test.ts tests/unit/md-tables.test.ts tests/unit/rules-coverage.test.ts
npm run check
npm test
```

Expected: every command exits 0; a second `npm run content:build` produces no diff.

- [ ] **Step 6: Commit Increment 0b**

```bash
git add package.json scripts/content-import/verify-pack-version.mjs src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts static/content-packs/hmtw/index.json tests/unit/content-build.test.ts .github/workflows/ci.yml
git commit -m "build(content): enforce deterministic procedure imports"
```

## Increment 0b Completion Record — executed 2026-07-15

**Status: complete. Gate A2 passes.**

| Measure | Result |
|---|---|
| Audit entries | **34** — 30 `supported-v1`, 3 `deferred-preparation`, 1 `not-applicable-non-tarot` |
| Runtime catalog | 30 procedures, 14 lookup tables (**194 rows**), 7 modifiers, 3 formulas |
| Size | 115 KB — well inside D1's 2 MB row limit |
| `md-procedures --check` | `30 procedures, 14 tables (194 rows), 0 drifted` |
| `md-rules --check` | `54 rules, 0 drifted` — the rules path was not disturbed |
| `npm run content:verify` | all collections 0 drifted; digest OK |
| `npm run check` | 0 errors |
| `npm test` | 186 passed |
| Pack version | 1.0.0 → **2.0.0**, digest `8746a1af…` |

**Found by tests, not review.** Each of these would have shipped silently:

- **`splitRow` shattered every wikilink cell.** The vault writes `[[13 - Appendix C - Dungeon Denizens#Imp|imp]]` *unescaped* inside table cells, so splitting on `|` dropped the reference. Maleficence row I extracted with zero references.
- **`inferDeck` guessed wrong on Signs and Portents**, silently returning `major` and leaving XV–XXI uncovered. Replaced with declare-and-verify (see D6).
- **A running page header became a phantom cell.** Malediction's King row ends `… APPENDIX A | SORCERY |` in the export. `normalizeMarkdown` already strips this for the rules path; the table path now does too.
- **Signs keys minor ranks as Roman XI–XIV** while every other minor table uses `Page/Knight/Queen/King`. Keys normalize to one notation; cell text stays verbatim.
- **`TarotSourceRef` required a `heading`** the Appendix D Special City Actions do not have.
- **The typecheck graph regressed 0 → 49 errors.** `md-tables.test.ts` importing `md-lib.mjs` dragged the plain-ESM build scripts into `svelte-check` under `checkJs`. `scripts/` is outside tsconfig's `include`, so `@ts-nocheck` restores that boundary explicitly.

**Verified, not assumed:** both drift guards were made to fail on purpose — a hand-edited generated cell is rejected, and a content change under an unchanged version is rejected. `ADAPTER=cloudflare npm run build` fails with `ETIMEDOUT` in this sandbox, but **fails identically at the 0a merge commit**, so it is environmental (no network egress), not a regression.

**Deferred to the audit, with rationale:** `city-job-board` (Ch9 `Example Contracts` — "Draw ~5 cards to create a job board", a preparation generator §9 defers by name), `city-creation-districts`, `underworld-creation`, and the flat-50% rules (`not-applicable-non-tarot`, modelled as a `manual-choice` step and never simulated with a draw).

**Open for a later spec amendment:** `deckScope` is a contract addition §8.4 does not describe — that section covers exhaustion and the Fool for the session decks only. Fold it in alongside the D6 decision.

## Original Completion Record (plan)

Record the content-pack version, digest, generated procedure count, lookup-table count and per-table row count, each classification count, runtime JSON byte size, and verification command output in the implementation PR. Explicitly record:

- That `md-rules.mjs --check` still reports `0 drifted`, proving the rules path was not disturbed.
- The Doomsaying and Strange Communions anchor selectors, since they are the only two entries not addressed by heading.

Do not begin Increment 0.5 until every required in-session rule has a manifest classification and the lookup-range coverage test passes.
