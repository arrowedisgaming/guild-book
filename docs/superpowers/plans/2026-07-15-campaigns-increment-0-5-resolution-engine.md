# Campaigns Increment 0.5: Resolution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct and complete the reusable tarot card metadata, test-of-fate, favor/disfavor, pushing, Fool, and group-test rules before shared campaign state is introduced.

**Architecture:** Pure functions accept validated `TarotConfig` and explicit inputs, returning typed results without state, randomness, database access, or UI imports. The existing standalone `/deck` tool becomes the executable reference client for those primitives.

**Tech Stack:** TypeScript strict, pure engine modules, Zod-backed content types, Svelte 5 runes, Vitest.

## Global Constraints

- Reuse and refactor `src/lib/engine/tarot-deck.ts` and `src/lib/engine/tarot-resolution.ts`; do not duplicate card values or thresholds.
- The Fool is stable ID `fool`, value `0`, and is neither a positional label nor XXII.
- Favor and disfavor are each boolean/non-cumulative and cancel one another.
- Resolve is spent before the draw to gain favor; pushing is free after failure.
- Initial matching suit can produce great success only without a push.
- A Fool drawn on the push is an automatic great failure even if the numeric sum would exceed the threshold.
- Group tests run the most- and least-qualified adventurers, convert outcomes to hits `2/1/0/-1`, and classify the sum from content.

---

### Task 1: Normalize all 78 card identities and derived major metadata

**Files:**
- Modify: `src/lib/engine/tarot-deck.ts`
- Modify: `src/lib/types/content-pack.ts`
- Modify: `src/lib/schemas/content-pack.schema.ts`
- Modify: `static/content-packs/hmtw/index.json`
- Test: `tests/unit/tarot.test.ts`

- [ ] **Step 1: Add failing card metadata tests**

Add to `tests/unit/tarot.test.ts`:

```ts
it('builds 78 globally unique stable card ids', () => {
  const cards = [...buildPlayerDeck(config), ...buildMajorDeck(config)];
  expect(cards).toHaveLength(78);
  expect(new Set(cards.map((card) => card.id)).size).toBe(78);
});

it('derives doom tier and parity for GM majors', () => {
  const cards = buildMajorDeck(config);
  expect(cards.find((card) => card.number === 14)).toMatchObject({
    doomTier: 'lesser',
    valueParity: 'even'
  });
  expect(cards.find((card) => card.number === 15)).toMatchObject({
    doomTier: 'greater',
    valueParity: 'odd'
  });
});

it('models the Fool by id with value zero', () => {
  expect(buildFool(config)).toMatchObject({ id: 'fool', number: 0, value: 0 });
});
```

- [ ] **Step 2: Run the test to verify derived fields fail**

Run: `npm test -- tests/unit/tarot.test.ts`

Expected: FAIL because major cards have no `doomTier` or `valueParity`.

- [ ] **Step 3: Add derived major fields**

Use these types and pure derivation:

```ts
export type DoomTier = 'lesser' | 'greater';
export type ValueParity = 'odd' | 'even';

export interface MajorCard {
  kind: 'major';
  id: string;
  number: number;
  name: string;
  value: number;
  doomTier?: DoomTier;
  valueParity: ValueParity;
}

function toMajorCard(card: TarotConfig['majorArcana'][number]): MajorCard {
  return {
    kind: 'major',
    id: card.id,
    number: card.number,
    name: card.name,
    value: card.number,
    doomTier: card.id === 'fool' ? undefined : card.number <= 14 ? 'lesser' : 'greater',
    valueParity: card.number % 2 === 0 ? 'even' : 'odd'
  };
}
```

Make `buildFool` and `buildMajorDeck` use `toMajorCard`. Add a validation refinement that requires exactly 22 unique major IDs, exactly one `fool` with number 0, and numbers 1–21 exactly once for non-Fool cards. In the same content-contract change, add positive-integer `resolution.favorModifier` and validated `resolution.groupOutcomes` ranges for `success`, `tight-spot`, `failure`, and `disaster`; Tasks 2 and 3 consume those fields. Bump the content-pack minor version, refresh `contentDigest` with `node scripts/content-import/verify-pack-version.mjs --write`, and run `npm run content:verify` before committing.

- [ ] **Step 4: Run targeted tests and type checks**

Run: `npm test -- tests/unit/tarot.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit card metadata**

```bash
git add src/lib/engine/tarot-deck.ts src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts static/content-packs/hmtw/index.json tests/unit/tarot.test.ts
git commit -m "feat(tarot): normalize card identities and doom metadata"
```

### Task 2: Make favor/disfavor and pushing explicit pure calculations

**Files:**
- Modify: `src/lib/engine/tarot-resolution.ts`
- Test: `tests/unit/tarot-resolution.test.ts`

- [ ] **Step 1: Write the complete failing resolution matrix**

Create `tests/unit/tarot-resolution.test.ts` with table tests for:

```ts
import { describe, expect, it } from 'vitest';
import { resolveTestOfFate } from '$lib/engine/tarot-resolution';
import { getContentPack } from '$lib/server/content/loader';

const config = getContentPack().tarot;

describe('test of fate resolution', () => {
  it.each([
    { favor: false, disfavor: false, modifier: 0 },
    { favor: true, disfavor: false, modifier: 3 },
    { favor: false, disfavor: true, modifier: -3 },
    { favor: true, disfavor: true, modifier: 0 }
  ])('reduces favor/disfavor to $modifier', ({ favor, disfavor, modifier }) => {
    const result = resolveTestOfFate(config, {
      attribute: 2,
      testedSuit: 'cups',
      initialCard: { id: 'cups-x', value: 10, suit: 'cups' },
      pushCard: null,
      favor,
      disfavor,
      resolveSpentForFavor: false
    });
    expect(result.modifier).toBe(modifier);
  });

  it('makes a Fool on the push an automatic great failure', () => {
    const result = resolveTestOfFate(config, {
      attribute: 4,
      testedSuit: 'swords',
      initialCard: { id: 'swords-x', value: 10, suit: 'swords' },
      pushCard: { id: 'fool', value: 0 },
      favor: true,
      disfavor: false,
      resolveSpentForFavor: true
    });
    expect(result.outcome).toBe('great-failure');
    expect(result.automaticGreatFailure).toBe(true);
  });

  it('allows an initial Fool to fail normally and remain pushable', () => {
    const result = resolveTestOfFate(config, {
      attribute: 4,
      testedSuit: 'wands',
      initialCard: { id: 'fool', value: 0 },
      pushCard: null,
      favor: false,
      disfavor: false,
      resolveSpentForFavor: false
    });
    expect(result.outcome).toBe('failure');
    expect(result.canPush).toBe(true);
  });
});
```

Also cover totals 13/14, matching/nonmatching initial suit, success after push, failed push, and conflicting `resolveSpentForFavor: true` with no Resolve-favor request.

- [ ] **Step 2: Run the new suite to verify it fails**

Run: `npm test -- tests/unit/tarot-resolution.test.ts`

Expected: FAIL because `resolveTestOfFate` does not exist.

- [ ] **Step 3: Replace boolean `pushedFate` inference with card-explicit input**

Export these shapes:

```ts
export interface ResolutionCard {
  id: string;
  value: number;
  suit?: SuitId;
}

export interface TestOfFateInput {
  attribute: number;
  testedSuit: SuitId;
  initialCard: ResolutionCard;
  pushCard: ResolutionCard | null;
  favor: boolean;
  disfavor: boolean;
  resolveSpentForFavor: boolean;
}

export interface TestOfFateResult {
  total: number;
  modifier: number;
  outcome: OutcomeId;
  initialDrawMatchedTestedSuit: boolean;
  pushed: boolean;
  canPush: boolean;
  automaticGreatFailure: boolean;
}

export function resolveTestOfFate(config: TarotConfig, input: TestOfFateInput): TestOfFateResult {
  const favorModifier = config.resolution.favorModifier;
  const modifier = input.favor === input.disfavor ? 0 : input.favor ? favorModifier : -favorModifier;
  const pushed = input.pushCard !== null;
  const automaticGreatFailure = input.pushCard?.id === 'fool';
  const total = input.attribute + input.initialCard.value + (input.pushCard?.value ?? 0) + modifier;
  const initialDrawMatchedTestedSuit = input.initialCard.suit === input.testedSuit;
  const succeeds = total >= config.resolution.successThreshold;
  const outcome: OutcomeId = automaticGreatFailure
    ? 'great-failure'
    : succeeds
      ? initialDrawMatchedTestedSuit && !pushed && config.resolution.greatSuccessOnMatchingSuit
        ? 'great-success'
        : 'success'
      : pushed
        ? 'great-failure'
        : 'failure';
  return {
    total,
    modifier,
    outcome,
    initialDrawMatchedTestedSuit,
    pushed,
    canPush: !pushed && !succeeds,
    automaticGreatFailure
  };
}
```

Read the modifier magnitude from the new `resolution.favorModifier` content field, and require a positive integer in schema validation.

Retain `testOfFate` as a deprecated adapter for the current UI until Task 4 migrates all callers; remove it only after `rg "testOfFate\(" src tests` reports no legacy imports.

- [ ] **Step 4: Run the resolution suites**

Run: `npm test -- tests/unit/tarot-resolution.test.ts tests/unit/tarot.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit resolution correctness**

```bash
git add src/lib/engine/tarot-resolution.ts tests/unit/tarot-resolution.test.ts tests/unit/tarot.test.ts
git commit -m "feat(tarot): implement complete test resolution"
```

### Task 3: Implement group tests as a pure composition

**Files:**
- Create: `src/lib/engine/tarot-group-test.ts`
- Test: `tests/unit/tarot-group-test.test.ts`

- [ ] **Step 1: Write failing selection, hit, and outcome tests**

Create `tests/unit/tarot-group-test.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveGroupTest, selectGroupTestActors } from '$lib/engine/tarot-group-test';

describe('group test', () => {
  it('selects most and least qualified with stable roster-order ties', () => {
    const selected = selectGroupTestActors([
      { id: 'a', attribute: 2, rosterOrder: 0 },
      { id: 'b', attribute: 4, rosterOrder: 1 },
      { id: 'c', attribute: 2, rosterOrder: 2 }
    ]);
    expect(selected).toEqual({ mostQualifiedId: 'b', leastQualifiedId: 'a' });
  });

  it.each([
    { outcomes: ['great-success', 'great-success'], hits: 4, result: 'success' },
    { outcomes: ['success', 'failure'], hits: 1, result: 'tight-spot' },
    { outcomes: ['failure', 'failure'], hits: 0, result: 'failure' },
    { outcomes: ['great-failure', 'failure'], hits: -1, result: 'disaster' }
  ] as const)('maps $hits hits to $result', ({ outcomes, hits, result }) => {
    expect(resolveGroupTest(outcomes)).toEqual({ hits, outcome: result });
  });
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `npm test -- tests/unit/tarot-group-test.test.ts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement stable selection and data-driven classification**

Use exported domain types:

```ts
export type GroupOutcomeId = 'success' | 'tight-spot' | 'failure' | 'disaster';

export const OUTCOME_HITS: Record<OutcomeId, number> = {
  'great-success': 2,
  success: 1,
  failure: 0,
  'great-failure': -1
};
```

Production classification iterates the validated `tarot.resolution.groupOutcomes` ranges added in Task 1 rather than hardcoding the test table. `selectGroupTestActors` sorts a copy by descending attribute then ascending roster order for the most-qualified pick, and ascending attribute then ascending roster order for the least-qualified pick. When a one-person group is permitted, both IDs are that adventurer and the caller still provides two draws.

- [ ] **Step 4: Run tests and checks**

Run: `npm test -- tests/unit/tarot-group-test.test.ts tests/unit/tarot-resolution.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit group tests**

```bash
git add src/lib/engine/tarot-group-test.ts tests/unit/tarot-group-test.test.ts
git commit -m "feat(tarot): add group test resolution"
```

### Task 4: Make `/deck` the reference guided client

**Files:**
- Modify: `src/lib/components/tarot/TestOfFate.svelte`
- Modify: `src/routes/deck/+page.svelte`
- Modify: `src/lib/tarot/protocol.ts`
- Test: `tests/e2e/deck.spec.ts`

- [ ] **Step 1: Write the failing browser flow**

Create `tests/e2e/deck.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('runs a declared test and offers a free push only after failure', async ({ page }) => {
  await page.goto('/deck');
  await page.getByRole('tab', { name: 'Test of fate' }).click();
  await page.getByRole('radio', { name: 'Cups' }).click();
  await page.getByLabel('Attribute value').selectOption('2');
  await page.getByLabel('Gain favor by spending 1 Resolve').check();
  await expect(page.getByRole('button', { name: 'Draw test card' })).toBeEnabled();
  await page.getByRole('button', { name: 'Draw test card' }).click();
  await expect(page.getByRole('status')).toContainText(/success|failure/i);
  await expect(page.getByText('Pushing fate does not cost Resolve.')).toBeVisible();
});
```

Use a deterministic seed query parameter in test builds (`/deck?seed=e2e-failure`) so the fixture is stable. The production UI must generate its seed server-side or with browser cryptography; never use a predictable seed for campaign sessions.

- [ ] **Step 2: Run the E2E test to verify it fails**

Run: `npx playwright test tests/e2e/deck.spec.ts`

Expected: FAIL because the declared favor and explicit push flow is absent.

- [ ] **Step 3: Migrate the component to the new engine result**

Model the local UI as:

```ts
type GuidedTestStage = 'declare' | 'initial-result' | 'final-result';

let stage = $state<GuidedTestStage>('declare');
let testedSuit = $state<SuitId>('swords');
let attribute = $state(1);
let favor = $state(false);
let disfavor = $state(false);
let spendResolveForFavor = $state(false);
let initialCard = $state<ResolutionCard | null>(null);
let pushCard = $state<ResolutionCard | null>(null);

let result = $derived.by(() =>
  initialCard
    ? resolveTestOfFate(config, {
        attribute,
        testedSuit,
        initialCard,
        pushCard,
        favor: favor || spendResolveForFavor,
        disfavor,
        resolveSpentForFavor: spendResolveForFavor
      })
    : null
);
```

The standalone tool labels the Resolve toggle as a calculation aid; it does not persist a character resource. Show the reduced modifier when both favor and disfavor are present, distinguish initial and push cards, and announce the result through the existing live-announcement conventions.

- [ ] **Step 4: Verify all callers use the new contract**

Run: `rg "testOfFate\(|pushedFate" src tests`

Expected: no production caller of the legacy adapter. Remove the adapter and update `DrawResult.test` to record `modifier`, `resolveSpentForFavor`, and `automaticGreatFailure`.

- [ ] **Step 5: Run the increment verification**

Run:

```bash
npm test -- tests/unit/tarot.test.ts tests/unit/tarot-resolution.test.ts tests/unit/tarot-group-test.test.ts
npm run check
npm test
npx playwright test tests/e2e/deck.spec.ts
npm run content:verify
```

Expected: every command exits 0.

- [ ] **Step 6: Commit Increment 0.5**

```bash
git add src/lib/components/tarot/TestOfFate.svelte src/routes/deck/+page.svelte src/lib/tarot/protocol.ts src/lib/engine/tarot-resolution.ts tests/e2e/deck.spec.ts
git commit -m "feat(deck): complete guided tarot resolution"
```

## Increment 0.5 Completion Record

Attach the resolution matrix, group hit matrix, exact engine coverage for the three tarot modules, and the deterministic `/deck` E2E output to the implementation PR. Shared session work must call these primitives rather than copy their arithmetic.
