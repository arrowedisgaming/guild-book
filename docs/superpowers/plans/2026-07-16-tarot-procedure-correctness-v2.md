# Tarot Procedure Correctness v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the schema-v1 tarot procedure catalog with a schema-v2, call-site-audited catalog; correct every rule mismatch found across all 31 supported procedures; and fix the existing Test of Fate and group-test runtime defects.

**Architecture:** The committed manifest remains the authoring surface and the generated JSON remains the only application runtime input. Schema v2 adds non-empty `invokedFrom` citations and a narrow set of typed step metadata for verified sources, conditions, choices, effects, limits, duration, and reshuffling; domain tasks fill those fields and assert semantics without building future Campaign runners. Existing pure engine/store/UI code changes only where Guild Book already executes the affected rule.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, strict TypeScript, Zod, JSON content manifests, Node ESM content importers, Vitest, Playwright.

## Global Constraints

- Work only in `.worktrees/tarot-procedure-correctness-v2` on `codex/tarot-procedure-correctness-v2`.
- Base this increment on `fc30837` and preserve the completed second-review correction commits.
- Treat the Fool reshuffle trigger as `fool-drawn`; the lone `played` wording is an owner-confirmed rulebook erratum.
- Re-audit all 31 `supported-v1` procedures against every material call site, not one representative citation.
- `source` is where a rule is defined; `invokedFrom` is a non-empty, duplicate-free array of every location that materially changes its invocation.
- The Markdown vault is local build/verification input only. Never import it from `src/`, bundle it, copy it into `static/`, or read it at application runtime.
- Move `tarot-procedures.json` from schema version `1` to `2`.
- Move the HMTW content pack from `2.3.0` to `3.0.0` and regenerate `contentDigest` only after generated content is stable.
- Do not add campaign tables, routes, authorization, session commands, reducers, projections, or full phase runners.
- Keep engine functions pure: no UI, DB, `$app`, or `$lib/server` imports.
- Every domain correction needs a named semantic test; ID-presence tests alone are insufficient.
- Mutation-test every new integrity guard where practical.
- Run an independent adversarial review before the final implementation commit and address every Critical or Important finding.

---

## File responsibility map

- `src/lib/types/content-pack.ts` — schema-v2 public TypeScript contract, narrow step metadata, and typed modifier definitions.
- `src/lib/schemas/content-pack.schema.ts` — exact Zod mirror of the TypeScript contract.
- `scripts/content-import/manifest/tarot-procedures-md.json` — reviewed authoring surface for citations and all corrected procedure semantics.
- `scripts/content-import/md-procedures.mjs` — vault-time citation validation, manifest-to-runtime compilation, and deterministic audit rendering.
- `docs/rules/tarot-procedure-audit.md` — generated human review surface with separate definition and invocation columns.
- `static/content-packs/hmtw/tarot-procedures.json` — generated schema-v2 runtime catalog.
- `tests/unit/tarot-procedure-audit.test.ts` — authoring-surface completeness, citation-shape, and unsupported-scope rules.
- `tests/unit/tarot-procedures.test.ts` — runtime schema/references and domain semantic assertions.
- `src/lib/engine/tarot-resolution.ts` — pure Test-of-Fate provenance logic.
- `src/lib/engine/tarot-group-test.ts` — pure exact-arity/distinct-actor group-test logic.
- `src/lib/engine/tarot-deck.ts` — pure two-deck Fool reshuffle with card conservation.
- `src/lib/stores/tarot-deck.ts` — client table state owning both player/minor and GM/major piles for Test of Fate.
- `src/lib/components/tarot/TestOfFate.svelte` — existing reference UI that performs the reshuffle without erasing the visible result.
- `tests/e2e/deck-test-of-fate.spec.ts` — browser proof of the live declaration, Fool, and reshuffle behavior.

---

### Task 1: Add schema-v2 invocation citations and deterministic validation

**Files:**
- Modify: `src/lib/types/content-pack.ts:475-553`
- Modify: `src/lib/schemas/content-pack.schema.ts:389-455`
- Modify: `scripts/content-import/md-procedures.mjs:35-110,220-224`
- Modify: `scripts/content-import/manifest/tarot-procedures-md.json`
- Modify: `tests/unit/tarot-procedure-audit.test.ts`
- Modify: `tests/unit/tarot-procedures.test.ts`
- Generate: `docs/rules/tarot-procedure-audit.md`
- Generate: `static/content-packs/hmtw/tarot-procedures.json`

**Interfaces:**
- Consumes: existing `TarotSourceRef`, `extractSection()`, bullet-anchor resolution, and the 35-entry audit manifest.
- Produces: schema-v2 `TarotProcedureDefinition.invokedFrom: [TarotSourceRef, ...TarotSourceRef[]]`, `validateProcedureManifestSources(manifest)`, and a two-location audit table.

- [ ] **Step 1: Write the failing authoring-surface citation tests**

Extend the manifest test shape and add these assertions:

```ts
import type { TarotSourceRef } from '$lib/types/content-pack';

type ManifestEntry = {
	id: string;
	title: string;
	scope: string;
	source: TarotSourceRef;
	invokedFrom?: TarotSourceRef[];
	rationale?: string;
	ruleEntryIds: string[];
	steps: ManifestStep[];
};

const sourceKey = (source: TarotSourceRef) =>
	JSON.stringify([source.file, source.heading ?? null, source.after ?? null, source.anchor ?? null]);

it('gives every supported procedure non-empty, unique invocation evidence', () => {
	for (const entry of manifest.entries) {
		if (entry.scope !== 'supported-v1') continue;
		expect(entry.invokedFrom?.length ?? 0, entry.id).toBeGreaterThan(0);
		const keys = entry.invokedFrom!.map(sourceKey);
		expect(new Set(keys).size, `${entry.id} duplicate invokedFrom`).toBe(keys.length);
		for (const ref of entry.invokedFrom!) {
			expect(ref.file, entry.id).toMatch(/\.md$/);
			expect(Boolean(ref.heading || ref.anchor), entry.id).toBe(true);
		}
	}
});
```

In `tests/unit/tarot-procedures.test.ts`, change the version assertion and add:

```ts
expect(file.schemaVersion).toBe(2);
for (const procedure of file.procedures) {
	expect(procedure.invokedFrom.length, procedure.id).toBeGreaterThan(0);
}
```

- [ ] **Step 2: Run the focused tests and verify the intended failure**

Run:

```bash
npm test -- tests/unit/tarot-procedure-audit.test.ts tests/unit/tarot-procedures.test.ts
```

Expected: FAIL because current entries have no `invokedFrom` and the runtime schema version is `1`.

- [ ] **Step 3: Add the schema-v2 TypeScript and Zod contract**

Change the file version and procedure definition:

```ts
export interface TarotProceduresFile {
	schemaVersion: 2;
	procedures: TarotProcedureDefinition[];
	lookupTables: TarotLookupTable[];
	modifiers: SessionModifierDefinition[];
	formulas: TarotFormulaDefinition[];
}

export interface TarotProcedureDefinition {
	id: string;
	title: string;
	phase: TarotProcedurePhase;
	scope: 'supported-v1';
	source: TarotSourceRef;
	invokedFrom: [TarotSourceRef, ...TarotSourceRef[]];
	ruleEntryIds: string[];
	steps: TarotProcedureStepDefinition[];
	modifierIds: string[];
}
```

Mirror it in Zod:

```ts
export const tarotProcedureDefinitionSchema = z.object({
	id: z.string(),
	title: z.string(),
	phase: tarotProcedurePhaseEnum,
	scope: z.literal('supported-v1'),
	source: tarotSourceRefSchema,
	invokedFrom: z.array(tarotSourceRefSchema).min(1),
	ruleEntryIds: z.array(z.string()),
	steps: z.array(tarotProcedureStepDefinitionSchema),
	modifierIds: z.array(z.string())
});

export const tarotProceduresFileSchema = z.object({
	schemaVersion: z.literal(2),
	procedures: z.array(tarotProcedureDefinitionSchema),
	lookupTables: z.array(tarotLookupTableSchema),
	modifiers: z.array(sessionModifierDefinitionSchema),
	formulas: z.array(tarotFormulaDefinitionSchema)
});
```

- [ ] **Step 4: Validate every definition and invocation reference locally**

In `md-procedures.mjs`, set `SCHEMA_VERSION = 2` and add:

```js
const sourceKey = (source) =>
	JSON.stringify([source.file, source.heading ?? null, source.after ?? null, source.anchor ?? null]);

export function validateProcedureManifestSources(manifest) {
	for (const entry of manifest.entries) {
		assertSourceResolves(entry.source, `${entry.id}.source`);
		if (entry.scope !== 'supported-v1') continue;
		if (!Array.isArray(entry.invokedFrom) || entry.invokedFrom.length === 0) {
			throw new Error(`[${entry.id}] supported-v1 needs invokedFrom`);
		}
		const keys = entry.invokedFrom.map(sourceKey);
		if (new Set(keys).size !== keys.length) {
			throw new Error(`[${entry.id}] duplicate invokedFrom citation`);
		}
		entry.invokedFrom.forEach((source, index) =>
			assertSourceResolves(source, `${entry.id}.invokedFrom[${index}]`)
		);
	}
}
```

Call this once from `main()` before table extraction. Keep modifier/formula source validation unchanged.

- [ ] **Step 5: Render definition and invocation evidence separately**

Replace the audit row/header shape with:

```js
const formatSource = (source) => {
	const where = source.heading ?? `(bullet) ${source.anchor}`;
	return `${escapePipes(source.file)} — ${escapePipes(where)}`;
};

const invoked = entry.invokedFrom?.map(formatSource).join('<br>') ?? '';
return `| ${entry.id} | ${escapePipes(entry.title)} | ${entry.scope} | ${formatSource(entry.source)} | ${invoked} | ${escapePipes(entry.rationale ?? '')} |`;
```

Use headers:

```md
| ID | Procedure | Scope | Defined at | Invoked from | Rationale |
|---|---|---|---|---|---|
```

- [ ] **Step 6: Perform the first complete call-site pass and populate all 31 arrays**

For each supported ID, search both direct prose and wikilinks. Use the exact source file/title inventory emitted by:

```bash
node - <<'NODE'
const manifest = require('./scripts/content-import/manifest/tarot-procedures-md.json');
for (const entry of manifest.entries.filter((entry) => entry.scope === 'supported-v1')) {
	console.log(`${entry.id}\t${entry.title}\t${entry.source.file}`);
}
NODE
```

Search rules text with both the procedure title and its mechanical effect. The mandatory mechanical searches are:

```bash
rg -n -i 'test(s)? of fate|push(ing)? fate|group test|Fool (was )?(drawn|played)' assets-src/HMTW_md --glob '*.md'
rg -n -i 'Initiative|Challenge cards|Brainfever|Counsel|Guardian Angel|Black honey|Aim|Guard' assets-src/HMTW_md --glob '*.md'
rg -n -i 'Meatgrinder|moving carefully|loud noise|on watch|Patrol|High Chant|Leeches|Area Sense|Starting Disposition|We.re doomed' assets-src/HMTW_md --glob '*.md'
rg -n -i 'City Events|Signs and Portents|Beg and Busk|Carouse|Doomsaying|Strange communions|As above so below' assets-src/HMTW_md --glob '*.md'
rg -n -i 'Augury|Maleficence|Malediction|Random Totem|Creating surprises' assets-src/HMTW_md --glob '*.md'
```

Add every location that changes trigger, source, branch, result, timing, duration, or frequency. Ignore flavor-only mentions and examples that add no rule. A self-contained rule repeats `source` in `invokedFrom`; do not leave the array absent.

- [ ] **Step 7: Regenerate and prove local citation resolution**

Run:

```bash
npm run content:procedures
npm test -- tests/unit/tarot-procedure-audit.test.ts tests/unit/tarot-procedures.test.ts
npm run content:verify
```

Expected: schema version 2 loads; all 31 supported entries have unique invocation citations; all vault references resolve; generated files report zero drift after regeneration.

- [ ] **Step 8: Mutation-test missing and duplicate invocation guards**

Temporarily remove one supported entry's `invokedFrom` and run `node scripts/content-import/md-procedures.mjs --check`; expect a focused `supported-v1 needs invokedFrom` error. Restore it, duplicate one reference, rerun, and expect `duplicate invokedFrom citation`. Restore the manifest and rerun the focused tests.

- [ ] **Step 9: Commit the citation foundation**

```bash
git add src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts \
  scripts/content-import/md-procedures.mjs scripts/content-import/manifest/tarot-procedures-md.json \
  docs/rules/tarot-procedure-audit.md static/content-packs/hmtw/tarot-procedures.json \
  tests/unit/tarot-procedure-audit.test.ts tests/unit/tarot-procedures.test.ts
git commit -m "feat(content): require tarot invocation citations"
```

---

### Task 2: Add the narrow typed step-correctness vocabulary

**Files:**
- Modify: `src/lib/types/content-pack.ts:483-550`
- Modify: `src/lib/schemas/content-pack.schema.ts:405-455`
- Modify: `tests/unit/tarot-procedures.test.ts`

**Interfaces:**
- Consumes: schema-v2 procedures from Task 1.
- Produces: optional, Zod-validated `cardSource`, `conditions`, `choice`, `effects`, `costs`, `limits`, `timing`, `duration`, `reshuffle`, and `lookupTableIds` fields used by Tasks 3–7.

- [ ] **Step 1: Write failing schema tests for each new discriminant**

Import `tarotProcedureDefinitionSchema` and add a `validProcedure(step)` fixture that supplies the required definition-level fields. Call `tarotProcedureDefinitionSchema.safeParse(validProcedure(step))` for one valid complex step and each invalid variant. For the valid result, assert success and assert that the parsed step still contains every new field; this makes the test fail against the current stripping schema. The valid step must include:

```ts
{
	id: 'example',
	actor: 'gm',
	operation: 'draw',
	deck: 'minor',
	draw: { kind: 'fixed', count: 1 },
	cardSource: { kind: 'draw-pile', deck: 'minor', provenance: 'test-draw' },
	conditions: [{ kind: 'lookup-key', tableId: 'malediction', keys: ['I'] }],
	choice: {
		kind: 'choose-lookup-table',
		selector: 'far-realm',
		tableIds: ['maleficence-wastes', 'maleficence-weald']
	},
	effects: [{ kind: 'resource', resource: 'gold', amount: { kind: 'card-value-plus-attribute', attribute: 'wands' } }],
	costs: [{ kind: 'resource', resource: 'resolve', amount: 2, timing: 'per-watch' }],
	limits: [{ kind: 'per-round', count: 1 }],
	timing: { kind: 'event', event: 'city-phase-end' },
	duration: { kind: 'until', boundary: 'used' },
	reshuffle: { trigger: 'fool-drawn', decks: ['minor', 'major'], boundary: 'test-resolution' },
	visibility: 'public',
	resultVisibility: 'public',
	completion: 'gm-confirmed',
	recovery: 'discard-pending'
}
```

Invalid cases must reject an empty `tableIds`, an empty `keys`, a non-positive cost or limit, and a reshuffle deck list that omits either physical deck.

- [ ] **Step 2: Run the schema tests and verify they fail**

```bash
npm test -- tests/unit/tarot-procedures.test.ts
```

Expected: FAIL because the step schema strips/rejects the new fields.

- [ ] **Step 3: Add exact TypeScript unions**

Add these types and fields without creating an interpreter:

```ts
export type TarotCardProvenance = 'procedure-draw' | 'test-draw' | 'supplied';

export type TarotCardSourceRule =
	| { kind: 'draw-pile'; deck: TarotDeckId; provenance: TarotCardProvenance }
	| { kind: 'discard-top'; deck: TarotDeckId; consume: boolean }
	| { kind: 'discard-selection'; deck: TarotDeckId }
	| { kind: 'mixed'; deck: TarotDeckId; sources: ['draw-pile', 'discard-top'] };

export type TarotStepCondition =
	| { kind: 'lookup-key'; tableId: string; keys: [string, ...string[]] }
	| { kind: 'card-suit'; suits: [SuitId, ...SuitId[]] }
	| { kind: 'value-range'; from: string; to: string; include: boolean }
	| { kind: 'entry-state'; state: 'unused' | 'used' }
	| { kind: 'game-state'; state: 'guild-out-of-light' }
	| { kind: 'percent-chance'; percent: number }
	| { kind: 'previous-result'; result: 'success' | 'failure' | 'random-encounter' | 'non-encounter' };

export type TarotStepChoice =
	| { kind: 'accept-or-decline'; acceptStepId: string; declineStepId: string }
	| { kind: 'choose-one'; fromStepId: string; count: number; rejectConditions?: TarotStepCondition[] }
	| { kind: 'choose-lookup-table'; selector: 'far-realm'; tableIds: [string, ...string[]] }
	| { kind: 'mixed-source'; sources: ['draw-pile', 'discard-top'] };

export type TarotAmount =
	| { kind: 'fixed'; value: number }
	| { kind: 'card-value' }
	| { kind: 'card-value-plus-attribute'; attribute: SuitId }
	| { kind: 'formula'; formulaId: string }
	| { kind: 'full' };

export type TarotStepEffect =
	| { kind: 'resource'; resource: 'gold' | 'resolve' | 'charges' | 'visions'; amount: TarotAmount }
	| { kind: 'test-modifier'; modifier: 'favor' | 'disfavor'; appliesTo: 'attack' | 'test-of-fate' }
	| { kind: 'test-bonus'; amount: number; appliesTo: 'known-action' | 'attack' | 'test-of-fate' }
	| { kind: 'affliction-cure'; charges: number }
	| { kind: 'teeth-loss'; from: number; to: number }
	| { kind: 'bound-by-fate' }
	| { kind: 'mark-entry-used' }
	| { kind: 'no-op' }
	| { kind: 'card-movement'; from: TarotCardZone; to: TarotCardZone };

export type TarotCardZone =
	| 'draw-pile'
	| 'discard'
	| 'hand'
	| 'initiative'
	| 'facedown'
	| 'inspiration'
	| 'table';

export type TarotStepCost =
	| { kind: 'resource'; resource: 'gold' | 'resolve' | 'charges'; amount: number; timing: 'before-step' | 'per-use' | 'per-watch' }
	| { kind: 'action-budget'; budget: 'challenge' | 'miscellaneous' };

export type TarotUsageLimit =
	| { kind: 'per-round'; count: number }
	| { kind: 'per-session'; count: number }
	| { kind: 'per-watch'; count: number }
	| { kind: 'max-held'; count: number }
	| { kind: 'single-instance'; count: 1 }
	| { kind: 'once-next-expedition'; count: 1 };

export type TarotStepTiming =
	| { kind: 'immediate' }
	| { kind: 'event'; event: 'city-phase-end' | 'waking' | 'eating' | 'nightly' | 'prophecy-fulfilled' };

export type TarotDurationRule = {
	kind: 'until';
	boundary: 'used' | 'round-end' | 'session-end' | 'next-attack' | 'next-expedition-end' | 'spell-dismissed-or-countered';
};

export type TarotReshuffleRule = {
	trigger: 'fool-drawn';
	decks: ['minor', 'major'];
	boundary: 'test-resolution' | 'challenge-round-end';
};
```

Expand the step actor union from `'gm' | 'player' | 'system'` to `'gm' | 'player' | 'each-player' | 'system'` so the Doom procedure does not collapse an all-player draw into one actor. Extend `TarotProcedureStepDefinition` with these exact optional fields:

```ts
cardSource?: TarotCardSourceRule;
conditions?: TarotStepCondition[];
choice?: TarotStepChoice;
effects?: TarotStepEffect[];
costs?: TarotStepCost[];
limits?: TarotUsageLimit[];
timing?: TarotStepTiming;
duration?: TarotDurationRule;
reshuffle?: TarotReshuffleRule;
lookupTableIds?: [string, ...string[]];
```

Use `procedure-draw` for ordinary oracle, Meatgrinder, Initiative, and similar deck draws. Reserve `test-draw` for a card genuinely drawn to resolve a Test of Fate and `supplied` for a card inserted by Augury, High Chant, or an equivalent rule.

- [ ] **Step 4: Mirror the unions in Zod with positive/non-empty constraints**

Use `z.discriminatedUnion('kind', ...)`; use `.positive()` for costs/counts/charges and tuple/rest or `.array(...).min(1)` for non-empty lists. Make `test-bonus.amount` an integer and constrain `percent-chance.percent` to an integer from 1 through 99. Add a `superRefine` to the step schema that rejects simultaneous `lookupTableId` and `lookupTableIds`, and rejects a `cardSource.deck` different from `step.deck`.

- [ ] **Step 5: Run type/schema gates**

```bash
npm test -- tests/unit/tarot-procedures.test.ts
npm run check
```

Expected: PASS with the new metadata accepted and malformed shapes rejected.

- [ ] **Step 6: Commit the schema vocabulary**

```bash
git add src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts tests/unit/tarot-procedures.test.ts
git commit -m "feat(content): type tarot procedure semantics"
```

---

### Task 3: Correct Test-of-Fate, group-test, Augury, and High Chant content

**Files:**
- Modify: `scripts/content-import/manifest/tarot-procedures-md.json`
- Modify: `tests/unit/tarot-procedures.test.ts`
- Generate: `docs/rules/tarot-procedure-audit.md`
- Generate: `static/content-packs/hmtw/tarot-procedures.json`

**Interfaces:**
- Consumes: Task 2 step metadata.
- Produces: rule-complete cross-phase procedures and provenance declarations consumed by Task 8's engine changes.

- [ ] **Step 1: Write failing semantic tests**

Add helpers `procedure(id)` and `step(procedureId, stepId)`, then assert:

```ts
it('records supplied-card provenance and the Fool draw trigger', () => {
	expect(step('test-of-fate', 'draw')).toMatchObject({
		cardSource: { kind: 'draw-pile', deck: 'minor', provenance: 'test-draw' },
		reshuffle: { trigger: 'fool-drawn', decks: ['minor', 'major'], boundary: 'test-resolution' }
	});
	expect(procedure('group-test').steps.filter((s) => s.operation === 'draw')).toHaveLength(2);
});

it('models both Augury decisions without granting supplied cards great-success provenance', () => {
	const augury = procedure('test-augury');
	expect(augury.steps.map((s) => s.id)).toEqual([
		'private-draw', 'describe-parable', 'choose-course', 'accept-card', 'decline-card'
	]);
	expect(step('test-augury', 'choose-course').choice).toEqual({
		kind: 'accept-or-decline', acceptStepId: 'accept-card', declineStepId: 'decline-card'
	});
	expect(step('test-augury', 'accept-card').cardSource).toEqual({
		kind: 'draw-pile', deck: 'minor', provenance: 'supplied'
	});
	expect(step('test-augury', 'decline-card').effects).toContainEqual({ kind: 'bound-by-fate' });
});

it('keeps High Chant inspiration supplied, bounded, and expiring', () => {
	const highChant = procedure('camp-high-chant');
	expect(highChant.steps.flatMap((s) => s.limits ?? [])).toContainEqual({ kind: 'max-held', count: 1 });
	expect(highChant.steps.some((s) => s.duration?.boundary === 'session-end')).toBe(true);
	expect(highChant.steps.some((s) => s.cardSource?.kind === 'discard-selection')).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify semantic failures**

```bash
npm test -- tests/unit/tarot-procedures.test.ts
```

Expected: FAIL on missing Augury branches, provenance, High Chant use/expiry metadata, and Fool reshuffle metadata.

- [ ] **Step 3: Update the four manifest entries and their invocation citations**

Use these canonical semantics:

- `test-of-fate`: initial and push steps are minor draw-pile operations with `test-draw` provenance; both carry the `fool-drawn` two-deck trigger at `test-resolution`; push retains `previous-step-failed`.
- `group-test`: exactly two draw steps, most-qualified then least-qualified; cite the Group Tests definition and the Retreating call site.
- `test-augury`: GM private draw, public parable without revealing the card, explicit accept/decline choice, accepted card marked `supplied`, decline discards and applies Bound by Fate, Resolve remains a pre-test option, push remains legal.
- `camp-high-chant`: discard selection count uses `high-chant-selection`, distribution allows at most one held per player, uses include Challenge action or replacement of Test-of-Fate initial/push draw, every use is `supplied`, and cards expire when used or at session end.

- [ ] **Step 4: Regenerate and verify**

```bash
npm run content:procedures
npm test -- tests/unit/tarot-procedures.test.ts tests/unit/tarot-procedure-audit.test.ts
npm run content:verify
```

Expected: all four semantic tests pass and content reports zero drift.

- [ ] **Step 5: Commit cross-phase content**

```bash
git add scripts/content-import/manifest/tarot-procedures-md.json \
  static/content-packs/hmtw/tarot-procedures.json docs/rules/tarot-procedure-audit.md \
  tests/unit/tarot-procedures.test.ts
git commit -m "fix(content): correct test and inspiration procedures"
```

---

### Task 4: Correct Challenge procedure and typed modifiers

**Files:**
- Modify: `src/lib/types/content-pack.ts`
- Modify: `src/lib/schemas/content-pack.schema.ts`
- Modify: `scripts/content-import/manifest/tarot-procedures-md.json`
- Modify: `tests/unit/tarot-procedures.test.ts`
- Generate: `docs/rules/tarot-procedure-audit.md`
- Generate: `static/content-packs/hmtw/tarot-procedures.json`

**Interfaces:**
- Consumes: Task 2 metadata and current `behaviorId` modifier dispatch.
- Produces: a Zod-discriminated `SessionModifierDefinition` union and rule-complete Challenge data for future runners.

- [ ] **Step 1: Write failing Challenge semantic tests**

Assert that `challenge-round` includes distinct minor/player and major/GM Initiative placement/reveal/cleanup steps, and a two-deck `fool-drawn` round-end reshuffle. Add one exact assertion for each modifier:

```ts
expect(modifier('challenge-black-honey')).toMatchObject({
	behaviorId: 'optional-hand-size',
	params: { normalCards: 4, optionalCards: 5, teethLostFrom: 1, teethLostTo: 4 }
});
expect(modifier('challenge-brainfever')).toMatchObject({
	params: { initiativeSelection: 'lowest-value', attacksHaveFavor: true, requiresEmotion: true, duration: 'concentration' }
});
expect(modifier('challenge-counsel')).toMatchObject({
	params: {
		timing: 'any-time-during-challenge', suitMustMatchAction: true,
		maxUsesPerRound: 1, resolveCostForInterrupt: 1
	}
});
expect(modifier('challenge-guardian-angel')).toMatchObject({
	params: {
		placement: 'facedown', allowedActions: 'dodge-or-riposte', cumulative: true,
		exemptFromFacedownLimit: true, maxInstances: 1, targetRequired: true, duration: 'until-used'
	}
});
expect(modifier('challenge-aim')).toMatchObject({
	params: {
		requiresBow: true, suit: 'swords', placement: 'facedown', targetRequired: true,
		revealOn: 'next-bow-attack', addsCardValue: true
	}
});
expect(modifier('challenge-guard')).toMatchObject({
	params: { requiresShield: true, anySuit: true, actionBudget: 'miscellaneous', discardsOldInitiative: true }
});
expect(modifier('camp-high-chant')).toMatchObject({
	behaviorId: 'inspiration-distribution',
	params: {
		maxHeldPerPlayer: 1, challengeActionBudget: 'challenge', testUse: 'replace-initial-or-push',
		provenance: 'supplied', expires: 'used-or-session-end'
	}
});
expect(modifier('challenge-stun')).toMatchObject({
	behaviorId: 'forced-hand-discard',
	params: { immediate: true, discard: 'entire-hand' }
});
```

These assertions make Stun's immediate whole-hand discard and High Chant's bounded supplied-card lifecycle part of the typed modifier contract.

- [ ] **Step 2: Run the focused tests and verify failures**

```bash
npm test -- tests/unit/tarot-procedures.test.ts
```

Expected: FAIL on missing GM Initiative steps and incomplete/wrong modifier parameters.

- [ ] **Step 3: Replace the untyped modifier record with a discriminated union**

Define a shared base and the exact parameter interfaces for every existing `behaviorId`:

```ts
interface ModifierBase<B extends string, P> {
	id: string;
	title: string;
	phase: TarotProcedurePhase;
	source: TarotSourceRef;
	ruleEntryIds: string[];
	behaviorId: B;
	params: P;
}

export interface InspirationDistributionParams {
	maxHeldPerPlayer: number;
	challengeActionBudget: 'challenge';
	testUse: 'replace-initial-or-push';
	provenance: 'supplied';
	expires: 'used-or-session-end';
}

export interface PreparedFacedownBonusParams {
	requiresBow: boolean;
	suit: SuitId;
	placement: 'facedown';
	targetRequired: boolean;
	revealOn: 'next-bow-attack';
	addsCardValue: boolean;
}

export interface OptionalHandSizeParams {
	normalCards: number;
	optionalCards: number;
	teethLostFrom: number;
	teethLostTo: number;
}

export interface ForcedInitiativeSelectionParams {
	initiativeSelection: 'lowest-value';
	attacksHaveFavor: boolean;
	requiresEmotion: boolean;
	duration: 'concentration';
}

export interface CounselTransferParams {
	timing: 'any-time-during-challenge';
	suitMustMatchAction: boolean;
	maxUsesPerRound: number;
	resolveCostForInterrupt: number;
}

export interface ReplaceInitiativeParams {
	requiresShield: boolean;
	anySuit: boolean;
	actionBudget: 'miscellaneous';
	discardsOldInitiative: boolean;
}

export interface GuardianAngelParams {
	placement: 'facedown';
	allowedActions: 'dodge-or-riposte';
	cumulative: boolean;
	exemptFromFacedownLimit: boolean;
	maxInstances: number;
	targetRequired: boolean;
	duration: 'until-used';
}

export interface ForcedHandDiscardParams {
	immediate: boolean;
	discard: 'entire-hand';
}

export type SessionModifierDefinition =
	| ModifierBase<'inspiration-distribution', InspirationDistributionParams>
	| ModifierBase<'prepared-facedown-bonus', PreparedFacedownBonusParams>
	| ModifierBase<'optional-hand-size', OptionalHandSizeParams>
	| ModifierBase<'forced-initiative-selection', ForcedInitiativeSelectionParams>
	| ModifierBase<'private-transfer', CounselTransferParams>
	| ModifierBase<'replace-initiative', ReplaceInitiativeParams>
	| ModifierBase<'guardian-angel-defense', GuardianAngelParams>
	| ModifierBase<'forced-hand-discard', ForcedHandDiscardParams>;
```

Use `z.discriminatedUnion('behaviorId', [...])` with strict, field-complete param object schemas matching these interfaces. Use positive integers for counts/costs and `SuitId` for suit fields, but keep canonical HMTW values in the manifest and semantic tests rather than TypeScript/Zod literals. Do not retain the permissive `Record<string, number | string | boolean>` fallback.

- [ ] **Step 4: Correct Challenge steps and modifier content**

Update `challenge-round` so player Initiative uses minor cards, GM Initiative uses facedown major cards per significant enemy/group, reveal steps exist for both, cleanup discards remaining minor and major hands, facedown actions persist, and reshuffle is conditional on `fool-drawn` at `challenge-round-end`.

Update Brainfever, Counsel, Guardian Angel, Black Honey, Aim, Guard, Stun, and High Chant to satisfy the exact typed union and tests. Preserve the GM hand formula's `perEnemyType` parameters.

- [ ] **Step 5: Regenerate and run Challenge gates**

```bash
npm run content:procedures
npm test -- tests/unit/tarot-procedures.test.ts tests/unit/tarot-procedure-audit.test.ts
npm run check
npm run content:verify
```

Expected: Challenge semantic tests pass, schema rejects malformed params, and content has zero drift.

- [ ] **Step 6: Mutation-test one parameter per previously incomplete modifier**

Temporarily remove `attacksHaveFavor`, change Counsel's max uses to `2`, remove Guardian Angel's facedown exemption, and return Black Honey to a flat delta. Run the focused test after each mutation and confirm the named assertion fails. Restore each mutation and rerun green.

- [ ] **Step 7: Commit Challenge corrections**

```bash
git add src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts \
  scripts/content-import/manifest/tarot-procedures-md.json \
  static/content-packs/hmtw/tarot-procedures.json docs/rules/tarot-procedure-audit.md \
  tests/unit/tarot-procedures.test.ts
git commit -m "fix(content): make Challenge procedures rule-complete"
```

---

### Task 5: Correct Crawl and Camp procedures

**Files:**
- Modify: `scripts/content-import/manifest/tarot-procedures-md.json`
- Modify: `tests/unit/tarot-procedures.test.ts`
- Generate: `docs/rules/tarot-procedure-audit.md`
- Generate: `static/content-packs/hmtw/tarot-procedures.json`

**Interfaces:**
- Consumes: typed conditions/choices/effects from Task 2.
- Produces: rule-complete Meatgrinder, Camp watch/Patrol, Leeches, Area Sense, disposition, doom, and travel definitions.

- [ ] **Step 1: Write failing Crawl/Camp semantic tests**

Add exact assertions that:

- `crawl-meatgrinder` has ordinary-room (unfiltered), moving-carefully (I–V), loud-noise (XVI–XX), and used-entry/no-op semantics from verified call sites.
- `camp-watch` first draws the major Meatgrinder, then runs watch selection/Cups test only under `random-encounter`.
- `camp-patrol` draws two and chooses a non-encounter result when possible; a Challenge occurs only if both are encounters.
- `camp-leeches` branches on Swords/Pentacles versus Cups/Wands and the success branch counts as two charges toward curing an affliction.
- `crawl-area-sense` costs two Resolve per watch and produces `card-value` visions.
- `denizen-disposition` consumes no card and cites both Starting Disposition and the social-encounter call site.
- `overland-travel` runs one Meatgrinder draw per watch.
- `crawl-were-doomed` gives each player one minor draw and resolves the full Doom table only when the guild is completely out of light sources.

Representative assertions:

```ts
expect(step('camp-watch', 'draw-meatgrinder')).toMatchObject({
	operation: 'draw', deck: 'major', lookupTableId: 'meatgrinder'
});
expect(step('camp-watch', 'watch-cups-test').conditions).toContainEqual({
	kind: 'previous-result', result: 'random-encounter'
});
expect(step('camp-leeches', 'cure-affliction').effects).toContainEqual({
	kind: 'affliction-cure', charges: 2
});
expect(step('crawl-area-sense', 'resolve-visions').effects).toContainEqual({
	kind: 'resource', resource: 'visions', amount: { kind: 'card-value' }
});
expect(step('crawl-area-sense', 'pay-resolve').costs).toContainEqual({
	kind: 'resource', resource: 'resolve', amount: 2, timing: 'per-watch'
});
expect(step('crawl-were-doomed', 'draw-doom')).toMatchObject({
	actor: 'each-player', operation: 'draw', deck: 'minor', lookupTableId: 'were-doomed',
	conditions: [{ kind: 'game-state', state: 'guild-out-of-light' }]
});
```

- [ ] **Step 2: Run focused tests and confirm failures**

```bash
npm test -- tests/unit/tarot-procedures.test.ts
```

Expected: FAIL because the current catalog records only the draws for most of these procedures.

- [ ] **Step 3: Update citations and procedure steps from the verified rules**

Use Ch6's Meatgrinder, Moving Carefully, Loud Noises, and room-entry call sites; Ch8's No Rest for the Wicked, Patrol, and Overland Travel; Ch4's Area Sense; Ch5's High Chant; and Ch9's Leeches. Add all mechanically distinct call sites found by the Task 1 searches, including time/noise call sites outside the table's defining chapter.

Do not encode the Camp watch Cups test unconditionally. Do not encode Patrol as a plain two-card result. Do not convert used-entry depletion into card removal unless the source requires removal; represent the no-op/mark-used behavior explicitly.

- [ ] **Step 4: Regenerate and verify Crawl/Camp content**

```bash
npm run content:procedures
npm test -- tests/unit/tarot-procedures.test.ts tests/unit/tarot-procedure-audit.test.ts
npm run content:verify
```

Expected: all named semantics pass; local call sites resolve; zero drift.

- [ ] **Step 5: Commit Crawl/Camp corrections**

```bash
git add scripts/content-import/manifest/tarot-procedures-md.json \
  static/content-packs/hmtw/tarot-procedures.json docs/rules/tarot-procedure-audit.md \
  tests/unit/tarot-procedures.test.ts
git commit -m "fix(content): correct Crawl and Camp procedures"
```

---

### Task 6: Correct City procedures and repair rules references

**Files:**
- Modify: `scripts/content-import/manifest/tarot-procedures-md.json`
- Modify: `scripts/content-import/manifest/rules-md.json`
- Modify: `tests/unit/rules-coverage.test.ts`
- Modify: `tests/unit/tarot-procedures.test.ts`
- Generate: `docs/rules/tarot-procedure-audit.md`
- Generate: `static/content-packs/hmtw/rules.json`
- Generate: `static/content-packs/hmtw/tarot-procedures.json`

**Interfaces:**
- Consumes: typed step effects/choices and existing table-reference extraction.
- Produces: complete City semantics and a rules-reference set that resolves every `collection: "rules"` lookup reference.

- [ ] **Step 1: Write failing City and rules-reference tests**

Add assertions for:

```ts
expect(step('city-signs-and-portents', 'consult-discard-top').cardSource).toEqual({
	kind: 'discard-top', deck: 'minor', consume: false
});
expect(step('city-beg-and-busk', 'resolve-earnings').effects).toContainEqual({
	kind: 'resource', resource: 'gold',
	amount: { kind: 'card-value-plus-attribute', attribute: 'wands' }
});
expect(step('city-strange-communions', 'choose-source').choice).toEqual({
	kind: 'mixed-source', sources: ['draw-pile', 'discard-top']
});
expect(step('city-strange-communions', 'choose-source').limits).toContainEqual({
	kind: 'once-next-expedition', count: 1
});
expect(step('city-doomsaying', 'pay-fee').costs).toContainEqual({
	kind: 'resource', resource: 'gold', amount: 10, timing: 'before-step'
});
expect(step('city-doomsaying', 'fulfill-prophecy').effects).toContainEqual({
	kind: 'resource', resource: 'resolve', amount: { kind: 'full' }
});
expect(step('city-doomsaying', 'fulfill-prophecy').timing).toEqual({
	kind: 'event', event: 'prophecy-fulfilled'
});
```

Also validate rule references from lookup cells:

```ts
it('resolves every rules cross-reference to a real entry', () => {
	const ruleIds = new Set(getRules().map((rule) => rule.id));
	for (const table of getTarotProcedures().lookupTables) {
		for (const row of table.rows) for (const cell of row.cells) {
			for (const ref of cell.references) {
				if (ref.collection === 'rules') {
					expect(ruleIds.has(ref.entryId), `${table.id} cites rules ${ref.entryId}`).toBe(true);
				}
			}
		}
	}
});
```

Add `guild-deeds-and-fame` to `REQUIRED_IDS` in `rules-coverage.test.ts`.

- [ ] **Step 2: Run focused tests and confirm the two broken references**

```bash
npm test -- tests/unit/tarot-procedures.test.ts tests/unit/rules-coverage.test.ts
```

Expected: FAIL for `social-encounters-disposition` and `7-deeds-and-fame`, plus missing City step semantics.

- [ ] **Step 3: Import Deeds and Fame and correct normalized reference IDs**

Add a rules manifest entry:

```json
{
	"id": "guild-deeds-and-fame",
	"section": "guild",
	"title": "Deeds and Fame",
	"file": "03 - Chapter 3 - The Guild.md",
	"heading": "7. Deeds and Fame",
	"tags": ["guild", "fame", "city"]
}
```

Normalize extracted rule references so `Social Encounters & Disposition` maps to `crawl-social-encounters-disposition` and `7. Deeds and Fame` maps to `guild-deeds-and-fame`. Put this mapping in the manifest/import path, not as a hand edit to generated JSON.

- [ ] **Step 4: Correct City procedure semantics**

- City Events: major draw, consult table, mark used result, and cite the City step plus upkeep/restock call site.
- Signs: trigger only on City Events XXI and consult the minor discard top without consuming it.
- Beg & Busk: minor draw, then award card value plus Wands in gold.
- Carouse: major Hangover draw and minor-discard bracket convention.
- Doomsaying: pay 10g, draw four minors, read suit rows left-to-right, and allow one future full Resolve refill when the prophecy is fulfilled.
- Strange Communions: choose deck top, discard top, or a mix once during the next expedition; expire at next-expedition end.
- As Above So Below: privately inspect exactly the top three minor cards and replace those same cards in any order.

- [ ] **Step 5: Regenerate all affected content and verify**

```bash
npm run content:rules
npm run content:procedures
npm test -- tests/unit/rules-coverage.test.ts tests/unit/tarot-procedures.test.ts tests/unit/tarot-procedure-audit.test.ts
npm run content:verify
```

Expected: every rules reference resolves; City tests pass; rules/procedures report zero drift.

- [ ] **Step 6: Mutation-test the rules-reference gate**

Temporarily change `guild-deeds-and-fame` back to `7-deeds-and-fame` in the generated reference path and run the focused test. Expected: FAIL naming the exact table and missing rules ID. Restore and rerun green.

- [ ] **Step 7: Commit City/reference corrections**

```bash
git add scripts/content-import/manifest/tarot-procedures-md.json scripts/content-import/manifest/rules-md.json \
  static/content-packs/hmtw/rules.json static/content-packs/hmtw/tarot-procedures.json \
  docs/rules/tarot-procedure-audit.md tests/unit/rules-coverage.test.ts tests/unit/tarot-procedures.test.ts
git commit -m "fix(content): correct City procedures and references"
```

---

### Task 7: Correct sorcery and oracle branching/timing

**Files:**
- Modify: `scripts/content-import/manifest/tarot-procedures-md.json`
- Modify: `tests/unit/tarot-procedures.test.ts`
- Generate: `docs/rules/tarot-procedure-audit.md`
- Generate: `static/content-packs/hmtw/tarot-procedures.json`

**Interfaces:**
- Consumes: `lookupTableIds`, choice, condition, duration, and effect metadata from Task 2.
- Produces: one-table Maleficence, result-specific delayed Malediction, and verified Random Totem/GM Twist definitions.

- [ ] **Step 1: Write failing sorcery/oracle semantic tests**

```ts
it('chooses one Maleficence realm and draws once', () => {
	const maleficence = procedure('oracle-maleficence');
	expect(maleficence.steps.filter((s) => s.operation === 'draw')).toHaveLength(1);
	expect(step('oracle-maleficence', 'draw-maleficence').choice).toMatchObject({
		kind: 'choose-lookup-table', selector: 'far-realm'
	});
	expect(step('oracle-maleficence', 'draw-maleficence').lookupTableIds).toEqual([
		'maleficence-wastes', 'maleficence-weald', 'maleficence-weird', 'maleficence-welkin'
	]);
});

it('scopes Malediction checks to the four actual delayed results', () => {
	const checks = procedure('oracle-malediction').steps.filter((s) => s.id.startsWith('delayed-'));
	expect(checks.map((s) => s.id)).toEqual([
		'delayed-city-dogs', 'delayed-waking-dreams', 'delayed-eating-ash', 'delayed-nightly-vermin'
	]);
	expect(checks.map((s) => s.conditions?.[0])).toEqual([
		{ kind: 'lookup-key', tableId: 'malediction', keys: ['I'] },
		{ kind: 'lookup-key', tableId: 'malediction', keys: ['II'] },
		{ kind: 'lookup-key', tableId: 'malediction', keys: ['III'] },
		{ kind: 'lookup-key', tableId: 'malediction', keys: ['IX'] }
	]);
	expect(checks.map((s) => s.timing)).toEqual([
		{ kind: 'event', event: 'city-phase-end' },
		{ kind: 'event', event: 'waking' },
		{ kind: 'event', event: 'eating' },
		{ kind: 'event', event: 'nightly' }
	]);
	for (const check of checks) {
		expect(check.conditions).toContainEqual({ kind: 'percent-chance', percent: 50 });
	}
});

it('records Random Totem\'s known-action bonus', () => {
	expect(step('oracle-random-totem', 'apply-known-action-bonus').effects).toContainEqual({
		kind: 'test-bonus', amount: 5, appliesTo: 'known-action'
	});
});

it('keeps GM Twist as a non-consuming discard-top glance', () => {
	expect(step('gm-twist', 'consult-discard-top').cardSource).toEqual({
		kind: 'discard-top', deck: 'minor', consume: false
	});
});
```

- [ ] **Step 2: Run the tests and verify failures**

```bash
npm test -- tests/unit/tarot-procedures.test.ts
```

Expected: FAIL because Maleficence currently has four consecutive draws and Malediction has one unconditional 50-percent step.

- [ ] **Step 3: Correct manifest entries and call-site evidence**

- Maleficence: choose the appropriate Wastes/Weald/Weird/Welkin table, then perform one minor draw against the selected table.
- Malediction: draw the curse once; add delayed checks only for I at City end, II on waking, III on eating, and IX nightly. The curse lasts until dismissed or counter-spelled.
- Random Totem: preserve one minor draw, card-by-suit lookup, and the `+5` known-action test bonus.
- GM Twist: consult without consuming the minor discard top.
- Augury remains as corrected in Task 3; include any additional material invocation citations found during the sorcery-wide reread.

- [ ] **Step 4: Regenerate and verify**

```bash
npm run content:procedures
npm test -- tests/unit/tarot-procedures.test.ts tests/unit/tarot-procedure-audit.test.ts
npm run content:verify
```

Expected: one Maleficence draw, four correctly scoped and timed Malediction checks, Random Totem's +5 effect, and zero drift.

- [ ] **Step 5: Mutation-test branch cardinality**

Temporarily restore a second Maleficence draw and make Malediction's 50-percent step unconditional. Run the focused test after each mutation and confirm the named semantic assertion fails. Restore and rerun green.

- [ ] **Step 6: Commit sorcery/oracle corrections**

```bash
git add scripts/content-import/manifest/tarot-procedures-md.json \
  static/content-packs/hmtw/tarot-procedures.json docs/rules/tarot-procedure-audit.md \
  tests/unit/tarot-procedures.test.ts
git commit -m "fix(content): correct sorcery and oracle procedures"
```

---

### Task 8: Enforce Test-of-Fate provenance and exact group-test arity

**Files:**
- Modify: `src/lib/engine/tarot-resolution.ts`
- Modify: `src/lib/engine/tarot-group-test.ts`
- Modify: `tests/unit/tarot-resolution.test.ts`
- Modify: `tests/unit/tarot-group-test.test.ts`
- Modify: `tests/unit/tarot.test.ts`

**Interfaces:**
- Consumes: Task 3's `test-draw` versus `supplied` provenance contract.
- Produces: `ResolutionCard.origin`, provenance-aware great success, distinct group actors, and exact two-outcome resolution.

- [ ] **Step 1: Write failing provenance tests**

Update the shared test input helper so normal cards default to `origin: 'test-draw'`, then add:

```ts
it('does not great-succeed with a matching card supplied by another source', () => {
	const result = resolveTestOfFate(config, input({
		attribute: 4,
		testedSuit: 'swords',
		initialCard: { id: 'swords-x', value: 10, suit: 'swords', origin: 'supplied' }
	}));
	expect(result.outcome).toBe('success');
	expect(result.initialDrawMatchedTestedSuit).toBe(false);
});

it('still great-succeeds with a genuine matching initial test draw', () => {
	const result = resolveTestOfFate(config, input({
		attribute: 4,
		testedSuit: 'swords',
		initialCard: { id: 'swords-x', value: 10, suit: 'swords', origin: 'test-draw' }
	}));
	expect(result.outcome).toBe('great-success');
});
```

- [ ] **Step 2: Write failing group-test guard tests**

Replace the solo-enabling test with:

```ts
it('rejects a solo roster', () => {
	expect(() => selectGroupTestActors(roster(3))).toThrow(/at least two distinct/);
});

it('selects distinct actors when every attribute ties', () => {
	const selection = selectGroupTestActors(roster(3, 3, 3));
	expect(selection.mostQualified.id).not.toBe(selection.leastQualified.id);
	expect(selection.requiresTableDecision).toBe(true);
});

it('requires exactly two outcomes', () => {
	expect(() => resolveGroupTest(config, ['success'])).toThrow(/exactly two/);
	expect(() => resolveGroupTest(config, ['success', 'failure', 'success'])).toThrow(/exactly two/);
});
```

- [ ] **Step 3: Run focused engine tests and verify failures**

```bash
npm test -- tests/unit/tarot-resolution.test.ts tests/unit/tarot-group-test.test.ts tests/unit/tarot.test.ts
```

Expected: supplied matching card incorrectly great-succeeds; solo roster and arbitrary outcome counts are accepted.

- [ ] **Step 4: Implement minimal provenance logic**

```ts
export type ResolutionCardOrigin = 'test-draw' | 'supplied';

export interface ResolutionCard {
	id: string;
	value: number;
	suit?: SuitId;
	origin: ResolutionCardOrigin;
}
```

Change the match calculation to:

```ts
const initialDrawMatchedTestedSuit =
	input.initialCard.origin === 'test-draw' && input.initialCard.suit === input.testedSuit;
```

All direct callers/tests must explicitly provide provenance; do not default missing runtime input to a trusted draw.

- [ ] **Step 5: Implement exact and distinct group guards**

Reject fewer than two unique candidate IDs. When the deterministic most-qualified actor is also the first least-qualified candidate, select the next least-qualified tied candidate so the proposal contains two distinct actors and keep `requiresTableDecision = true`.

At the start of `resolveGroupTest` add:

```ts
if (outcomes.length !== 2) {
	throw new Error(`a group test requires exactly two outcomes; received ${outcomes.length}`);
}
```

- [ ] **Step 6: Run engine and full unit gates**

```bash
npm test -- tests/unit/tarot-resolution.test.ts tests/unit/tarot-group-test.test.ts tests/unit/tarot.test.ts
npm test
npm run check
```

Expected: all focused and full unit tests pass with strict TypeScript.

- [ ] **Step 7: Mutation-test trusted provenance and group arity**

Temporarily remove the origin check and confirm the supplied-card test fails. Temporarily remove the outcome-count guard and confirm the one-/three-result cases fail. Restore and rerun green.

- [ ] **Step 8: Commit engine guards**

```bash
git add src/lib/engine/tarot-resolution.ts src/lib/engine/tarot-group-test.ts \
  tests/unit/tarot-resolution.test.ts tests/unit/tarot-group-test.test.ts tests/unit/tarot.test.ts
git commit -m "fix(tarot): enforce provenance and group arity"
```

---

### Task 9: Perform the Fool reshuffle in the live Test-of-Fate client

**Files:**
- Modify: `src/lib/engine/tarot-deck.ts`
- Modify: `src/lib/stores/tarot-deck.ts`
- Modify: `src/lib/components/tarot/TestOfFate.svelte`
- Create: `tests/unit/tarot-table-store.test.ts`
- Modify: `tests/unit/tarot.test.ts`
- Modify: `tests/e2e/deck-test-of-fate.spec.ts`

**Interfaces:**
- Consumes: `TestOfFateResult.foolDrawn`, `ResolutionCard.origin`, player deck (56 minors + Fool), and GM major deck (I–XXI).
- Produces: pure `reshuffleAfterFool()`, store method `reshuffleForFool()`, `foolReshuffled` state, and visible automatic reshuffle behavior.

- [ ] **Step 1: Write failing pure card-conservation tests**

Define `DeckZones<T> = { drawPile: T[]; discard: T[]; held: T[] }` and test:

```ts
it('reshuffles both remaining decks while preserving visible cards', () => {
	const player = buildPlayerDeck(config);
	const major = buildMajorDeck(config);
	const result = reshuffleAfterFool(
		{ drawPile: player.slice(2), discard: [player[1]], held: [player[0]] },
		{ drawPile: major.slice(2), discard: [major[1]], held: [major[0]] },
		makeRng('player-fool'),
		makeRng('major-fool')
	);

	expect(result.player.held).toEqual([player[0]]);
	expect(result.major.held).toEqual([major[0]]);
	expect(result.player.discard).toEqual([]);
	expect(result.major.discard).toEqual([]);
	expect(new Set([...result.player.drawPile, ...result.player.held].map((c) => c.id)).size).toBe(57);
	expect(new Set([...result.major.drawPile, ...result.major.held].map((c) => c.id)).size).toBe(21);
});
```

- [ ] **Step 2: Write failing store/component-facing tests**

In the new store test, create a seeded table, draw the initial Fool with `e2e-8`, call `reshuffleForFool()`, and assert:

- the Fool remains in `hand`;
- both player and GM discard piles are empty;
- `foolReshuffled` is true;
- a following push draws without duplicating or losing a card; and
- a second call for the same visible hand is idempotent.

- [ ] **Step 3: Run focused tests and verify failures**

```bash
npm test -- tests/unit/tarot.test.ts tests/unit/tarot-table-store.test.ts
```

Expected: FAIL because neither the pure two-deck helper nor store method/state exists.

- [ ] **Step 4: Implement the pure two-deck reshuffle**

```ts
export interface DeckZones<T extends TarotCard> {
	drawPile: T[];
	discard: T[];
	held: T[];
}

const reshuffleRemaining = <T extends TarotCard>(zones: DeckZones<T>, rng: Rng): DeckZones<T> => ({
	drawPile: shuffle([...zones.drawPile, ...zones.discard], rng),
	discard: [],
	held: zones.held.slice()
});

export function reshuffleAfterFool<P extends TarotCard, M extends TarotCard>(
	player: DeckZones<P>,
	major: DeckZones<M>,
	playerRng: Rng,
	majorRng: Rng
) {
	return {
		player: reshuffleRemaining(player, playerRng),
		major: reshuffleRemaining(major, majorRng)
	};
}
```

The helper must never include `held` cards in a shuffled pile.

- [ ] **Step 5: Extend table state to own the GM deck and a result-lifetime marker**

Add `gmDrawPile`, `gmDiscard`, and `foolReshuffled` to `TableState`. Build and initially shuffle the GM pile with `shuffleDeck(buildMajorDeck(config), gmRng)`. Capture one `runtimeSeed`, then create separate player and GM RNGs (`makeRng(runtimeSeed)` and `makeRng(`${runtimeSeed}:major`)`) so shuffling the hidden major deck does not consume the player RNG or alter existing seeded initial draws. Update `reshuffleAll()` and `reset()` to initialize both physical decks consistently.

Expose:

```ts
reshuffleForFool() {
	update((state) => {
		if (state.foolReshuffled || !state.hand.some((card) => card.id === 'fool')) return state;
		const next = reshuffleAfterFool(
			{ drawPile: state.drawPile, discard: state.discard, held: state.hand },
			{ drawPile: state.gmDrawPile, discard: state.gmDiscard, held: [] },
			rng,
			gmRng
		);
		return {
			...state,
			drawPile: next.player.drawPile,
			discard: next.player.discard,
			hand: next.player.held,
			gmDrawPile: next.major.drawPile,
			gmDiscard: next.major.discard,
			foolReshuffled: true
		};
	});
}
```

Reset `foolReshuffled` only when `discardHand()`, `reshuffleAll()`, or `reset()` clears the visible result. A push appends to the same hand and must preserve the true marker, so the same visible Fool cannot trigger a second reshuffle merely because the hand signature changed.

- [ ] **Step 6: Wire provenance and automatic reshuffle into TestOfFate**

Mark UI-drawn cards with `origin: 'test-draw'`. Add an effect guarded by `result?.foolDrawn && !$table.foolReshuffled` that calls `table.reshuffleForFool()` once for the visible result. Replace the passive note with a status that states both decks were reshuffled, while preserving the cards/result and the legal push button after an initial Fool.

- [ ] **Step 7: Extend browser coverage**

For `e2e-8`, assert the result contains `Both decks reshuffled`, the Fool card remains visible, and Push remains enabled. For `e2e-330`, assert the pushed Fool remains an automatic great failure and the same completed reshuffle status appears. Clear the result and prove the next seeded draw is not simply the old unshuffled successor.

- [ ] **Step 8: Run unit/type/browser gates**

```bash
npm test -- tests/unit/tarot.test.ts tests/unit/tarot-table-store.test.ts tests/unit/tarot-resolution.test.ts
npm run check
npx playwright test tests/e2e/deck-test-of-fate.spec.ts
```

Expected: unit and type gates pass; focused browser suite passes when the configured server is healthy. If the documented client-entry/preview environment failure recurs, record the exact error and do not claim the browser gate passed.

- [ ] **Step 9: Commit live behavior**

```bash
git add src/lib/engine/tarot-deck.ts src/lib/stores/tarot-deck.ts \
  src/lib/components/tarot/TestOfFate.svelte tests/unit/tarot.test.ts \
  tests/unit/tarot-table-store.test.ts tests/e2e/deck-test-of-fate.spec.ts
git commit -m "fix(tarot): perform Fool reshuffles"
```

---

### Task 10: Close the re-audit, version the pack, review, and verify

**Files:**
- Modify: `static/content-packs/hmtw/index.json`
- Modify: `docs/superpowers/2026-07-16-campaigns-status-and-handover.md`
- Modify: `docs/superpowers/plans/2026-07-15-campaigns-shared-tarot-roadmap.md`
- Verify all files changed by Tasks 1–9.

**Interfaces:**
- Consumes: complete schema-v2 generated catalog and all semantic/runtime tests.
- Produces: pack `3.0.0`, matching digest, updated handover, independent review evidence, and a clean verified branch.

- [ ] **Step 1: Run a final 31-procedure audit closure check**

Use the generated audit and manifest together:

```bash
node - <<'NODE'
const manifest = require('./scripts/content-import/manifest/tarot-procedures-md.json');
const supported = manifest.entries.filter((entry) => entry.scope === 'supported-v1');
if (supported.length !== 31) throw new Error(`expected 31 supported entries, got ${supported.length}`);
for (const entry of supported) {
	if (!entry.invokedFrom?.length) throw new Error(`${entry.id}: no invokedFrom`);
	console.log(`${entry.id}\t${entry.invokedFrom.length}\t${entry.steps.length}`);
}
NODE
```

Re-run the five mechanical `rg` searches from Task 1. For every material occurrence, confirm a manifest citation exists in the owning procedure. Add any missing citation and, if it exposes a semantic discrepancy, add a failing test and correct it before proceeding.

- [ ] **Step 2: Update roadmap/handover facts**

Record:

- schema v2 and the `source`/`invokedFrom` distinction;
- all 31 supported procedures re-audited;
- owner ruling that Fool reshuffles on draw;
- domain corrections completed;
- executable provenance/group/Fool fixes completed;
- exact test counts after the final run; and
- the focused browser result or exact environmental gap.

Do not remove the historical failure account; mark the structural recommendation as implemented.

- [ ] **Step 3: Bump the pack and regenerate the digest**

Change only:

```json
"version": "3.0.0"
```

Then run:

```bash
npm run content:build
node scripts/content-import/verify-pack-version.mjs --write
```

Expected: generated files are stable and a new 64-character digest is recorded.

- [ ] **Step 4: Run complete non-browser verification**

```bash
git diff --check
npm run content:verify
npm run content:verify:ci
npm run check
npm test
CONTENT_BASE_REF=fc30837 node scripts/content-import/verify-pack-version.mjs
```

Expected:

- no whitespace errors;
- every generated collection reports zero drift;
- schema-v2 catalog and audit agree with the manifest;
- Svelte check reports zero errors/warnings;
- every unit test passes with no vault-backed skips in this worktree; and
- version verifier reports `3.0.0 (was 2.3.0)`.

- [ ] **Step 5: Attempt focused browser verification**

```bash
npx playwright test tests/e2e/deck-test-of-fate.spec.ts
```

Expected: pass when the configured preview server is healthy. Otherwise capture the exact server/client-entry error in the handover and report the suite as unverified.

- [ ] **Step 6: Request independent adversarial review**

Use `superpowers:requesting-code-review`. Ask the reviewer to compare the entire diff against the approved design, the 31-entry audit, and the local rulebook sources, with special attention to:

- missing call sites;
- schema fields that permit the old bugs;
- incorrect Challenge modifier values;
- conditional/delayed branch timing;
- card conservation/provenance;
- runtime Markdown dependencies; and
- generated/manifest drift.

Address all technically valid Critical and Important findings using `superpowers:receiving-code-review`, then rerun Steps 4–5.

- [ ] **Step 7: Inspect exact final scope**

```bash
git status --short --branch
git diff --stat fc30837...HEAD
git diff --name-only fc30837...HEAD
git diff --check fc30837...HEAD
```

Expected: only design/plan, content contract/importer/manifests/generated files, relevant docs, engine/store/component code, and tests are present. No DB, route, auth, or Campaign Foundation files.

- [ ] **Step 8: Commit final pack/docs changes**

```bash
git add static/content-packs/hmtw/index.json \
  docs/superpowers/2026-07-16-campaigns-status-and-handover.md \
  docs/superpowers/plans/2026-07-15-campaigns-shared-tarot-roadmap.md
git commit -m "docs: record tarot procedure correctness v2"
```

- [ ] **Step 9: Verify committed branch state**

```bash
git status --short --branch
git log --oneline --decorate fc30837..HEAD
```

Expected: clean worktree and the reviewable commit sequence defined by the approved design. Do not merge, push, or begin Campaign Foundation without a new owner instruction.
