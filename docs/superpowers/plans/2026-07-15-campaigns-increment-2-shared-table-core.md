# Campaigns Increment 2: Shared Tarot Table Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a persistent, server-authoritative, privacy-preserving shared tarot table with generic card operations, role projections, idempotent commands, polling, recovery, and an allowlisted pilot interface.

**Architecture:** A pure reducer owns all 78 cards in typed zones and emits public/private events. A server command service reconstructs complete state from public, per-recipient, and server-only fragments, validates a command, and commits the next version plus journal events atomically. Role projections are built server-side from reconstructed state and are the only table payloads returned to clients.

**Tech Stack:** TypeScript pure engine, Zod, SvelteKit endpoints, Drizzle/SQLite/D1, Svelte 5, Vitest, Playwright multi-context testing.

## Amendments — read before starting

**Conform to the roadmap's frozen contracts.** Four of this plan's definitions drifted from the specification before any code was written. The roadmap's Cross-Increment Contract Freeze now carries the amended forms; adopt them:

1. **Command envelope.** Replace the single `observedVersion` (`:412`) with the specification §10.2 three-field form: `observedSessionVersion` (advisory), `expectedStructuralVersion?` (the hard precondition, structural intents only), `observedCharacterVersion?` (resource spends only). Step 4 item 5 currently does `observedVersion === currentVersion` for structural commands, collapsing an advisory hint into a lock — that reintroduces the `409` storm the design review's B3 removed. Structural commands check `expectedStructuralVersion`; nothing else pins a version.

2. **`ReduceResult` stays generic.** `:175-177` declares it non-generic, hardcoding `SessionEngineStateV1`/`SessionEvent[]`/`SessionRejection`. Keep the frozen `ReduceResult<S, E, R>` and alias it locally instead.

3. **Sync route.** `:453` and `:470` create `/api/campaigns/[id]/events?since=<cursor>`. Specification §10.1 says `GET /api/campaigns/[campaignId]/sync?after=<cursor>&version=<version>`. Adopt the specification's route and parameters. Note this also fixes a guaranteed 404: `:524`'s relative `fetch(\`events?since=…\`)` resolves against `/campaigns/[id]/table` to `/campaigns/[id]/events`, not the `/api/...` route it creates. Use a root-relative URL.

4. **`sessionCommands` stores both versions.** Task 3 stores only `expectedVersion`/`resultingVersion`; specification §6.5 requires both the client-observed version and the optional structural precondition, so a rejected structural command is auditable.

**Fix these internal contradictions before Task 1:**

5. **`reduceSession` has two incompatible signatures in this plan.** `:162` calls `reduceSession(state, actorA, command, runtime)` (4 positional args); `:185-189` defines `reduceSession(state, command, context)` with `ReduceContext {actor, runtime, rng}`. Same defect for `assertSessionInvariants`: called with 1 arg at `:51`, specified with 2 (`state, catalog`) at `:118` and `:223`. This is caught, not silent — `.svelte-kit/tsconfig.json` includes `../tests/**/*.ts`, so `npm run check` typechecks tests and Task 1 Step 6 / Task 5 Step 7 will fail. Settle on the context form.

6. **Private zones have no `id`.** `OwnedPrivateZone` (`:86-105`) omits it while `publicZones`/`pendingZones` have one, yet commands address zones by ID (`destinationZoneId: 'hand:a'` at `:381`) and Increment 3 uses `cardZoneId` (`:99`). Private zones are unaddressable as specified.

7. **The major-card invariant test at `:58-64` is a trap.** "Rejects a major card in a player-only zone" invites `card.kind === 'major'`, but the Fool is a major card that legitimately lives in `playerDraw` (`tarot-deck.ts:64-68`), so the 78-card fixture in the preceding test would throw. The invariant is deck-membership, not card kind. Say so in the test name.

8. **Undefined types.** `SessionModifierDefinition` (`:335`), `TarotCardCatalog` (`:206`, `:334`), `SessionActor`, `SessionEvent`, `SessionRejection`, and `ProcedureState` are used but defined nowhere in the plan set. Increment 0b's `modifierIds: string[]` is free-form with no catalog resource behind it, so `modifiers: SessionModifierDefinition[]` has no content source. Define the modifier catalog in this increment's runtime snapshot, or add it to Increment 0b's contract before starting.

9. **This increment owns `tests/unit/session/import-boundaries.test.ts`**, shown in the roadmap as the architectural-boundary enforcement but created by no task. Add it alongside the first `src/lib/engine/session/` module.

10. **Undeclared and misfiled files.** `:127` git-adds `tests/fixtures/session.ts` (imported at `:41`) which no Files list declares. Task 1 declares `tests/unit/session/zones.test.ts` but never gives its body while Step 2 expects it to fail. `:311` lists `src/lib/types/session.ts` as "Modify" when Task 1 (`:29`) creates it. `:292` runs bare `npm run db:generate` while Task 3 names the output `0003_shared_table_core.sql` — use `--name shared_table_core`.

11. **`playerHandCounts` is public information** (§8.2:324) but `:158` places it under `projection.private` for the GM.

12. **No D1 test harness exists.** `tests/` has no DB-touching test today and there is no `@cloudflare/vitest-pool-workers`. `:429`/`:297` require "representative first/middle/last failures against local D1" with no mechanism. Increment 1 `:322` at least acknowledges this ("add `scripts/test-d1-constraints.mjs` only if Vitest cannot access the local Miniflare D1 binding"); this plan assumes it is solved. Establish the harness in Increment 1 and depend on it here.

13. **The load script's auth path conflicts with the Playwright webserver.** `:574` authenticates fixture users "through a local test-only credential setup", but the Credentials provider needs `NODE_ENV=development` + `AUTH_DEV_LOGIN=true` (`auth.ts:73`) while `playwright.config.ts:4` boots a production build. Same conflict as Increment 1 amendment 9; resolve once, in Increment 1.

## Global Constraints

- The browser sends intent only; it never supplies a resulting card identity, draw order, computed result, or destination state.
- Every configured card is in exactly one live zone at every active-session version.
- The GM receives only the GM hand and GM-private procedure data—not player private faces.
- Player projections contain only that player's private identities.
- Public payloads expose card backs/counts and publicly revealed/played/discarded identities only.
- Duplicate `(sessionId, commandId)` with the same canonical validated command returns recorded outcome metadata plus the actor's current projection. A different hash returns `command-id-reused`.
- Nonstructural commands retry lost version claims up to four total attempts. Structural commands require exact observed version and return `409` after any intervening structural change.
- One active or frozen session per campaign; no auto-expiry.
- Session rules are pinned in an immutable runtime snapshot at session start.
- Poll about once per second only while the table is visible, pause while hidden, and refresh immediately on focus/reconnect. Dashboard polling is about five seconds.

---

### Task 1: Define complete session state, zones, commands, and projections

**Files:**
- Create: `src/lib/types/session.ts`
- Create: `src/lib/schemas/session.schema.ts`
- Create: `src/lib/engine/session/state.ts`
- Create: `src/lib/engine/session/zones.ts`
- Create: `src/lib/engine/session/invariants.ts`
- Test: `tests/unit/session/zones.test.ts`
- Test: `tests/unit/session/invariants.test.ts`

- [ ] **Step 1: Write failing zone conservation tests**

```ts
import { describe, expect, it } from 'vitest';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { makeSessionFixture } from '../../fixtures/session';

describe('session card invariants', () => {
  it('accepts one location for all 78 cards', () => {
    expect(() => assertSessionInvariants(makeSessionFixture())).not.toThrow();
  });

  it('rejects duplicate and missing card ids', () => {
    const duplicate = makeSessionFixture();
    duplicate.playerDiscard.push(duplicate.playerDraw[0]);
    expect(() => assertSessionInvariants(duplicate)).toThrow(/duplicate card/i);
    const missing = makeSessionFixture();
    missing.playerDraw.pop();
    expect(() => assertSessionInvariants(missing)).toThrow(/missing card/i);
  });

  it('rejects a major card in a player-only zone', () => {
    const state = makeSessionFixture();
    const major = state.majorDraw.pop();
    if (!major) throw new Error('major fixture empty');
    state.playerDraw.push(major);
    expect(() => assertSessionInvariants(state)).toThrow(/wrong deck/i);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- tests/unit/session/zones.test.ts tests/unit/session/invariants.test.ts`

Expected: FAIL because session engine modules do not exist.

- [ ] **Step 3: Define explicit card references and zones**

```ts
export type CardId = string;
export type UserId = string;

export interface OwnedPrivateZone {
  kind: 'player-hand' | 'player-facedown' | 'player-prepared';
  ownerUserId: UserId;
  cards: CardId[];
}

export interface SessionEngineStateV1 {
  schemaVersion: 1;
  sessionId: string;
  version: number;
  phase: 'crawl' | 'challenge' | 'camp' | 'city';
  procedure: ProcedureState | null;
  majorDraw: CardId[];
  majorDiscard: CardId[];
  playerDraw: CardId[];
  playerDiscard: CardId[];
  gmHand: CardId[];
  privateZones: OwnedPrivateZone[];
  publicZones: Array<{
    id: string;
    kind: 'initiative' | 'played' | 'revealed' | 'inspiration';
    cards: CardId[];
  }>;
  pendingZones: Array<{ id: string; deck: 'major' | 'player'; cards: CardId[] }>;
  reshuffleAtBoundary: { major: boolean; player: boolean };
}
```

Define `SessionCommand` as a discriminated union for `draw`, `deal`, `play`, `place-facedown`, `reveal`, `discard`, `transfer`, `select-from-discard`, `reorder-top`, `mulligan`, `begin-procedure`, `advance-procedure`, `complete-procedure`, `end-round`, and `apply-correction`. Card-moving commands identify a source zone and actor-owned selection; `draw`/`deal` specify count and destination but never card IDs.

Define public, player, and GM projections separately. Hidden slots use `{ hidden: true }` without `id`, `label`, `imageKey`, `value`, `suit`, `rank`, or major metadata.

- [ ] **Step 4: Validate complete state and commands with Zod**

Use discriminated unions matching the TypeScript contract. Add `.strict()` to command objects so an attacker cannot smuggle `cardId` into a draw. Canonical request hashing occurs only after `sessionCommandEnvelopeSchema.parse` removes no unknown data; strict parsing must reject it.

- [ ] **Step 5: Implement invariants**

`assertSessionInvariants(state, catalog)` checks the configured 78-ID set, uniqueness, deck ownership, zone visibility/ownership, private recipient membership, ordered/unordered semantics, current version, and procedure-owned pending zone references. It returns `void` and throws a domain `SessionInvariantError` containing only zone IDs/counts—not hidden card IDs.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- tests/unit/session/zones.test.ts tests/unit/session/invariants.test.ts`

Expected: PASS.

```bash
git add src/lib/types/session.ts src/lib/schemas/session.schema.ts src/lib/engine/session/state.ts src/lib/engine/session/zones.ts src/lib/engine/session/invariants.ts tests/unit/session tests/fixtures/session.ts
git commit -m "feat(session): define shared tarot state and invariants"
```

### Task 2: Implement the generic pure card reducer

**Files:**
- Create: `src/lib/engine/session/result.ts`
- Create: `src/lib/engine/session/reducer.ts`
- Create: `src/lib/engine/session/card-commands.ts`
- Create: `src/lib/engine/session/shuffle.ts`
- Create: `src/lib/engine/session/projection.ts`
- Test: `tests/unit/session/reducer.test.ts`
- Test: `tests/unit/session/projection.test.ts`
- Test: `tests/unit/session/property.test.ts`

- [ ] **Step 1: Write failing authorization and privacy examples**

```ts
it('lets a player see only their own hand identities', () => {
  const state = fixtureWithHands({ playerA: ['cups-i'], playerB: ['swords-x'] });
  const projection = projectForActor(state, { kind: 'player', userId: 'playerA' }, catalog);
  expect(JSON.stringify(projection)).toContain('cups-i');
  expect(JSON.stringify(projection)).not.toContain('swords-x');
});

it('does not grant a GM player hand identities', () => {
  const state = fixtureWithHands({ playerA: ['cups-i'] });
  const projection = projectForActor(state, { kind: 'gm', userId: 'gm' }, catalog);
  expect(JSON.stringify(projection)).not.toContain('cups-i');
  expect(projection.private.playerHandCounts.playerA).toBe(1);
});

it('rejects moving another player private card', () => {
  const result = reduceSession(state, actorA, commandSelectingPlayerBCard, runtime);
  expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
});
```

- [ ] **Step 2: Run the reducer tests to verify they fail**

Run: `npm test -- tests/unit/session/reducer.test.ts tests/unit/session/projection.test.ts`

Expected: FAIL because reducer and projector do not exist.

- [ ] **Step 3: Implement composable legal transitions**

```ts
export type ReduceResult =
  | { ok: true; state: SessionEngineStateV1; events: SessionEvent[] }
  | { ok: false; rejection: SessionRejection };

export interface ReduceContext {
  actor: SessionActor;
  runtime: SessionRuntimeContentV1;
  rng: Rng;
}

export function reduceSession(
  state: SessionEngineStateV1,
  command: SessionCommand,
  context: ReduceContext
): ReduceResult;
```

Each handler clones only touched arrays, validates actor/source/destination/count/card kind/visibility, applies a transition, emits sanitized public plus recipient-private events, increments no version itself, and calls `assertSessionInvariants` before returning. The command service owns the resulting version.

For a required draw that cannot complete, shuffle only eligible discard cards with the injected RNG, continue drawing, and set a public reshuffle cue. If eligible draw plus discard is insufficient, return `illegal-command` with counts only.

Drawing `fool` schedules both deck flags at the procedure's next configured boundary. Do not reshuffle immediately unless exhaustion independently requires it.

- [ ] **Step 4: Implement role projection as allowlists**

Projection starts from a new object and copies approved fields. Never clone state and delete secrets. Export:

```ts
export function projectForActor(
  state: SessionEngineStateV1,
  actor: SessionActor,
  catalog: TarotCardCatalog
): SessionProjection;
```

Public cards, public discard tops, initiative, plays, reveals, and results are hydrated from the runtime catalog. Private hydration occurs only for the actor's zone or GM hand. Other hidden zones become counts/card backs. Projected controls come from `legalCommandsForActor`, not client-side guesses.

- [ ] **Step 5: Add randomized command-sequence conservation tests**

Without adding a property-testing dependency, use `makeRng` to generate 500 deterministic legal sequences of 200 commands. After every accepted command, assert invariants and compare the sorted 78 IDs. Persist failing seed and step in the assertion message.

```ts
for (let seed = 0; seed < 500; seed += 1) {
  let state = makeSessionFixture(String(seed));
  for (let step = 0; step < 200; step += 1) {
    const command = chooseLegalCommand(state, makeRng(`${seed}:${step}`));
    const result = reduceSession(state, command, contextFor(command));
    if (result.ok) state = result.state;
    expect(() => assertSessionInvariants(state, catalog), `seed=${seed} step=${step}`).not.toThrow();
  }
}
```

- [ ] **Step 6: Run coverage and commit**

Run: `npx vitest run tests/unit/session --coverage`

Expected: session engine files at least 90% for statements, branches, functions, and lines. If coverage support is not installed, add `@vitest/coverage-v8` as a dev dependency and commit the lockfile.

```bash
git add src/lib/engine/session tests/unit/session package.json package-lock.json
git commit -m "feat(session): reduce and project shared card commands"
```

### Task 3: Add session snapshots, command claims, events, and secrets

**Files:**
- Modify: `src/lib/server/db/schema.ts`
- Create: `src/lib/server/db/migrations/0003_shared_table_core.sql`
- Modify: migration metadata files
- Test: `tests/integration/session-constraints.test.ts`

- [ ] **Step 1: Write failing persistence constraint tests**

Assert one active/frozen session per campaign, one runtime/server row per session, one private row per recipient, unique command id, unique accepted resulting version, and result=expected+1:

```ts
await insertAcceptedCommand(db, { commandId: 'a', expectedVersion: 1, resultingVersion: 2 });
await expect(
  insertAcceptedCommand(db, { commandId: 'b', expectedVersion: 1, resultingVersion: 2 })
).rejects.toThrow(/unique/i);
await expect(
  insertAcceptedCommand(db, { commandId: 'c', expectedVersion: 1, resultingVersion: 3 })
).rejects.toThrow(/check/i);
```

- [ ] **Step 2: Add the normalized session tables**

Implement specification sections 6.4–6.5 exactly:

- `playSessions`
- `sessionRuntimeContents`
- `sessionPrivateStates`
- `sessionServerStates`
- `sessionCommands`
- `campaignEvents`
- `campaignEventSecrets`

Each JSON fragment has a schema version and `sessionVersion`. Add:

```ts
uniqueIndex('play_sessions_open_campaign_uq')
  .on(table.campaignId)
  .where(sql`status IN ('active', 'frozen')`);

uniqueIndex('session_commands_resulting_version_uq')
  .on(table.sessionId, table.resultingVersion)
  .where(sql`resulting_version IS NOT NULL`);
```

The migration SQL includes checks for valid status, nonnegative versions, and `resulting_version IS NULL OR resulting_version = expected_version + 1`.

- [ ] **Step 3: Apply and cross-check both targets**

Run:

```bash
npm run db:generate
npm run db:migrate:d1:local
npm test -- tests/integration/session-constraints.test.ts
```

Expected: all constraints pass on SQLite; local D1 smoke rejects the same conflicting version claim.

- [ ] **Step 4: Commit the schema**

```bash
git add src/lib/server/db/schema.ts src/lib/server/db/migrations tests/integration/session-constraints.test.ts
git commit -m "feat(session): persist split snapshots and command journal"
```

### Task 4: Compile and pin immutable runtime content

**Files:**
- Create: `src/lib/server/content/session-runtime.ts`
- Create: `src/lib/schemas/session-runtime.schema.ts`
- Modify: `src/lib/types/session.ts`
- Test: `tests/unit/session-runtime.test.ts`

- [ ] **Step 1: Write failing determinism and size tests**

```ts
const first = compileSessionRuntimeContent();
const second = compileSessionRuntimeContent();
expect(first).toEqual(second);
expect(first.contentDigest).toMatch(/^[a-f0-9]{64}$/);
expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(1_900_000);
```

- [ ] **Step 2: Compile only required runtime data**

```ts
export interface SessionRuntimeContentV1 {
  schemaVersion: 1;
  contentPackId: string;
  contentPackVersion: string;
  contentDigest: string;
  tarot: TarotConfig;
  procedures: TarotProcedureDefinition[];
  cards: TarotCardCatalogEntry[];
  modifiers: SessionModifierDefinition[];
}
```

Create a stable-key canonical serializer for the digest. The compiled object contains no rule reference prose unrelated to live procedures. Validate it before insert and again after read.

- [ ] **Step 3: Prove deployment pinning**

In the test, create a session snapshot from fixture runtime v1, change the mocked bundled config to v2, reload the persisted session, and assert the reducer still receives v1.

- [ ] **Step 4: Run and commit**

Run: `npm test -- tests/unit/session-runtime.test.ts`

Expected: PASS.

```bash
git add src/lib/server/content/session-runtime.ts src/lib/schemas/session-runtime.schema.ts src/lib/types/session.ts tests/unit/session-runtime.test.ts
git commit -m "feat(session): pin immutable runtime rules"
```

### Task 5: Implement atomic session start, command, freeze, recovery, and end services

**Files:**
- Create: `src/lib/server/db/atomic.ts`
- Modify: `src/lib/server/db/index.ts`
- Modify: `src/app.d.ts`
- Create: `src/lib/server/session/repository.ts`
- Create: `src/lib/server/session/command-service.ts`
- Create: `src/lib/server/session/lifecycle.ts`
- Create: `src/lib/server/session/canonical-json.ts`
- Test: `tests/integration/session-command-service.test.ts`
- Test: `tests/integration/session-atomicity.test.ts`

- [ ] **Step 1: Write failing idempotency/contention tests**

Test:

```ts
const first = await executeCommand(ctx, envelope);
const duplicate = await executeCommand(ctx, envelope);
expect(duplicate.outcome).toEqual(first.outcome);
expect(await countCommandRows(ctx, envelope.commandId)).toBe(1);

const changed = await executeCommand(ctx, {
  ...envelope,
  command: { type: 'draw', count: 2, destinationZoneId: 'hand:a' }
});
expect(changed).toMatchObject({ ok: false, code: 'command-id-reused' });
```

Race two commands read at version N: independent nonstructural draws eventually claim N+1 and N+2; a structural `end-round` with observed N returns stale after N+1.

- [ ] **Step 2: Expose the raw-target atomic context safely**

Replace the unsafe cast-only DB resolver with:

```ts
export type AppDbContext =
  | { kind: 'sqlite'; db: BetterSQLite3Database<typeof schema>; raw: import('better-sqlite3').Database }
  | { kind: 'd1'; db: DrizzleD1Database<typeof schema>; raw: D1Database };
```

Store this context in `event.locals.dbContext`; retain `event.locals.db` as the correctly narrowed common Drizzle query surface for existing reads. `runAtomic` accepts a finite list of parameterized mutation statements: SQLite prepares/runs them inside `raw.transaction`, D1 prepares them and calls `raw.batch`. It never accepts raw user-controlled SQL.

- [ ] **Step 3: Implement canonical validated request hashing**

Recursively sort object keys, preserve array order, encode UTF-8, hash SHA-256. Hash only `parsed.command`, not unvalidated request bytes or actor/session metadata. Unit test equivalent object key order and distinct array order.

- [ ] **Step 4: Implement the four-attempt command loop**

Algorithm:

1. Authenticate and authorize actor.
2. Strict-parse envelope.
3. Lookup `(sessionId, commandId)`; same hash returns stored outcome metadata plus fresh actor projection, different hash rejects.
4. Load and validate all fragments at one session version plus pinned runtime.
5. For structural commands, require `observedVersion === currentVersion`.
6. Derive an attempt-specific RNG from server-only shuffle state; run pure reducer.
7. Split next state and events into public/private/server fragments.
8. Atomically insert command/version claim, update all fragments, and insert public/private events.
9. On unique claim collision: hard-reject structural; otherwise reread/reduce, maximum four attempts.
10. Return current authorized projection; never return a stored private response body.

Unexpected invariant/load failure freezes the session in an atomic status/audit mutation and returns a redacted recovery error.

- [ ] **Step 5: Implement start and end cleanup**

Start inserts session sequence, public/private/server version 1 fragments, pinned runtime, and lifecycle event atomically. Freshly shuffle player and major decks with a cryptographically random server seed stored only as recovery state; do not expose or later reveal the seed.

End creates `finalPublicStateJson`, hashes ordered public events plus final public state into `publicHistoryChecksum`, sets status ended, deletes private rows, clears secret server JSON, deletes `campaignEventSecrets`, and records the end event atomically. The checksum is documented as corruption detection only.

- [ ] **Step 6: Add failure injection**

For each atomic statement index, force an exception and assert no new command claim, snapshot version, event, secret, character claim, resource change, or tenure change remains. Run this matrix against SQLite; run representative first/middle/last failures against local D1.

- [ ] **Step 7: Run service tests and commit**

Run:

```bash
npm test -- tests/integration/session-command-service.test.ts tests/integration/session-atomicity.test.ts
npm run check
```

Expected: PASS.

```bash
git add src/lib/server/db/index.ts src/lib/server/db/atomic.ts src/app.d.ts src/lib/server/session tests/integration/session-command-service.test.ts tests/integration/session-atomicity.test.ts
git commit -m "feat(session): execute idempotent atomic commands"
```

### Task 6: Add session and polling APIs with privacy canaries

**Files:**
- Create: `src/routes/api/campaigns/[id]/sessions/+server.ts`
- Create: `src/routes/api/campaigns/[id]/sessions/[sessionId]/+server.ts`
- Create: `src/routes/api/campaigns/[id]/sessions/[sessionId]/commands/+server.ts`
- Create: `src/routes/api/campaigns/[id]/events/+server.ts`
- Create: `src/lib/server/session/latest-cursor.ts`
- Create: `src/lib/server/session/sanitize.ts`
- Test: `tests/integration/session-api.test.ts`
- Test: `tests/integration/session-privacy.test.ts`

- [ ] **Step 1: Write the canary test before any endpoint**

Use unique identities such as `SECRET_PLAYER_A_CUPS_I_7f02` in fixture runtime metadata and assert they are absent from GM/other-player/nonmember response body, headers, thrown messages, captured console calls, serialized SSR data, and event public payloads. The owner player's response must contain the identity only in its private projection.

- [ ] **Step 2: Implement route contracts**

- `POST /sessions`: GM starts; `201` projection.
- `GET /sessions`: sanitized completed history plus current summary.
- `GET /sessions/[sessionId]`: current role projection or completed public history.
- `PATCH /sessions/[sessionId]`: GM freeze/recover/end structural lifecycle command.
- `POST /commands`: strict envelope; `200` accepted/duplicate, `400` invalid, `409` stale/retry-exhausted, `404` denial.
- `GET /events?since=<cursor>`: role-projected events; `204` when no changes; otherwise next cursor and session projection delta/full projection.

All routes set `private, no-store`, validate numeric cursors, cap events per response, and never allow arbitrary historical secret reads.

- [ ] **Step 3: Add isolate-local cursor hints**

Use a bounded map keyed by campaign ID containing `{ cursor, observedAt }`. After authorization, a recent hint equal to the caller cursor may return `204`; missing/stale/uncertain hints fall through to D1. Update hints only after successful commits or confirmed reads. This cache is an optimization, never authority.

- [ ] **Step 4: Run API/privacy tests and commit**

Run: `npm test -- tests/integration/session-api.test.ts tests/integration/session-privacy.test.ts`

Expected: PASS and canary appears only in the owning player's expected private response.

```bash
git add src/routes/api/campaigns src/lib/server/session/latest-cursor.ts src/lib/server/session/sanitize.ts tests/integration/session-api.test.ts tests/integration/session-privacy.test.ts
git commit -m "feat(session): expose projected session APIs"
```

### Task 7: Build the table-first shell and automatic visible polling

**Files:**
- Create: `src/routes/campaigns/[id]/table/+page.server.ts`
- Create: `src/routes/campaigns/[id]/table/+page.svelte`
- Create: `src/lib/components/campaign/table/TableShell.svelte`
- Create: `src/lib/components/campaign/table/PhaseRail.svelte`
- Create: `src/lib/components/campaign/table/PublicTable.svelte`
- Create: `src/lib/components/campaign/table/PrivateHand.svelte`
- Create: `src/lib/components/campaign/table/EventLog.svelte`
- Create: `src/lib/components/campaign/table/MobileTableDrawers.svelte`
- Create: `src/lib/stores/campaign-session.svelte.ts`
- Test: `tests/e2e/shared-table.spec.ts`
- Test: `tests/e2e/shared-table-privacy.spec.ts`

- [ ] **Step 1: Write failing two-player/GM browser tests**

Three isolated contexts start a session, draw into both player hands, and assert:

- Each player sees their own face and the other's card back/count.
- GM sees both backs/counts but neither face.
- Public play becomes visible to all within two seconds without manual refresh.
- Hidden tab stops event requests; returning focus triggers an immediate request.
- Reconnect triggers an immediate request.
- Duplicate click/retry with one command ID applies once.

- [ ] **Step 2: Implement the synchronized store**

```ts
export function createCampaignSessionStore(initial: SessionProjectionEnvelope<SessionProjection>) {
  let snapshot = $state(initial);
  let visible = $state(true);
  let online = $state(true);

  async function poll(): Promise<void> {
    const response = await fetch(`events?since=${snapshot.campaignCursor}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    if (response.status === 204) return;
    if (!response.ok) throw new Error('Unable to refresh the campaign table');
    snapshot = await response.json();
  }

  return { get snapshot() { return snapshot; }, poll, sendCommand, start, stop };
}
```

`start` installs `visibilitychange`, `focus`, `online`, and `offline` listeners. It schedules the next one-second poll only after the prior request settles, adds randomized 0–150 ms jitter, and aborts outstanding requests on destroy. A visible accepted command immediately replaces the local projection from its response. Error text contains no server body or card identity.

Campaign list/detail pages use the same cursor mechanism at approximately five seconds while visible, pause while hidden, and refresh immediately on focus/reconnect. They do not use the one-second active-table cadence.

- [ ] **Step 3: Implement Table First layout**

Desktop: left phase rail, central table, right public log, private hand fixed to the bottom of the table region. Mobile: central table first, phase/log as accessible drawers, hand in a horizontal scroller. Generic actions are driven by projected legal controls. Do not add map, movement, health, range, denizen HP, voice, chat, or other VTT features.

Use current symbolic `TarotCard` rendering until the parallel artwork plan lands. Hidden cards always pass `faceDown` and never receive a card object.

- [ ] **Step 4: Run E2E privacy and sync tests**

Run:

```bash
npx playwright test tests/e2e/shared-table.spec.ts tests/e2e/shared-table-privacy.spec.ts
npm run check
```

Expected: all tests pass, with accepted public change visible within two seconds.

- [ ] **Step 5: Commit the table shell**

```bash
git add src/routes/campaigns/[id]/table src/lib/components/campaign/table src/lib/stores/campaign-session.svelte.ts tests/e2e/shared-table.spec.ts tests/e2e/shared-table-privacy.spec.ts
git commit -m "feat(session): add synchronized table-first interface"
```

### Task 8: Prove allowlisted pilot readiness

**Files:**
- Create: `tests/load/session-polling.mjs`
- Create: `docs/operations/campaign-pilot.md`
- Modify: `.env.example`

- [ ] **Step 1: Implement the nine-campaign load fixture**

The script authenticates fixture users through a local test-only credential setup, creates nine separate campaigns with three visible clients each, polls at the production cadence for ten minutes, and records requests, D1 reads/writes, p50/p95/p99 latency, `204` rate, and time-to-visible-event. It fails when any accepted change exceeds two seconds or error rate exceeds 0.1%.

- [ ] **Step 2: Run the complete pilot gate**

Run:

```bash
npm run content:verify
npx vitest run tests/unit/session --coverage
npm test -- tests/integration/session-constraints.test.ts tests/integration/session-command-service.test.ts tests/integration/session-atomicity.test.ts tests/integration/session-api.test.ts tests/integration/session-privacy.test.ts
npm run check
npm test
npx playwright test tests/e2e/shared-table.spec.ts tests/e2e/shared-table-privacy.spec.ts
node tests/load/session-polling.mjs
ADAPTER=cloudflare npm run build
```

Expected: every command exits 0; engine coverage is 90%+; public changes are visible within two seconds; no privacy canary leaks.

- [ ] **Step 3: Document pilot operations**

`docs/operations/campaign-pilot.md` records Workers Paid requirement, allowlist setup, start/freeze/recover/end steps, logs that are safe to inspect, privacy incident response, and the feature-disable rollback. It explicitly says no WebSocket/Durable Object dependency exists in v1.

- [ ] **Step 4: Commit Increment 2**

```bash
git add tests/load/session-polling.mjs docs/operations/campaign-pilot.md .env.example
git commit -m "test(session): gate allowlisted shared table pilot"
```

## Increment 2 Completion Record

Attach engine coverage, randomized seeds, SQLite/D1 atomicity evidence, privacy canary inventory, multi-context traces, and load-test metrics. Only named pilot users may access the table after this gate; `CAMPAIGNS_ENABLED` remains false.
