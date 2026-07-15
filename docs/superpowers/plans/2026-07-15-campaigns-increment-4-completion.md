# Campaigns Increment 4: In-Session Procedure Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every approved non-preparation tarot procedure, atomic character-resource integration, public history, corrections, active-session departure cleanup, archival behavior, and release-candidate accessibility.

**Architecture:** Small procedure modules compose the generic reducer and standalone resolution primitives. Session character mutations are narrow version-claimed writes in the same atomic unit as the accepted session command. History is a sanitized projection of the public journal/final state; corrections are compensating events and never destructive journal edits.

**Tech Stack:** Pure TypeScript engine modules, content-pack procedure definitions, SvelteKit services/routes, SQLite/D1 atomic adapter, Svelte 5, Vitest, Playwright and accessibility assertions.

## Global Constraints

- This increment covers in-session procedures only. Job Board, dungeon/city generators, GM prep oracles, and full VTT tools remain deferred.
- Every `supported-v1` procedure in `docs/rules/tarot-procedure-audit.md` must map to an engine module/test/UI flow or an explicit generic-table operation test.
- Resolve-for-favor is an explicit pre-draw purchase. Pushing remains free.
- Narrow resource mutations reread current character JSON/version and update only `resolve.current`; an unrelated version collision retries without overwriting sheet changes. A changed resource value requires user reconfirmation.
- Group tests use the most- and least-qualified eligible attached adventurers and two full test flows.
- Camp High Chant, leeches; Crawl Area Sense; test Augury; oracle Maleficence, Malediction, Random Totem, GM twist, and dispositions are required.
- Camp watches and Overland Travel card procedures identified by the audit are required.
- City Doomsaying, Strange Communions, and As Above, So Below are required; Job Board preparation remains absent.
- The flat 50% non-tarot choice remains a manual yes/no/random-physical-choice confirmation and never draws a tarot card.
- Completed public history never reveals cards that stayed private when the session ended.

---

### Task 1: Add narrow, reconfirmable Resolve mutations

**Files:**
- Create: `src/lib/server/character/resource-write.ts`
- Modify: `src/lib/server/session/command-service.ts`
- Modify: `src/lib/schemas/session.schema.ts`
- Test: `tests/integration/session-resolve.test.ts`
- Test: `tests/integration/session-atomicity.test.ts`

- [ ] **Step 1: Write failing resource-race tests**

Cover success, insufficient Resolve, unrelated sheet update collision, and a conflicting Resolve change:

```ts
const intent = {
  characterId,
  expectedCharacterVersion: 4,
  expectedResolveCurrent: 3,
  delta: -1 as const,
  reason: 'test-favor'
};
const result = await applyResolveIntent(ctx, intent);
expect(result).toMatchObject({ ok: true, version: 5, resolveCurrent: 2 });
```

When a concurrent notes edit moves version 4→5 but Resolve stays 3, the service rereads, reapplies to version 6, and preserves notes. When Resolve changes 3→2, return `{ ok:false, reason:'resource-changed', currentResolve:2, currentVersion:5 }` and do not draw or spend.

- [ ] **Step 2: Implement targeted JSON mutation**

Parse/migrate the latest full JSON, verify ownership/active tenure and resource facts, create a new object changing only:

```ts
const nextData: GuildBookCharacterData = {
  ...currentData,
  resolve: { ...currentData.resolve, current: nextResolve }
};
```

Insert the next character claim and update JSON/denormalized character version in the same session atomic mutation as command claim, session fragments, and events. Retry unrelated version collisions up to four attempts. Never accept a whole character body from a session command.

- [ ] **Step 3: Add explicit reconfirmation contract**

Session command includes both expected character version and expected Resolve value. On `resource-changed`, no command row/version is accepted. The response includes current numeric Resolve/version but no character document; UI must ask again.

- [ ] **Step 4: Run failure injection and commit**

Run: `npm test -- tests/integration/session-resolve.test.ts tests/integration/session-atomicity.test.ts`

Expected: PASS with no partial spend/draw under injected failures.

```bash
git add src/lib/server/character/resource-write.ts src/lib/server/session/command-service.ts src/lib/schemas/session.schema.ts tests/integration/session-resolve.test.ts tests/integration/session-atomicity.test.ts
git commit -m "feat(session): spend resolve with narrow versioned writes"
```

### Task 2: Implement guided individual and group tests

**Files:**
- Create: `src/lib/engine/session/procedures/test-of-fate.ts`
- Create: `src/lib/engine/session/procedures/group-test.ts`
- Modify: `src/lib/engine/session/reducer.ts`
- Create: `src/lib/components/campaign/table/procedures/TestOfFatePanel.svelte`
- Create: `src/lib/components/campaign/table/procedures/GroupTestPanel.svelte`
- Test: `tests/unit/session/procedures/test-of-fate.test.ts`
- Test: `tests/unit/session/procedures/group-test.test.ts`
- Test: `tests/e2e/campaign-tests-of-fate.spec.ts`

- [ ] **Step 1: Write failing procedure transition tests**

Individual stages: declare actor/suit, establish favor/disfavor/relevant aid or motif, optional Resolve confirmation, draw, classify, optionally push only after failure, finalize. Assert the server reads attached current attribute and Resolve; client-supplied attribute is rejected by strict schema.

Group stages: GM selects eligible group, engine selects most/least by current attribute and stable roster order, independently completes both tests, maps outcomes to hits, and publishes the configured group result.

- [ ] **Step 2: Implement individual test state**

```ts
export interface GuidedTestStateV1 {
  schemaVersion: 1;
  stage: 'declare' | 'favor' | 'initial-draw' | 'push-offer' | 'complete';
  actorTenureId: string;
  testedSuit: SuitId;
  favor: boolean;
  disfavor: boolean;
  resolvePurchase: null | { characterId: string; spent: 1 };
  initialCardZoneId: string | null;
  pushCardZoneId: string | null;
  result: TestOfFateResult | null;
}
```

Call `resolveTestOfFate` from Increment 0.5. The result is public only after the applicable draw/reveal step; pending card identity obeys procedure visibility. Drawing the Fool schedules configured reshuffle at procedure completion boundary.

- [ ] **Step 3: Implement group composition**

Use `selectGroupTestActors` and `resolveGroupTest`; do not fork arithmetic. Each subtest owns separate favor/disfavor/Resolve/push decisions and card zones. Publish the chosen actor names before draws and the final two outcomes/hits after completion.

- [ ] **Step 4: Build projection-driven panels**

GM declares the fictional test and group; the acting player confirms Resolve/push. Render `Spend 1 Resolve for favor` only when current projection says affordable. On a resource-change conflict, refresh projection and require a second click. Announce every public result.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/unit/session/procedures/test-of-fate.test.ts tests/unit/session/procedures/group-test.test.ts tests/integration/session-resolve.test.ts
npx playwright test tests/e2e/campaign-tests-of-fate.spec.ts
npm run check
```

Expected: PASS.

```bash
git add src/lib/engine/session/procedures src/lib/engine/session/reducer.ts src/lib/components/campaign/table/procedures tests/unit/session/procedures tests/e2e/campaign-tests-of-fate.spec.ts
git commit -m "feat(session): guide individual and group tests"
```

### Task 3: Implement Camp tarot procedures

**Files:**
- Create: `src/lib/engine/session/procedures/camp.ts`
- Create: `src/lib/components/campaign/table/procedures/CampProcedurePanel.svelte`
- Test: `tests/unit/session/procedures/camp.test.ts`
- Test: `tests/e2e/camp-procedures.spec.ts`

- [ ] **Step 1: Write failing Camp examples**

Cover High Chant private transfer, leeches card operation/results, Camp watches and their round-boundary card handling, authorized actors, completion, and reshuffle scheduling. Assert nonparticipants and GM do not see a player-to-player transferred face unless the rule makes it public.

- [ ] **Step 2: Implement typed Camp commands**

```ts
export type CampProcedureCommand =
  | { type: 'begin-high-chant'; recipientTenureId: string }
  | { type: 'complete-high-chant-transfer'; cardId: string }
  | { type: 'begin-leeches'; targetTenureId: string }
  | { type: 'advance-leeches' }
  | { type: 'complete-camp-procedure' };
```

Each transition is configured by the generated procedure steps. High Chant composes generic `transfer`; leeches composes draw/reveal/discard as audited. No Camp resource outside the modeled card procedure is auto-mutated.

- [ ] **Step 3: Build UI and verify privacy**

Run:

```bash
npm test -- tests/unit/session/procedures/camp.test.ts tests/integration/session-privacy.test.ts
npx playwright test tests/e2e/camp-procedures.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Commit Camp procedures**

```bash
git add src/lib/engine/session/procedures/camp.ts src/lib/components/campaign/table/procedures/CampProcedurePanel.svelte tests/unit/session/procedures/camp.test.ts tests/e2e/camp-procedures.spec.ts
git commit -m "feat(session): add camp tarot procedures"
```

### Task 4: Implement Crawl, Augury, and in-session oracle procedures

**Files:**
- Create: `src/lib/engine/session/procedures/crawl.ts`
- Create: `src/lib/engine/session/procedures/augury.ts`
- Create: `src/lib/engine/session/procedures/oracles.ts`
- Create: `src/lib/components/campaign/table/procedures/CrawlProcedurePanel.svelte`
- Create: `src/lib/components/campaign/table/procedures/OraclePanel.svelte`
- Test: `tests/unit/session/procedures/crawl.test.ts`
- Test: `tests/unit/session/procedures/oracles.test.ts`
- Test: `tests/e2e/exploration-tarot.spec.ts`

- [ ] **Step 1: Write the procedure coverage matrix as tests**

One named test for each:

- Crawl Area Sense.
- Overland Travel.
- Test Augury.
- Maleficence.
- Malediction.
- Random Totem.
- GM twist.
- Disposition draw/interpretation.
- City Doomsaying.
- Strange Communions.
- As Above, So Below.
- Flat 50% manual branch without a deck mutation.

Each test asserts actor, deck, count, visibility, legal zone transitions, boundary, and public/private event shape from the audit/content definition.

- [ ] **Step 2: Define a data-driven finite procedure runner**

For procedures expressible entirely through catalog steps, use:

```ts
export interface FiniteProcedureStateV1 {
  schemaVersion: 1;
  procedureId: string;
  stepIndex: number;
  actorUserIds: string[];
  selections: Record<string, string[]>;
  completed: boolean;
}
```

The runner maps the current validated content step to one generic card command, enforces its actor/visibility/completion mode, advances exactly one step, and rejects unsupported operations. Procedure-specific modules add typed calculations or selection rules only where the generic runner cannot express them.

- [ ] **Step 3: Implement oracle interpretation metadata**

Card draw and derived suit/value/tier/parity are authoritative and public/private as the audited rule requires. The GM records a bounded free-text interpretation/outcome. The app does not generate prose or prep content. Per-denizen oracle abilities use generic predicates and a content lookup ID, never hardcoded denizen names.

- [ ] **Step 4: Preserve manual 50% behavior**

The `manual-choice` operation produces a confirmation UI with `yes`/`no` result and a public log. Reducer state and both deck orders remain byte-identical across the command except for procedure/log metadata.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/unit/session/procedures/crawl.test.ts tests/unit/session/procedures/oracles.test.ts tests/unit/session/property.test.ts
npx playwright test tests/e2e/exploration-tarot.spec.ts
npm run check
```

Expected: PASS.

```bash
git add src/lib/engine/session/procedures src/lib/components/campaign/table/procedures tests/unit/session/procedures tests/e2e/exploration-tarot.spec.ts
git commit -m "feat(session): add exploration and oracle procedures"
```

### Task 5: Add audited corrections and sanitized completed history

**Files:**
- Create: `src/lib/server/session/history.ts`
- Create: `src/lib/engine/session/corrections.ts`
- Create: `src/routes/campaigns/[id]/sessions/+page.server.ts`
- Create: `src/routes/campaigns/[id]/sessions/+page.svelte`
- Create: `src/routes/campaigns/[id]/sessions/[sessionId]/+page.server.ts`
- Create: `src/routes/campaigns/[id]/sessions/[sessionId]/+page.svelte`
- Create: `src/lib/components/campaign/table/CorrectionDialog.svelte`
- Test: `tests/integration/session-history.test.ts`
- Test: `tests/e2e/session-history.spec.ts`

- [ ] **Step 1: Write failing purge/history tests**

End a fixture session containing public cards, private hands, prepared cards, server draw order, and recipient event secrets. Assert:

```ts
expect(history.publicEvents).toContainEqual(expect.objectContaining({ kind: 'card-revealed' }));
expect(serializedHistory).toContain(publicCardCanary);
expect(serializedHistory).not.toContain(privateHandCanary);
expect(serializedHistory).not.toContain(serverOrderCanary);
expect(await countPrivateStates(sessionId)).toBe(0);
expect(await countEventSecrets(sessionId)).toBe(0);
```

Verify the checksum changes if ordered public history is accidentally altered and document that it is not a signature.

- [ ] **Step 2: Implement compensating corrections**

Corrections never edit/delete old commands or events. `apply-correction` requires GM, reason, and typed correction kind; it applies a legal compensating card transition through the invariant checker and appends `correction-applied` linking the original event/command. Death correction continues through the character life service and never restores a tenure.

- [ ] **Step 3: Build current-member history pages**

GM and all current members can list completed sessions and see ordered public log/final table. Former/removed/nonmembers receive `404`. No private card image URL, alt text, JSON, or hidden DOM node is rendered. History responses are `private, no-store`.

- [ ] **Step 4: Run and commit**

Run:

```bash
npm test -- tests/integration/session-history.test.ts tests/integration/session-privacy.test.ts
npx playwright test tests/e2e/session-history.spec.ts
```

Expected: PASS.

```bash
git add src/lib/server/session/history.ts src/lib/engine/session/corrections.ts src/routes/campaigns/[id]/sessions src/lib/components/campaign/table/CorrectionDialog.svelte tests/integration/session-history.test.ts tests/e2e/session-history.spec.ts
git commit -m "feat(session): add corrections and sanitized history"
```

### Task 6: Complete active-session leave, removal, and archive cleanup

**Files:**
- Create: `src/lib/server/session/member-cleanup.ts`
- Modify: `src/lib/server/campaign/membership.ts`
- Modify: `src/lib/server/campaign/service.ts`
- Test: `tests/integration/session-member-cleanup.test.ts`
- Test: `tests/e2e/campaign-departure.spec.ts`

- [ ] **Step 1: Write failing cleanup atomicity tests**

Player leaves and GM removes in each generic/Challenge stage. Assert membership revocation, living tenure end, every private hand/face-down/prepared card returning to its owning draw pile followed by an authoritative shuffle, public cards moving through their configured cleanup destinations, Challenge participant/pending-join removal, sanitized count-only public event, private-secret deletion, and immediate subsequent `404`. Inject every statement failure and assert original access/state remains intact.

- [ ] **Step 2: Implement one cleanup service used by both paths**

```ts
export interface MemberCleanupIntent {
  campaignId: string;
  membershipId: string;
  actorUserId: string;
  reason: 'left' | 'removed';
}
```

The session engine receives a typed `remove-participant` system command and determines legal card destinations. The server atomically claims the session version, persists fragments/events, ends tenure, and updates membership. Retry nonstructural collision up to four attempts. No auto-expiry or silent force-delete fallback exists.

- [ ] **Step 3: Enforce archive boundary**

Archive query checks for any `active` or `frozen` play session in the same atomic service call. On conflict return `409` with a safe message. Archived campaigns and completed histories remain read-only for the GM and current members, but are not joinable or playable.

- [ ] **Step 4: Run and commit**

Run: `npm test -- tests/integration/session-member-cleanup.test.ts tests/integration/session-atomicity.test.ts`

Expected: PASS.

```bash
git add src/lib/server/session/member-cleanup.ts src/lib/server/campaign/membership.ts src/lib/server/campaign/service.ts tests/integration/session-member-cleanup.test.ts tests/e2e/campaign-departure.spec.ts
git commit -m "feat(campaigns): cleanly leave active sessions"
```

### Task 7: Finish table accessibility and responsive behavior

**Files:**
- Modify: `src/lib/components/campaign/table/**/*.svelte`
- Modify: `src/lib/components/tarot/TarotCard.svelte`
- Create: `tests/e2e/campaign-accessibility.spec.ts`
- Create: `tests/e2e/campaign-mobile.spec.ts`

- [ ] **Step 1: Add failing accessibility assertions**

Test GM/player table with keyboard only, 200% zoom, 320 CSS-pixel width, reduced motion, forced colors, logical tab order, focus retention after polling, live announcements, drawer focus trap/return, and card-back names without identity. Add `@axe-core/playwright` only if approved as a dev dependency; otherwise implement Playwright role/name/contrast-adjacent checks and run the project’s chosen external audit in CI.

- [ ] **Step 2: Fix semantics without changing privacy projection**

All interactive cards are buttons with state/position labels. Public images have descriptive card names; private owner images do too; hidden images/card backs say only `Face-down card`. Do not solve accessibility by placing hidden identity in `aria-label`, `title`, data attributes, test IDs, or offscreen text.

At mobile widths, table stays primary; phase/log drawers are keyboard-operable; private hand scrolls horizontally; enlargement is a dialog using only authorized projection data. At 200% zoom there is no two-dimensional page overflow outside the intentional hand scroller.

- [ ] **Step 3: Run the release-candidate gate**

Run:

```bash
npm run content:verify
npx vitest run tests/unit/session --coverage
npm test
npm run check
npx playwright test tests/e2e/campaign-tests-of-fate.spec.ts tests/e2e/camp-procedures.spec.ts tests/e2e/exploration-tarot.spec.ts tests/e2e/session-history.spec.ts tests/e2e/campaign-departure.spec.ts tests/e2e/campaign-accessibility.spec.ts tests/e2e/campaign-mobile.spec.ts
ADAPTER=cloudflare npm run build
```

Expected: every command exits 0; engine coverage 90%+; every `supported-v1` audit ID is covered by a named test mapping.

- [ ] **Step 4: Commit Increment 4**

```bash
git add src/lib/components/campaign/table src/lib/components/tarot/TarotCard.svelte tests/e2e/campaign-accessibility.spec.ts tests/e2e/campaign-mobile.spec.ts
git commit -m "fix(campaigns): complete accessible session procedures"
```

## Increment 4 Completion Record

Attach the audit-ID-to-test mapping, Resolve race evidence, private-state purge proof, member-cleanup failure matrix, accessibility report, mobile screenshots, and full release-candidate command output. Public enablement still waits for artwork and Increment 5.
