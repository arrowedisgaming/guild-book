# Campaigns Increment 3: Guided Challenge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete guided Challenge procedure over the shared table while preserving manual fictional adjudication and the no-full-VTT boundary.

**Architecture:** A Challenge procedure module composes the generic card reducer with a phase/round/turn state machine, content-defined formulas, typed modifiers, and projected legal controls. It owns hands, initiative, play/discard budgets, Doom legality, round cleanup, and legal death replacement boundaries; it does not own health, movement, range, maps, or fictional consequences.

**Tech Stack:** Pure TypeScript engine, generated content-pack procedures/modifiers, Svelte 5 components, Vitest, Playwright multi-context tests.

## Amendments — read before starting

1. **`ChallengeConfig` is replaced by content, and Task 1 Step 4 was unreachable as written.** `calculateGmHandSize(config: ChallengeConfig, …)` (`:146`) had no path from content pack to runtime snapshot to reducer, verified end to end:
   - Increment 0b's `TarotProceduresFile` had no slot for it.
   - Increment 0b's generator emits only manifest-derived records, so nothing else can appear in `tarot-procedures.json`.
   - Increment 2's pinned `SessionRuntimeContentV1` (`increment-2:327-336`) carries `tarot / procedures / cards / modifiers` and no challenge config, and this plan never touches `session-runtime.ts` or `session-runtime.schema.ts`.
   - This plan lists `tarot-procedures.json` as modified "through its generator manifest" (`:29-33`) but omits `scripts/content-import/md-procedures.mjs` from both its Files list and its Task 1 `git add` (`:114`). Since `content:verify` runs `md-procedures.mjs --check` byte-for-byte, any hand-added config would be regenerated away and `--check` would fail.

   Increment 0b now carries a `formulas: TarotFormulaDefinition[]` catalog for exactly this. Read the `gm-hand-size` entry's `params` instead of defining a `ChallengeConfig` literal, and let `playerBaseHandSize` (`:56`) come from the same catalog. If a needed parameter is absent, add it to Increment 0b's manifest and generator — and list `md-procedures.mjs` and `docs/rules/tarot-procedure-audit.md` in your Files and commit, because the audit regenerates from the same manifest and will otherwise drift.

2. **Modifier IDs are namespaced.** `:40-48` expects `challenge?.modifierIds` to contain bare `'black-honey'`, `'stun'`, and so on. Increment 0b namespaces modifier IDs by procedure (`challenge-black-honey`, `challenge-stun`, `camp-high-chant`), matching the manifest's procedure IDs. Update this test to the namespaced form.

3. **Integration suites need the vitest config fix from Increment 1.** Task 5 Step 3 and Task 6 Step 4 run `tests/integration/` paths whose "Expected: PASS" is unreachable until `vitest.config.ts` includes that directory. See the Increment 1 amendments.

4. **Use the frozen command envelope.** Task 5's Resolve-spend command carries `observedCharacterVersion`, which exists in specification §10.2 and in the roadmap's amended freeze, but was absent from the roadmap's original and from Increment 2. Confirm Increment 2 adopted the three-field envelope before starting.

5. **`doomTier` comes from content.** Global Constraint 3 states the I–XIV / XV–XXI boundary as a literal. Increment 0.5 amendment 5 moves that boundary into a `tarot.doomTiers` content block, now citeable against Increment 0a's `challenge-lesser-dooms` / `challenge-greater-dooms` entries — which state the boundary explicitly ("Lesser doom cards have values of 1–14", "Greater doom cards have values of 15–21"). Read it from config; do not re-hardcode 14 here.

6. **`shield-initiative` is removed — the rulebook has no such mechanic.** Verified during Increment 0a: `### Shield` (`09 - Chapter 9 …:683`) governs Notch absorption and hand slots, and the only Initiative-adjacent shield rule is a tie-break — "Ties go to the attacker unless the defender has a shield" (`07 - Chapter 7 …:263`, `:415`, `:431`) — which decides whether a Wound lands. Wound application is outside v1 by specification §8.6. The specification was amended on 2026-07-15 to drop it. Do not add `shield-initiative` to `modifierIds`, do not implement `replace-initiative-with-shield`, and do not write a test asserting either.

7. **`Aim` stays, but it is bow equipment.** It is a real mechanic sourced from `09 - Chapter 9 …:760-762`, not a Chapter 7 heading — a Swords action played face-down against a declared target, revealed on a later Attack to add its value. Increment 0b reaches it with a bullet anchor and it cites no rules entry. Keep `aim-prepare`; its content definition just comes from a different chapter than the rest of the Challenge module.

## Global Constraints

- GM advances Challenge phases and rounds. Players control only their legal private hand and prepared/face-down commands.
- Recalculate the GM hand formula from current enemy facts at the start of every round.
- Major I–XIV are lesser Dooms; XV–XXI are greater Dooms; parity predicates use derived card metadata.
- GM play and discard budgets are separate. A discard does not consume a play and rules may allow multiple discards up to held cards.
- Fool Challenge play is an interrupt paired with another card, resolves first, grants an extra turn, and grants no minor actions for that extra turn.
- Fool draw schedules both eligible deck reshuffles at the Challenge round boundary; it does not return held/in-play cards.
- Stun, black honey, Brainfever, Counsel, Guardian Angel, and Aim receive typed engine behavior. Shield does not — see amendment 6.
- Denizen card abilities use generic typed predicates; wounds, monster health, status application, and fictional consequences remain manually logged.
- A replacement after death may enter only at the next legal deal/round boundary.

---

### Task 1: Define Challenge runtime content and state

**Files:**
- Modify: `src/lib/types/content-pack.ts`
- Modify: `src/lib/schemas/content-pack.schema.ts`
- Modify: `static/content-packs/hmtw/tarot-procedures.json` through its generator manifest
- Create: `src/lib/engine/session/procedures/challenge/types.ts`
- Create: `src/lib/engine/session/procedures/challenge/schema.ts`
- Test: `tests/unit/session/challenge/content.test.ts`

- [ ] **Step 1: Write failing content completeness tests**

```ts
const challenge = getTarotProcedures().procedures.find((p) => p.id === 'challenge-round');
expect(challenge).toBeDefined();
expect(challenge?.modifierIds).toEqual(expect.arrayContaining([
  'challenge-black-honey',
  'challenge-stun',
  'challenge-brainfever',
  'challenge-counsel',
  'challenge-guardian-angel',
  'challenge-aim'
]));
```

Note the namespaced IDs (amendment 2) and the absence of `shield-initiative` (amendment 6).

- [ ] **Step 2: Add the validated Challenge config**

```ts
export interface ChallengeConfig {
  schemaVersion: 1;
  playerBaseHandSize: number;
  gmHandFormula: {
    base: number;
    perEnemy: number;
    sizeAdjustments: Record<string, number>;
    threatAdjustments: Record<string, number>;
  };
  lesserDoomMax: number;
  greaterDoomMin: number;
  playerPlayBudget: number;
  playerMinorActionBudget: number;
  gmPlayBudget: number;
  gmMulliganGreaterDoomThreshold: number;
  fool: {
    pairedPlayRequired: true;
    grantsExtraTurn: true;
    extraTurnMinorActions: 0;
    reshuffleBoundary: 'end-round';
  };
}
```

Populate values from the audited rule source through the procedure importer; do not transcribe them into TypeScript defaults. Zod rejects negative counts and a Doom threshold gap/overlap. Because the generated procedure file changes, bump the content-pack minor version, refresh `contentDigest` with `node scripts/content-import/verify-pack-version.mjs --write`, and run `npm run content:verify` before committing.

- [ ] **Step 3: Define the state machine**

```ts
export type ChallengeStage =
  | 'setup'
  | 'deal'
  | 'initiative-placement'
  | 'initiative-reveal'
  | 'turns'
  | 'round-cleanup'
  | 'complete';

export interface ChallengeStateV1 {
  schemaVersion: 1;
  stage: ChallengeStage;
  round: number;
  participantTenureIds: string[];
  pendingJoinTenureIds: string[];
  enemyFacts: Array<{ id: string; size: string; threat: string; typeIds: string[] }>;
  initiativeOrder: Array<{ tenureId: string; cardZoneId: string; revealed: boolean }>;
  activeTurnIndex: number | null;
  turnKind: 'normal' | 'fool-extra' | null;
  budgets: Record<string, { plays: number; minorActions: number; discards: number | null }>;
  modifiers: ChallengeModifierState[];
}
```

- [ ] **Step 4: Run and commit**

Run: `npm test -- tests/unit/session/challenge/content.test.ts`

Expected: PASS.

```bash
git add src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts scripts/content-import/manifest/tarot-procedures-md.json static/content-packs/hmtw/tarot-procedures.json static/content-packs/hmtw/index.json src/lib/engine/session/procedures/challenge tests/unit/session/challenge/content.test.ts
git commit -m "feat(challenge): define content-driven challenge state"
```

### Task 2: Implement setup, dealing, initiative, and round boundaries

**Files:**
- Create: `src/lib/engine/session/procedures/challenge/reducer.ts`
- Create: `src/lib/engine/session/procedures/challenge/deal.ts`
- Create: `src/lib/engine/session/procedures/challenge/initiative.ts`
- Modify: `src/lib/engine/session/reducer.ts`
- Test: `tests/unit/session/challenge/round.test.ts`

- [ ] **Step 1: Write failing transition tests**

Cover legal stage order, current active tenures only, exact player/GM deals, private hand projections, facedown initiative, public reveal/order, and boundary-only scheduled reshuffle:

```ts
expect(beginChallenge(session, command, context)).toMatchObject({
  ok: true,
  state: { procedure: { kind: 'challenge', challenge: { stage: 'deal', round: 1 } } }
});

const dealt = dealRound(beginState, context);
expect(handCount(dealt, playerA)).toBe(expectedPlayerHand);
expect(handCount(dealt, gm)).toBe(expectedGmHand);
expect(projectForActor(dealt, gmActor, catalog).private).not.toHaveProperty('playerHands');
```

- [ ] **Step 2: Implement the GM hand formula as a pure function**

```ts
export function calculateGmHandSize(config: ChallengeConfig, enemies: ChallengeStateV1['enemyFacts']): number {
  return Math.max(
    0,
    config.gmHandFormula.base +
      enemies.length * config.gmHandFormula.perEnemy +
      enemies.reduce(
        (sum, enemy) =>
          sum +
          (config.gmHandFormula.sizeAdjustments[enemy.size] ?? 0) +
          (config.gmHandFormula.threatAdjustments[enemy.threat] ?? 0),
        0
      )
  );
}
```

Validate enemy facts against allowed content lookup IDs. Recalculate only at each round start; preserve the calculated target in public state for audit without revealing the GM hand.

- [ ] **Step 3: Implement initiative privacy**

Players place one owned card face down. Public projection exposes an occupied card back. GM cannot hydrate it. Reveal moves each identity into a public initiative zone, sorts by content-defined ordering with stable roster-order ties, and records public initiative events.

- [ ] **Step 4: Implement boundary cleanup**

Round cleanup moves configured played/initiative cards to their correct discard piles, leaves explicitly held/prepared/inspiration zones untouched, resolves scheduled Fool reshuffles for each eligible deck, clears per-round modifiers/budgets, increments round, recalculates deals, and admits pending replacement tenures.

- [ ] **Step 5: Run randomized stage tests and commit**

Run: `npm test -- tests/unit/session/challenge/round.test.ts tests/unit/session/property.test.ts`

Expected: PASS with card conservation after every transition.

```bash
git add src/lib/engine/session/procedures/challenge src/lib/engine/session/reducer.ts tests/unit/session/challenge/round.test.ts
git commit -m "feat(challenge): deal rounds and reveal initiative"
```

### Task 3: Implement turns, plays, discards, Dooms, and the Fool interrupt

**Files:**
- Create: `src/lib/engine/session/procedures/challenge/turns.ts`
- Create: `src/lib/engine/session/procedures/challenge/dooms.ts`
- Create: `src/lib/engine/session/procedures/challenge/fool.ts`
- Test: `tests/unit/session/challenge/turns.test.ts`
- Test: `tests/unit/session/challenge/fool.test.ts`

- [ ] **Step 1: Write the failing budget matrix**

Test legal player play, player minor action declarations, GM lesser/greater Doom predicate, separate GM discard counter, exhausted budget rejection, and end-turn progression. Assert discarding never decrements `plays`.

```ts
expect(applyGmDiscard(state, gm, majorCard)).toMatchObject({
  budgets: { gm: { plays: 1, discards: 1 } }
});
expect(applyGmPlay(state, gm, majorCard)).toMatchObject({
  budgets: { gm: { plays: 0, discards: 1 } }
});
```

- [ ] **Step 2: Implement typed Doom predicates**

```ts
export interface DoomPredicate {
  tier?: 'lesser' | 'greater';
  parity?: 'odd' | 'even';
  operation: 'play' | 'discard' | 'reveal';
  count?: number;
}

export function cardMatchesDoomPredicate(card: MajorCard, predicate: DoomPredicate): boolean {
  return (
    (predicate.tier === undefined || card.doomTier === predicate.tier) &&
    (predicate.parity === undefined || card.valueParity === predicate.parity)
  );
}
```

Content-backed denizen abilities may compose these fields. Anything requiring a fictional consequence emits a public `manual-consequence-required` event rather than mutating unmodeled state.

- [ ] **Step 3: Implement Fool paired play atomically**

The player command selects exactly `fool` plus one owned eligible card. The reducer rejects a lone Fool, resolves the Fool event first, resolves/discards the paired card according to normal rules, inserts one extra turn immediately after the current turn, and sets its minor-action budget to zero. It never grants a second extra turn from the paired card and does not reshuffle until round cleanup.

Test event order:

```ts
expect(result.events.map((event) => event.kind)).toEqual([
  'fool-interrupt-played',
  'challenge-card-played',
  'extra-turn-scheduled'
]);
```

- [ ] **Step 4: Implement GM mulligan**

Only projected when the content-defined greater-Doom condition is met. Move the entire eligible GM hand to major discard, redraw the configured count, preserve in-play cards, and consume the configured once-per-round marker. The GM hand identities remain GM-only.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/unit/session/challenge/turns.test.ts tests/unit/session/challenge/fool.test.ts`

Expected: PASS.

```bash
git add src/lib/engine/session/procedures/challenge tests/unit/session/challenge/turns.test.ts tests/unit/session/challenge/fool.test.ts
git commit -m "feat(challenge): enforce turns dooms and fool play"
```

### Task 4: Implement typed Challenge modifiers

**Files:**
- Create: `src/lib/engine/session/procedures/challenge/modifiers.ts`
- Create: `src/lib/engine/session/procedures/challenge/transfers.ts`
- Test: `tests/unit/session/challenge/modifiers.test.ts`
- Test: `tests/unit/session/challenge/transfers.test.ts`

- [ ] **Step 1: Write one failing behavior test per modifier**

Required assertions:

- `black-honey`: changes the affected participant's configured deal count.
- `stun`: immediately discards the affected eligible hand cards and emits public count, not identities that were not otherwise public.
- `brainfever`: chooses the lowest-value eligible initiative card; stable card-ID tie break is recorded.
- `counsel`: transfers an owned private card to an authorized recipient without public identity.
- `guardian-angel`: performs its audited private/public move as specified by content.
- `aim`: creates and consumes the typed prepared/face-down zone.

- [ ] **Step 2: Define modifier commands as strict variants**

```ts
export type ChallengeModifierCommand =
  | { type: 'apply-black-honey'; targetTenureId: string }
  | { type: 'apply-stun'; targetTenureId: string }
  | { type: 'apply-brainfever'; targetTenureId: string }
  | { type: 'counsel-transfer'; recipientUserId: string; cardId: string }
  | { type: 'guardian-angel'; targetTenureId: string; cardId: string }
  | { type: 'aim-prepare'; cardId: string };
```

The visible command set is derived from actor ownership, current Challenge stage, and active content modifiers. Server validation rejects a syntactically valid but unprojected command.

- [ ] **Step 3: Preserve transfer privacy**

Public transfer event contains sender/recipient/count/reason only. Sender and recipient each receive the minimum secret payload needed to update their projection. GM receives neither identity unless GM is sender or recipient under that rule.

- [ ] **Step 4: Run canary and conservation tests**

Run: `npm test -- tests/unit/session/challenge/modifiers.test.ts tests/unit/session/challenge/transfers.test.ts tests/integration/session-privacy.test.ts`

Expected: PASS; transfer canary is visible only to sender/recipient.

- [ ] **Step 5: Commit modifiers**

```bash
git add src/lib/engine/session/procedures/challenge tests/unit/session/challenge/modifiers.test.ts tests/unit/session/challenge/transfers.test.ts tests/integration/session-privacy.test.ts
git commit -m "feat(challenge): add typed challenge modifiers"
```

### Task 5: Integrate death and legal replacement joins

**Files:**
- Modify: `src/lib/server/session/command-service.ts`
- Modify: `src/lib/server/campaign/tenure.ts`
- Modify: `src/lib/engine/session/procedures/challenge/reducer.ts`
- Test: `tests/integration/challenge-death.test.ts`

- [ ] **Step 1: Write failing atomic death tests**

Marking a participating adventurer dead must, in one mutation, claim character version, update life JSON/status, end tenure, remove or redact owned private Challenge zones per procedure rules, update participant state, emit public death/cleanup events, and free membership eligibility. Inject failure at each statement and assert no partial death.

- [ ] **Step 2: Implement boundary-aware replacement state**

Outside Challenge, a newly attached replacement may participate immediately if the active procedure allows it. During Challenge, attachment creates the tenure but the session cleanup port adds it to `pendingJoinTenureIds`; no hand is dealt and no private zone is created until round cleanup. A death occurring during round cleanup admits the replacement at the next subsequently started round, never midway through the current deal.

- [ ] **Step 3: Run and commit**

Run: `npm test -- tests/integration/challenge-death.test.ts tests/integration/session-atomicity.test.ts`

Expected: PASS.

```bash
git add src/lib/server/session/command-service.ts src/lib/server/campaign/tenure.ts src/lib/engine/session/procedures/challenge/reducer.ts tests/integration/challenge-death.test.ts tests/integration/session-atomicity.test.ts
git commit -m "feat(challenge): handle death and replacement boundaries"
```

### Task 6: Build the guided Challenge table UI

**Files:**
- Create: `src/lib/components/campaign/table/challenge/ChallengePanel.svelte`
- Create: `src/lib/components/campaign/table/challenge/InitiativeRow.svelte`
- Create: `src/lib/components/campaign/table/challenge/TurnControls.svelte`
- Create: `src/lib/components/campaign/table/challenge/GmChallengeControls.svelte`
- Create: `src/lib/components/campaign/table/challenge/ModifierControls.svelte`
- Modify: `src/lib/components/campaign/table/TableShell.svelte`
- Test: `tests/e2e/challenge.spec.ts`
- Test: `tests/e2e/challenge-privacy.spec.ts`

- [ ] **Step 1: Write the failing multi-context Challenge journey**

The GM starts Challenge, enters typed enemy facts, deals, players place initiative, GM reveals, participants take turns, GM plays/discards Dooms, one player performs a Fool paired play, round ends/reshuffles, and Challenge completes. Assertions cover automatic polling and legal projected controls at every stage.

Privacy test examines response bodies and DOM for unique player-hand canaries before and after initiative reveal, private transfer, Stun, and Fool paired play.

- [ ] **Step 2: Implement projection-driven controls**

Components receive no full state and do not calculate legality. Render buttons only from `projection.controls`, send one UUID command ID per user intent, disable it while in flight, and reuse that ID on network retry. Show public turn/budget counters and GM hand count; show card identities only from the actor-private projection.

Enemy inputs are limited to facts needed by the hand formula and typed predicates. There are no health, damage, position, distance, range, map, or status controls. A public free-text outcome note may describe fictional consequences but must be sanitized and size-limited.

- [ ] **Step 3: Add accessibility behavior**

Announce deal count, initiative reveal/order, active turn, public play, round transition, and Challenge completion. Face-down buttons have owner/position labels without identity. Card selection supports keyboard toggles and visible focus. Reduced motion disables dealing/reveal animation.

- [ ] **Step 4: Run the complete Challenge gate**

Run:

```bash
npx vitest run tests/unit/session/challenge --coverage
npm test -- tests/integration/challenge-death.test.ts tests/integration/session-privacy.test.ts
npm run check
npm test
npx playwright test tests/e2e/challenge.spec.ts tests/e2e/challenge-privacy.spec.ts
ADAPTER=cloudflare npm run build
```

Expected: every command exits 0; Challenge engine coverage is 90%+; no canary leaks.

- [ ] **Step 5: Commit Increment 3**

```bash
git add src/lib/components/campaign/table/challenge src/lib/components/campaign/table/TableShell.svelte tests/e2e/challenge.spec.ts tests/e2e/challenge-privacy.spec.ts
git commit -m "feat(challenge): add guided challenge table"
```

## Increment 3 Completion Record

Attach the Challenge transition diagram, hand-formula fixtures, Doom/budget matrix, modifier privacy results, death atomicity output, accessibility checks, and multi-context trace. Keep the feature allowlisted.
