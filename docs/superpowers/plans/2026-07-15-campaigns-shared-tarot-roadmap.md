# Campaigns and Shared Tarot Delivery Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved, table-first campaign feature as a sequence of independently verifiable increments, ending with a guarded production rollout.

**Architecture:** A SvelteKit monolith exposes campaign services and role-projected APIs over a pure shared-tarot reducer. SQLite transactions and D1 batches persist versioned public/private/server snapshots plus an append-only command/event journal. The browser sends intent and never owns authoritative shuffles, hidden card identities, or rule results.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, TypeScript strict, Drizzle ORM, SQLite/better-sqlite3, Cloudflare D1, Zod, Vitest, Playwright, Tailwind CSS v4.

## Decision Log

Decisions and open questions that change what gets built. The design review's B1 asked that external dependencies be tracked as named risks with owners rather than buried as assumptions; this is that register.

| # | Question | Status | Resolution |
|---|---|---|---|
| D1 | Is permission granted for the 80-image Rider–Waite–Smith scan set? | **Resolved 2026-07-15** | Confirmed by the project owner. The art plan proceeds. `scripts/fetch-rwsa-tarot.sh:8-10`, the pack README, and `index.json`'s licence field still say otherwise and must be corrected — see the art plan's amendment 1. Keep the source collection swappable; the 1909 artwork is public domain and only these scans carry the claim. |
| D2 | Do oracle procedures resolve their lookup tables, or does the GM type the outcome? | **Resolved 2026-07-15** | Full lookup. The app resolves the drawn card against the verbatim table and logs the outcome; the GM still adjudicates the fictional consequence. Confirms specification §9 and §17.1; withdraws Increment 4 Task 4 Step 3's free-text descope. Drives Increment 0b's `TarotLookupTable` contract. |
| D3 | Is the specification approved? | **Open — blocks Increment 0a** | The spec header reads "awaiting final approval" while this roadmap lists "Approved spec" as Increment 0a's dependency. Approval should follow the amendments in this round, since four plans contradicted the spec at the time it was written. |
| D4 | Cloudflare Pages or Workers? | **Open — blocks Increment 5 only** | `wrangler.toml` is a Pages config, but Increment 5 assumes Workers: `wrangler deploy --dry-run` errors on a Pages project, and the `[[ratelimits]]` binding is Workers-only yet type-checks cleanly on Pages, so it would be `undefined` at runtime and trip the plan's own fail-closed guard in production. Deliberately deferred — it does not block Increments 0a–4. See the Increment 5 amendments. |

## Global Constraints

- The specification at `docs/superpowers/specs/2026-07-15-campaigns-shared-tarot-design.md` is normative. If a plan and the specification conflict, stop and amend the plan before implementing. Where this roadmap's Contract Freeze previously conflicted with the specification, the freeze has been amended to match — see "Drift already present in the increment plans".
- Keep game rules and procedure data in `static/content-packs/hmtw/`; Svelte components and route handlers must not encode rule thresholds or card transitions.
- Keep `src/lib/engine/` pure: no SvelteKit, UI, database, clock, network, or environment imports.
- The server is authoritative for shuffle order, draws, procedure legality, and card destinations.
- A GM must never receive a player's hidden card identity in SSR data, JSON, HTML, DOM attributes, image paths, alt text, logs, errors, or telemetry.
- Existing schema-only `guilds`, `guildMembers`, and `guildDraws` tables are not the campaign model. Do not read, write, rename, or drop them during this feature.
- All JSON at storage or API boundaries is versioned and validated with Zod.
- All accepted session commands are idempotent by `(sessionId, commandId)` and claim exactly one resulting session version.
- All character writers use required integer `expectedVersion`; `expectedUpdatedAt` remains only for the one-release compatibility path defined in Increment 1.
- New pure engine modules maintain at least 90% statement/branch/function/line coverage. The repository-wide threshold is not raised as part of this work.
- Every increment runs `npm run check`, targeted Vitest tests, full `npm test`, `npm run content:verify`, and the adapter-specific checks named in its plan before being considered complete.
- Do not enable public navigation or production access merely because an earlier increment is merged. `CAMPAIGNS_ENABLED` and `CAMPAIGNS_PILOT_USER_IDS` remain server-enforced until Increment 5.
- Co-GMs, GM ownership transfer, campaign deletion, Hold a Funeral automation, richer collaboration/export, and every full-VTT surface are deferred. Tenure IDs and death history must remain stable so later funeral tooling can reference them.

---

## Plan Set and Dependency Order

| Order | Plan | Deliverable | Depends on | Release state |
|---|---|---|---|---|
| 1 | `2026-07-15-campaigns-increment-0a-rules-import.md` | Chapter 6–9 and cross-chapter rules prose in the browsable reference | Approved spec | No campaign UI |
| 2 | `2026-07-15-campaigns-increment-0b-procedure-contract.md` | Audited, generated tarot-procedure content and verbatim oracle lookup tables | Increment 0a | No campaign UI |
| 3 | `2026-07-15-campaigns-increment-0-5-resolution-engine.md` | Correct standalone test/group resolution engine and `/deck` flow | Increment 0b | No campaign UI |
| 4 | `2026-07-15-campaigns-increment-1-foundation.md` | Character versioning, campaign lifecycle, invites, roster, membership, tenure/death | Increment 0b | Feature-flagged internal routes |
| 5 | `2026-07-15-campaigns-increment-2-shared-table-core.md` | Session persistence, generic shared deck, projections, polling, table shell | Increments 0b, 0.5, 1 | Allowlisted pilot only after gate |
| 6 | `2026-07-15-campaigns-increment-3-challenge.md` | Guided Challenge state machine and typed Challenge modifiers | Increment 2 | Allowlisted pilot |
| 7 | `2026-07-15-campaigns-increment-4-completion.md` | Camp/Crawl/test/oracle procedures, history, corrections, leave cleanup, accessibility | Increment 3 | Release candidate |
| P | `2026-07-15-campaigns-tarot-art-pipeline.md` | Deterministic 78-face/2-back responsive artwork pipeline | Increment 0b card IDs | Parallel; required before Increment 5 |
| 8 | `2026-07-15-campaigns-increment-5-enablement.md` | Capacity proof, staging D1 validation, rollback rehearsal, public enablement | Increment 4 and artwork | Public release |

The plans are executed in table order except the artwork plan, which may run after Increment 0b and must merge before public enablement. Do not parallelize two plans that both alter the database schema or character write path.

This table supersedes specification §16's "Recommended release increments" list, which named a single Increment 0. §16 is advisory about sequencing ("recommended"); its normative content — the scope of each increment and what must be true before public enablement — is unchanged and is enforced by the gates below. Fold the split into §16 at the next spec amendment so the two do not drift.

**Why Increment 0 is split.** The original combined plan required every procedure `ruleEntryId` to resolve against the generated rules output, but no task imported the chapters those IDs live in: `manifest/rules-md.json` covers only Chapter 1, and the pack README records the rest as deferred. The combined plan therefore failed against its own validator. 0a imports the prose through the existing, proven `md-rules.mjs` path; 0b adds the procedure contract and extracts the oracle tables through a new path, because `extractRuleBody` deliberately strips the `Example …` sub-sections the tables live under. The two halves are different machinery with different failure modes and are gated separately: the rules path drops the Meatgrinder and City Events tables outright (they sit under `Example …` headings) and flattens every other table's cross-references into prose, so neither output is usable as structured lookup data.

## Required Architectural Boundaries

```mermaid
flowchart LR
    C["Content compiler"] --> R["Pure session reducer"]
    UI["Svelte table UI"] --> API["Authorized command API"]
    API --> R
    R --> P["Persistence port"]
    P --> S["SQLite transaction"]
    P --> D["D1 batch"]
    S --> J["Snapshots + journal"]
    D --> J
    J --> X["Role projection"]
    X --> UI
```

The dependency direction is enforced by import tests:

```ts
// tests/unit/session/import-boundaries.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('session engine import boundary', () => {
  it('has no UI, SvelteKit, or server imports', () => {
    for (const file of typescriptFiles('src/lib/engine/session')) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/from ['\"](?:\$app\/|@sveltejs\/kit|\$lib\/server|svelte)/);
    }
  });
});
```

## Cross-Increment Contract Freeze

Before Increment 2 starts, freeze these exported contracts and change them only through an explicit spec amendment. **These are the amended, specification-conforming definitions.** The originals drifted from specification §10.2 before any code was written; Increments 2 and 3 must match what appears here, not what their own snippets currently say.

```ts
// src/lib/types/session.ts
export type SessionStatus = 'active' | 'frozen' | 'ended';
export type SessionPhase = 'crawl' | 'challenge' | 'camp' | 'city';

export interface SessionCommandEnvelope<C> {
  commandId: string;
  /** Advisory freshness hint for the UI. NOT a precondition — see §10.2. */
  observedSessionVersion: number;
  /** Required only for structural intents: advance/complete procedure, end round,
   *  end session, apply correction. This is the hard precondition. */
  expectedStructuralVersion?: number;
  /** Present only on resource-spend commands (pre-test Resolve for favor). */
  observedCharacterVersion?: number;
  command: C;
}

export interface SessionProjectionEnvelope<P> {
  campaignCursor: number;
  sessionVersion: number;
  projection: P;
}

export type CommandRejectionCode =
  | 'not-authorized'
  | 'illegal-command'
  | 'stale-structure'
  | 'command-id-reused'
  | 'content-mismatch'
  | 'retry-exhausted';
```

```ts
// src/lib/engine/session/result.ts
export type ReduceResult<S, E, R> =
  | { ok: true; state: S; events: E[] }
  | { ok: false; rejection: R };
```

Route code may translate these domain results to HTTP, but reducer code must not contain HTTP status codes.

### Drift already present in the increment plans

Four contradictions exist today between this freeze, the specification, and the increment plans. The specification wins in every case. Reconcile them before Increment 2 starts:

| Contract | Specification / freeze | What the plan says | Action |
|---|---|---|---|
| Command envelope | `observedSessionVersion` + optional `expectedStructuralVersion` + optional `observedCharacterVersion` (§10.2) | Increment 2 uses a single `observedVersion` and hard-checks it for structural commands | Adopt the three-field envelope above. The single-field form collapses an advisory hint and a precondition into one value and reintroduces the `409` storm the design review's B3 removed. |
| `ReduceResult` | Generic in `<S, E, R>` | Increment 2 declares it non-generic, hardcoding `SessionEngineStateV1` / `SessionEvent[]` / `SessionRejection` | Keep the generic form; let Increment 2 alias it. |
| Sync route | `GET /api/campaigns/[campaignId]/sync?after=<cursor>&version=<version>` (§10.1) | Increment 2 creates `/api/campaigns/[id]/events?since=<cursor>` | Adopt the specification route and parameters. |
| `sessionCommands` columns | Stores both "client-observed version" and "optional structural precondition" (§6.5) | Increment 2 stores only `expectedVersion`/`resultingVersion` | Store both, so a rejected structural command is auditable. |

`content-mismatch` and `stale-structure` are frozen rejection codes that no plan currently emits. Either wire them in Increment 2 or drop them from the freeze; do not leave them as decoration.

### Test discovery is not configured for this work

`vitest.config.ts:7` is `include: ['tests/unit/**/*.test.ts']`. Increments 1, 2, and 3 create roughly a dozen suites under `tests/integration/`, and **no plan modifies that config**. Running a path outside the include glob exits 1 with "No test files found", so every "Expected: PASS" on an integration suite is currently unreachable, and `npm test` in every release gate silently covers no integration test at all. Gate C's D1 failure-injection requirement cannot be met until this is fixed.

Increment 1 owns the fix, as the first plan to introduce the directory: widen the include to `['tests/{unit,integration}/**/*.test.ts']`, and add `vitest.config.ts` to its Task 3 Files list and commit.

`tests/unit/session/import-boundaries.test.ts` — the suite shown above as the enforcement mechanism for the architectural boundary — is likewise created by no task. Increment 2 owns it, alongside the first `src/lib/engine/session/` module.

## Release Gates

### Gate A1 — Rules Prose (Increment 0a)

- [ ] `tests/unit/rules-coverage.test.ts` passes: Chapters 6–9 plus the targeted cross-chapter sections all resolve to committed rule entries.
- [ ] The ten committed Chapter 1 entries are byte-for-byte unchanged; `md-rules.mjs --check` reports `0 drifted`.
- [ ] `CHANGELOG.md`'s Challenge hand-size TODO is closed by a `challenge-gm-hand-size` entry carrying a threat-tier sentinel.
- [ ] Every heading deferred to Increment 0b for being pure tables is named in the completion record.

### Gate A2 — Procedure Contract and Oracle Tables (Increment 0b)

- [ ] `docs/rules/tarot-procedure-audit.md` maps every searched tarot occurrence to `supported-v1`, `deferred-preparation`, or `not-applicable-non-tarot` with a source heading.
- [ ] `npm run content:build` is deterministic and `npm run content:verify` passes from a clean worktree.
- [ ] `tarot-procedures.json` validates, all stable card IDs are unique, and the runtime snapshot is below 2 MB.
- [ ] Every procedure definition carries all ten fields specification §9:446 requires, including `deck`, draw count or formula, lookup table, result visibility, and recovery behavior.
- [ ] Every `ruleEntryId` resolves against Increment 0a's committed `rules.json`.
- [ ] Lookup-range coverage passes: each card-keyed table claims every card of its deck exactly once, with no gaps or overlaps.
- [ ] Every wikilink cross-reference in a table cell resolves to a real content entry.
- [ ] `md-rules.mjs --check` still reports `0 drifted`, proving the new table path did not disturb the rules path.
- [ ] The content-pack version changes whenever generated procedure content changes.

### Gate B — Campaign Foundation

- [ ] SQLite and local D1 both enforce active membership, active tenure, campaign owner, and one active/frozen session constraints.
- [ ] Every character write creates a version claim and stale full-sheet saves return `409` without overwriting the newer sheet.
- [ ] Join links are signed with a dedicated secret, hashed in storage, rotatable, closable, and never stored raw.
- [ ] Voluntary replacement is blocked during active/frozen sessions; death releases the slot; correction never silently restores an ended tenure.
- [ ] Unauthorized campaign lookups return `404`; campaign responses use `Cache-Control: private, no-store`.

### Gate C — Allowlisted Table Pilot

- [ ] Card conservation and zone-legality property tests pass for randomized valid command sequences.
- [ ] GM, other-player, nonmember, SSR, DOM, URL, log, and error canaries cannot observe a player's secret card identity.
- [ ] Duplicate command IDs are idempotent; changed payload reuse is rejected; stale structural commands return `409`.
- [ ] Nine concurrent browser contexts across distinct campaigns see accepted changes within two seconds while their tables are visible.
- [ ] SQLite transaction and D1 batch failure-injection tests leave no partial snapshots, claims, events, secrets, character mutations, or tenure changes.

### Gate D — Release Candidate

- [ ] Challenge, Camp, Crawl, guided test, and in-session oracle procedures named in the specification are implemented or explicitly rejected by the content audit as out of v1 scope.
- [ ] Session ending purges unrevealed private/server state and secret events while preserving sanitized public history.
- [ ] Active-session leave and GM removal execute audited cleanup and release a living character tenure.
- [ ] Keyboard, screen-reader, zoom, reduced-motion, and mobile-table checks pass.
- [ ] The full 78-card artwork mapping has no missing/duplicate faces and every public card route renders uncropped art.

### Gate E — Public Enablement

- [ ] Remote staging D1 schema and contention smoke tests pass.
- [ ] Capacity testing proves the poll/read budget with 30% headroom on the selected Workers Paid deployment.
- [ ] The production shared rate limiter is configured; the in-memory limiter is documented as development defense only.
- [ ] Freeze/recover/end-session and feature-disable rollback drills have recorded results.
- [ ] `ADAPTER=cloudflare npm run build`, `npm run check`, `npm test`, `npm run test:e2e`, and `npm run content:verify` all pass on the release commit.

## Shared Verification Commands

Run from `/Users/oneill/Documents/coding/hmtw-guildbook`:

```bash
npm run content:verify
npm run check
npm test
ADAPTER=cloudflare npm run build
npm run test:e2e
git status --short
```

Expected: every command exits 0; `git status --short` contains only files intentionally changed by the current plan. The locally supplied `assets-src/` tree remains ignored and source tarot PNGs are never staged.

## Rollback Ladder

1. Disable public navigation while leaving allowlisted recovery access on.
2. Set `CAMPAIGNS_ENABLED=false`; campaign and join routes return `404`, while existing character and rules features remain available.
3. If an active session cannot accept commands, freeze it. Do not delete or auto-end it.
4. Recover by replay-validating the latest persisted fragments and journal version; otherwise let the GM end the frozen session with sanitized public history.
5. Database migrations are forward-only. Never roll back by dropping campaign, command, event, secret, or tenure rows.

## Delivery Discipline

Each plan task follows red-green-refactor:

1. Add one focused failing test and run the exact targeted command.
2. Implement the smallest production change that satisfies the test.
3. Re-run the targeted test and nearby suite.
4. Run `npm run check` before committing a type/API boundary.
5. Commit only the task's files with the message specified by that plan.

An increment is not complete until its release gate is checked with fresh command output. Passing an earlier run or assuming an unexecuted command will pass is not evidence.
