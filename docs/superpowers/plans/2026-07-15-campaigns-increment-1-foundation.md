# Campaigns Increment 1: Campaign Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe character concurrency and the complete feature-flagged campaign, Guild Roster, invitation, membership, adventurer tenure, death, replacement, leave, removal, and archival foundation.

**Architecture:** New campaign tables coexist with the unused legacy guild prototype. Server-only services own authorization and mutations. Every multi-row mutation runs through a dual-target atomic adapter: a better-sqlite3 transaction locally and a sequential D1 batch in production. Character writes claim integer versions, while campaign lookup failures are deliberately indistinguishable from authorization failures.

**Tech Stack:** SvelteKit server routes, Drizzle ORM, SQLite, Cloudflare D1, Zod, Node crypto/Web Crypto-compatible primitives, Vitest, Playwright.

## Amendments — read before starting

1. **This plan owns the vitest config fix, and nothing works without it.** `vitest.config.ts:7` is `include: ['tests/unit/**/*.test.ts']`. This plan creates five suites under `tests/integration/` (`campaign-constraints`, `campaign-service`, `campaign-membership`, `campaign-tenure`, `character-death`) and runs them in Tasks 3, 5, 6, and 7. Verified: a path outside the glob exits 1 with "No test files found", so Task 3 Step 2's "Expected: FAIL because the campaign tables are absent" is wrong (it fails on file discovery) and Step 5's "Expected: PASS" is unreachable. As the first plan to introduce the directory, this one fixes it: widen the include to `['tests/{unit,integration}/**/*.test.ts']` and add `vitest.config.ts` to Task 3's Files list and commit.

2. **Task 6 gates on session state this increment does not create.** Lines 18, 21, 523, 550-556, and 564 require "no active/frozen session" checks, and Task 1's `CharacterLife` carries `sessionId`, but `playSessions` is created by Increment 2. Task 6 Step 1's tests ("observer cannot attach during an active/frozen session", "replace only with no active/frozen session", "archive denied with active/frozen session") have no data source. Line 558 defines a session *cleanup* port but never a session *state* port.

   Resolve it by defining an injected session-state port in this increment with a null implementation:

   ```ts
   // src/lib/server/campaigns/session-state-port.ts
   export interface SessionStatePort {
     /** Returns the id of the campaign's active-or-frozen session, or null. */
     activeSessionId(campaignId: string): Promise<string | null>;
   }
   /** Increment 1 ships this; Increment 2 replaces it with a playSessions query. */
   export const noSessionsYet: SessionStatePort = { activeSessionId: async () => null };
   ```

   Task 6's tests then inject a stub returning a session ID, so the rule is proven here and the real query lands in Increment 2 without touching this logic. Do not pull `playSessions` forward into this increment's migration — that would split the session schema across two plans.

3. **Use the specification's event table name.** Task 3 (line 301) creates `campaignAuditEvents`, but specification §6.5 normatively names `campaignEvents`, and §6 states that table names are "normative at the domain level". Increment 2 creates `campaignEvents` + `campaignEventSecrets`, which would leave this increment's creation and lifecycle writes stranded in a superseded table. Name it `campaignEvents` here and let Increment 2 add `campaignEventSecrets` alongside it.

4. **Task 2's discovery grep misses two unguarded character writers.** The Files-list grep `rg "api/characters|expectedUpdatedAt" src` does not match `src/lib/server/character/share.ts`, which calls `.update(characters)` at `:42` and `:69`. Step 5's verification grep `rg "update\(characters\)|insert\(characters\)" src` does match it, so Step 5 fails against a file the plan never told you to touch. Add `share.ts` to Task 2's Files list.

5. **`updateCharacterSchema` does not exist.** Task 2 Step 4 says to "change the update schema to `updateCharacterSchema`", but `character.schema.ts` exports only `characterDataSchema:59` and `createCharacterSchema:89`; the PUT route uses `createCharacterSchema` (`api/characters/[id]/+server.ts:46`) and reads `expectedUpdatedAt` ad-hoc at `:52-54`. This is a create-and-rewire, not an edit.

6. **Task 4 specifies two different access APIs.** Step 1's test calls `loadCampaignAccess(ctx, 'campaign-a', 'owner')` returning `{ role: 'gm' }`; Step 3 specifies `requireCampaignAccess(event, campaignId)` returning a `CampaignRole` of `{ kind: 'gm' }`. Different name, arity, and discriminant. Pick one before writing the test.

7. **Migrations are auto-named.** Tasks 1 and 3 name `0001_campaign_character_versions.sql` and `0002_campaign_foundation.sql`, but `npm run db:generate` generates its own suffix (cf. the committed `0000_dashing_surge.sql`) and writes the tag into `_journal.json`. Use `npx drizzle-kit generate --name campaign_character_versions` rather than renaming files by hand in two places.

8. **Task 1 Step 2 runs a test file it has not created yet**, so vitest exits 1 with "No test files found" instead of showing a red test. Step 1 also never says which file each snippet belongs in. Create `tests/unit/character-life.test.ts` in Step 1.

9. **Task 7's E2E env conflicts with the Playwright webserver.** `NODE_ENV=development` is required for the Credentials provider (`auth.ts:35,65`), but `playwright.config.ts:5` boots via `npm run build && npm run preview`, so that env would also apply to `vite build`. Reconcile before Task 7 — likely a dedicated test-only auth path rather than an env flag.

## Global Constraints

- Do not repurpose or delete `guilds`, `guildMembers`, or `guildDraws`.
- The campaign owner is the only GM, cannot join as a member, and cannot attach an adventurer.
- Membership may exist without an adventurer.
- A user has at most one active membership per campaign; a membership has at most one active tenure; a character has at most one active tenure globally.
- Eligible adventurers are owned, finalized, alive, unarchived, and unattached.
- Voluntary replacement is permitted only with no active/frozen session. Death may release the slot during play; Increment 2 enforces the legal table boundary for the replacement's participation.
- Player owner or scoped campaign GM may mark dead. Death correction makes the character alive but does not restore a tenure.
- A player may leave during an active session. The service records audited cleanup, ends a living tenure, and revokes access. No session auto-expiry exists.
- Campaign archive is allowed only with no active/frozen session.
- Campaign-disabled and unauthorized resource responses are `404` with `Cache-Control: private, no-store`.

---

### Task 1: Add integer character versions and life state

**Files:**
- Modify: `src/lib/types/character.ts`
- Modify: `src/lib/schemas/character.schema.ts`
- Modify: `src/lib/engine/character-migration.ts`
- Modify: `src/lib/server/db/schema.ts`
- Create: `src/lib/server/db/migrations/0001_campaign_character_versions.sql`
- Modify: `src/lib/server/db/migrations/meta/_journal.json`
- Create: generated Drizzle snapshot under `src/lib/server/db/migrations/meta/`
- Test: `tests/unit/character-migration.test.ts`
- Test: `tests/unit/character-life.test.ts`

- [ ] **Step 1: Write failing v2-to-v3 life migration tests**

Add:

```ts
it('migrates a v2 adventurer to an alive v3 life record', () => {
  const raw = { ...createBlankCharacter(), schemaVersion: 2 } as Record<string, unknown>;
  delete raw.life;
  const migrated = migrateCharacterData(raw);
  expect(migrated.schemaVersion).toBe(3);
  expect(migrated.life).toEqual({ status: 'alive' });
});

it('preserves a valid dead life record', () => {
  const life = {
    status: 'dead' as const,
    diedAt: '2026-07-15T12:00:00.000Z',
    campaignId: 'campaign-a',
    sessionId: 'session-a',
    markedByUserId: 'user-a'
  };
  expect(migrateCharacterData({ ...createBlankCharacter(), schemaVersion: 3, life }).life).toEqual(life);
});
```

- [ ] **Step 2: Run the migration suite to verify it fails**

Run: `npm test -- tests/unit/character-migration.test.ts tests/unit/character-life.test.ts`

Expected: FAIL because `life` and schema version 3 do not exist.

- [ ] **Step 3: Add the canonical life union**

```ts
export type CharacterLife =
  | { status: 'alive' }
  | {
      status: 'dead';
      diedAt: string;
      campaignId?: string;
      sessionId?: string;
      markedByUserId: string;
    };

export const CHARACTER_SCHEMA_VERSION = 3;
```

Add `life: { status: 'alive' }` to `createBlankCharacter`, a discriminated Zod union to `characterDataSchema`, and an explicit normalizer that accepts only a complete dead record; malformed legacy values normalize to alive and produce no partial death metadata.

- [ ] **Step 4: Add the database columns and claim table**

Add `characters.version INTEGER NOT NULL DEFAULT 1` and `characters.lifeStatus TEXT NOT NULL DEFAULT 'alive'`, plus:

```ts
export const characterVersionClaims = sqliteTable(
  'character_version_claims',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    characterId: text('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
    resultingVersion: integer('resulting_version').notNull(),
    mutationKind: text('mutation_kind').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
  },
  (table) => [
    uniqueIndex('character_version_claims_character_version_uq').on(
      table.characterId,
      table.resultingVersion
    )
  ]
);
```

Generate the migration with `npm run db:generate`, inspect it, then append a backfill insert for version 1 claims for all existing characters. Add a `CHECK (life_status IN ('alive','dead'))` in the generated SQL if Drizzle does not emit it.

- [ ] **Step 5: Verify migration shape locally**

Run: `DATABASE_URL=/tmp/guild-book-campaign-v1.db npm run db:push`

Expected: exits 0 with `characters.version`, `characters.life_status`, and `character_version_claims` present.

Run: `npm run db:migrate:d1:local`

Expected: migration applies to the local D1 database.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- tests/unit/character-migration.test.ts tests/unit/character-life.test.ts`

Expected: PASS.

```bash
git add src/lib/types/character.ts src/lib/schemas/character.schema.ts src/lib/engine/character-migration.ts src/lib/server/db/schema.ts src/lib/server/db/migrations tests/unit/character-migration.test.ts tests/unit/character-life.test.ts
git commit -m "feat(characters): add life state and version claims"
```

### Task 2: Migrate every character writer to version claims

**Files:**
- Create: `src/lib/server/character/versioned-write.ts`
- Modify: `src/routes/api/characters/+server.ts`
- Modify: `src/routes/api/characters/[id]/+server.ts`
- Modify: `src/lib/schemas/character.schema.ts`
- Modify: character save callers found by `rg "api/characters|expectedUpdatedAt" src`
- Test: `tests/unit/character-versioned-write.test.ts`
- Test: `tests/unit/character-api-concurrency.test.ts`

- [ ] **Step 1: Add a failing stale-write service test**

The test creates version 1, accepts one expected-version-1 update, rejects a second, and verifies the winner's JSON remains intact:

```ts
const first = await saveWholeCharacter(db, {
  characterId,
  ownerUserId,
  actorUserId: ownerUserId,
  expectedVersion: 1,
  data: { ...base, notes: 'winner' }
});
expect(first).toEqual({ ok: true, version: 2 });

const stale = await saveWholeCharacter(db, {
  characterId,
  ownerUserId,
  actorUserId: ownerUserId,
  expectedVersion: 1,
  data: { ...base, notes: 'loser' }
});
expect(stale).toEqual({ ok: false, reason: 'version-conflict', currentVersion: 2 });
expect(await readNotes(db, characterId)).toBe('winner');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/character-versioned-write.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement one guarded whole-document writer**

The public contract is:

```ts
export type CharacterWriteResult =
  | { ok: true; version: number; updatedAt: Date }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'version-conflict'; currentVersion: number };

export interface WholeCharacterWrite {
  characterId: string;
  ownerUserId: string;
  actorUserId: string;
  expectedVersion: number;
  data: GuildBookCharacterData;
}
```

The atomic mutation inserts the `(characterId, expectedVersion + 1)` claim before updating the row. Local SQLite uses a transaction. D1 executes the claim insert and `UPDATE ... WHERE id = ? AND user_id = ? AND version = ?` in one batch. After the batch, read the row and require `version === expectedVersion + 1`; treat any constraint/batch failure as conflict after reread.

Do not expose a helper that updates the JSON without a claim.

- [ ] **Step 4: Require `expectedVersion` at the API boundary**

Change the update schema to:

```ts
export const updateCharacterSchema = z
  .object({
    character: characterDataSchema,
    expectedVersion: z.number().int().positive().optional(),
    expectedUpdatedAt: z.number().int().nonnegative().optional()
  })
  .superRefine((value, context) => {
    if (value.expectedVersion === undefined && value.expectedUpdatedAt === undefined) {
      context.addIssue({ code: 'custom', message: 'Expected character version is required' });
    }
  });
```

For one compatibility release only, callers that send `expectedUpdatedAt` and no `expectedVersion` receive a server lookup that translates an exact timestamp match into the current version; mismatch returns `409`. Requests with neither return `400`. Every first-party caller must send `expectedVersion`, so compatibility is exercised only by a dedicated test.

Successful responses return `{ success: true, version, updatedAt }`; conflicts return `{ message, currentVersion }` with `409`.

- [ ] **Step 5: Verify every writer is guarded**

Run: `rg -n "update\(characters\)|insert\(characters\)" src`

Expected: creation inserts version 1 and its claim; all post-creation updates flow through named guarded helpers. Archive writes also claim a version.

- [ ] **Step 6: Run concurrency checks and commit**

Run:

```bash
npm test -- tests/unit/character-versioned-write.test.ts tests/unit/character-api-concurrency.test.ts
npm run check
npm test
```

Expected: every command exits 0.

```bash
git add src/lib/server/character/versioned-write.ts src/routes/api/characters src/lib/schemas/character.schema.ts src tests/unit/character-versioned-write.test.ts tests/unit/character-api-concurrency.test.ts
git commit -m "refactor(characters): require integer version claims"
```

Before committing, replace the broad `git add src` with the exact caller file list reported by `git status --short`; never stage unrelated work.

### Task 3: Add campaign, roster, membership, tenure, and audit tables

**Files:**
- Modify: `src/lib/server/db/schema.ts`
- Create: `src/lib/server/db/migrations/0002_campaign_foundation.sql`
- Modify: `src/lib/server/db/migrations/meta/_journal.json`
- Create: generated Drizzle snapshot under `src/lib/server/db/migrations/meta/`
- Create: `tests/unit/campaign-schema.test.ts`
- Create: `tests/integration/campaign-constraints.test.ts`

- [ ] **Step 1: Write failing constraint tests**

Against a migrated temporary SQLite database, assert:

```ts
await expect(insertActiveMembership(db, campaignId, userId)).resolves.toBeDefined();
await expect(insertActiveMembership(db, campaignId, userId)).rejects.toThrow(/unique/i);
await expect(insertActiveTenure(db, membershipId, characterId)).resolves.toBeDefined();
await expect(insertActiveTenure(db, otherMembershipId, characterId)).rejects.toThrow(/unique/i);
await expect(insertActiveTenure(db, membershipId, otherCharacterId)).rejects.toThrow(/unique/i);
```

Also assert an owner cannot be inserted as a member using an application-service validation test; SQLite cannot express that cross-table rule as a simple check.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/campaign-constraints.test.ts`

Expected: FAIL because the campaign tables are absent.

- [ ] **Step 3: Add the normalized schema**

Create these new tables with foreign keys, UTC timestamps, indexes on every lookup FK, and the exact partial uniques:

```ts
uniqueIndex('campaign_members_active_user_uq')
  .on(table.campaignId, table.userId)
  .where(sql`left_at IS NULL`);

uniqueIndex('campaign_tenures_active_membership_uq')
  .on(table.membershipId)
  .where(sql`ended_at IS NULL`);

uniqueIndex('campaign_tenures_active_character_uq')
  .on(table.characterId)
  .where(sql`ended_at IS NULL`);
```

Tables and required columns:

- `campaigns`: specification section 6.1 fields, plus `inviteTokenPrefix` for indexed candidate lookup and `version` for metadata edits.
- `guildRosters`: `campaignId` primary/foreign key, `schemaVersion`, `documentJson`, `version`, timestamps.
- `campaignMembers`: section 6.2 fields.
- `campaignAdventurerTenures`: section 6.3 fields and a check over the five end reasons.
- `campaignAuditEvents`: autoincrement cursor, campaign, optional membership/tenure/character, actor, kind, sanitized JSON payload, timestamp.

Raw invite token and player-hidden card data do not belong in any of these tables.

- [ ] **Step 4: Generate, inspect, and apply the migration**

Run:

```bash
npm run db:generate
npm run db:migrate:d1:local
```

Expected: migration applies once; a second local D1 migration command reports no pending migration.

- [ ] **Step 5: Run constraint tests on SQLite and local D1**

Run: `npm test -- tests/integration/campaign-constraints.test.ts`

Expected: PASS on SQLite.

Add `scripts/test-d1-constraints.mjs` only if Vitest cannot access the local Miniflare D1 binding. The script must execute the same three duplicate inserts with `wrangler d1 execute --local --command` and assert nonzero constraint failures.

- [ ] **Step 6: Commit the schema**

```bash
git add src/lib/server/db/schema.ts src/lib/server/db/migrations tests/unit/campaign-schema.test.ts tests/integration/campaign-constraints.test.ts scripts/test-d1-constraints.mjs
git commit -m "feat(campaigns): add campaign foundation schema"
```

Omit `scripts/test-d1-constraints.mjs` from the command if the Vitest D1 path is sufficient and the file was not created.

### Task 4: Add the server feature gate, cache policy, and access service

**Files:**
- Create: `src/lib/server/campaign/config.ts`
- Create: `src/lib/server/campaign/access.ts`
- Modify: `src/lib/server/auth.ts`
- Modify: `src/app.d.ts`
- Modify: `.env.example`
- Test: `tests/unit/campaign-access.test.ts`

- [ ] **Step 1: Write failing gate and role tests**

Cover disabled, owner, active member, former member, and unrelated user:

```ts
expect(await loadCampaignAccess(ctx, 'campaign-a', 'owner')).toMatchObject({ role: 'gm' });
expect(await loadCampaignAccess(ctx, 'campaign-a', 'member')).toMatchObject({ role: 'player' });
await expect(loadCampaignAccess(ctx, 'campaign-a', 'former')).rejects.toMatchObject({ status: 404 });
await expect(loadCampaignAccess(disabledCtx, 'campaign-a', 'owner')).rejects.toMatchObject({ status: 404 });
```

- [ ] **Step 2: Implement server-only flags**

```ts
export interface CampaignFeatureConfig {
  enabled: boolean;
  pilotUserIds: ReadonlySet<string>;
}

export function canAccessCampaignFeature(config: CampaignFeatureConfig, userId: string): boolean {
  return config.enabled || config.pilotUserIds.has(userId);
}
```

Read `CAMPAIGNS_ENABLED` and comma-separated `CAMPAIGNS_PILOT_USER_IDS` through the same platform/process environment pattern as auth. Add them to `App.Platform.env`. Do not expose either value to client data.

- [ ] **Step 3: Implement 404 authorization and response hardening**

`requireCampaignAccess(event, campaignId)` calls `ensureUser`, enforces the feature gate, loads only active membership or owner, and throws `error(404, 'Campaign not found')` for every denial. Export:

```ts
export type CampaignRole =
  | { kind: 'gm'; userId: string; campaignId: string }
  | { kind: 'player'; userId: string; campaignId: string; membershipId: string };

export function campaignHeaders(): HeadersInit {
  return { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
}
```

Every campaign `json` response and SSR load installs these headers. Never log the requested campaign ID on a denied lookup.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/unit/campaign-access.test.ts`

Expected: PASS.

```bash
git add src/lib/server/campaign/config.ts src/lib/server/campaign/access.ts src/lib/server/auth.ts src/app.d.ts .env.example tests/unit/campaign-access.test.ts
git commit -m "feat(campaigns): guard campaign access behind server flags"
```

### Task 5: Implement campaign creation, roster edits, and signed invitations

**Files:**
- Create: `src/lib/types/campaign.ts`
- Create: `src/lib/schemas/campaign.schema.ts`
- Create: `src/lib/server/campaign/invites.ts`
- Create: `src/lib/server/campaign/service.ts`
- Create: `src/routes/api/campaigns/+server.ts`
- Create: `src/routes/api/campaigns/[id]/+server.ts`
- Create: `src/routes/api/campaigns/[id]/roster/+server.ts`
- Create: `src/routes/api/campaigns/[id]/invite/+server.ts`
- Test: `tests/unit/campaign-invites.test.ts`
- Test: `tests/integration/campaign-service.test.ts`

- [ ] **Step 1: Write failing invite security tests**

Test deterministic verification with injected secret/clock while requiring nondeterministic nonce generation in production:

```ts
const token = await issueInviteToken({
  campaignId: 'campaign-a',
  version: 2,
  nonce: '0123456789abcdef0123456789abcdef',
  secret: 'dedicated-test-secret'
});
expect(token).not.toContain('dedicated-test-secret');
expect(await verifyInviteToken(token, 'dedicated-test-secret')).toEqual({
  campaignId: 'campaign-a',
  version: 2,
  nonce: '0123456789abcdef0123456789abcdef'
});
expect(await verifyInviteToken(`${token}x`, 'dedicated-test-secret')).toBeNull();
```

Test that persisted campaign data contains only prefix, SHA-256 hash, nonce, and version—not the raw token.

- [ ] **Step 2: Implement the token format**

Use versioned base64url payload plus HMAC-SHA-256 signature:

```ts
interface InviteClaims {
  tokenVersion: 1;
  campaignId: string;
  inviteVersion: number;
  nonce: string;
}
```

Sign with dedicated `CAMPAIGN_INVITE_SECRET`; do not reuse `AUTH_SECRET`. Compare MACs in constant time. Store `inviteTokenPrefix = sha256(token).slice(0, 16)` for candidate lookup and full `inviteTokenHash = sha256(token)` for verification. `GET` for the owner reproduces the current link from stored nonce/version; raw tokens never enter the database or logs.

- [ ] **Step 3: Implement validated campaign/roster commands**

Schemas enforce bounded strings and a versioned roster document:

```ts
export interface GuildRosterDocumentV1 {
  schemaVersion: 1;
  guildName: string;
  sigilDescription: string;
  terms: string[];
  marchingOrder: string[];
  roles: Array<{ id: string; title: string; membershipId: string | null }>;
  contracts: Array<{ id: string; title: string; status: 'open' | 'complete' }>;
  deeds: Array<{ id: string; text: string; occurredAt: string }>;
  fame: number;
}
```

Creation inserts campaign, empty roster, first audit event, and invite metadata atomically. Owner commands support metadata update, roster update with `expectedVersion`, invite open/close, and invite rotate. Rotation increments `inviteVersion`, replaces the nonce/hash/prefix, and invalidates the old link immediately.

- [ ] **Step 4: Map HTTP responses**

- `POST /api/campaigns`: `201` with owner projection.
- `GET /api/campaigns`: current owned/active-member campaigns only.
- `GET/PATCH /api/campaigns/[id]`: role-projected read; owner-only edit.
- `PUT /api/campaigns/[id]/roster`: owner-only guarded edit.
- `GET/POST/DELETE /api/campaigns/[id]/invite`: reproduce/rotate/close; owner only.
- Validation `400`, version conflict `409`, all auth/resource denials `404`.

- [ ] **Step 5: Run service/API tests and commit**

Run:

```bash
npm test -- tests/unit/campaign-invites.test.ts tests/integration/campaign-service.test.ts
npm run check
```

Expected: PASS.

```bash
git add src/lib/types/campaign.ts src/lib/schemas/campaign.schema.ts src/lib/server/campaign/invites.ts src/lib/server/campaign/service.ts src/routes/api/campaigns tests/unit/campaign-invites.test.ts tests/integration/campaign-service.test.ts
git commit -m "feat(campaigns): create campaigns rosters and invites"
```

### Task 6: Implement joining, attachment, replacement, death, correction, leave, and removal

**Files:**
- Create: `src/lib/server/campaign/membership.ts`
- Create: `src/lib/server/campaign/tenure.ts`
- Create: `src/lib/server/character/life.ts`
- Create: `src/routes/api/campaigns/join/[token]/+server.ts`
- Create: `src/routes/api/campaigns/[id]/membership/+server.ts`
- Create: `src/routes/api/campaigns/[id]/adventurer/+server.ts`
- Create: `src/routes/api/campaigns/[id]/members/[membershipId]/+server.ts`
- Create: `src/routes/api/characters/[id]/life/+server.ts`
- Test: `tests/integration/campaign-membership.test.ts`
- Test: `tests/integration/campaign-tenure.test.ts`
- Test: `tests/integration/character-death.test.ts`

- [ ] **Step 1: Write the failing eligibility matrix**

Use one test row for each rejection:

```ts
it.each([
  ['not-owner', { owner: false, finalized: true, alive: true, archived: false, activeTenure: false }],
  ['draft', { owner: true, finalized: false, alive: true, archived: false, activeTenure: false }],
  ['dead', { owner: true, finalized: true, alive: false, archived: false, activeTenure: false }],
  ['archived', { owner: true, finalized: true, alive: true, archived: true, activeTenure: false }],
  ['already-attached', { owner: true, finalized: true, alive: true, archived: false, activeTenure: true }]
])('rejects %s adventurers', async (reason, fixture) => {
  await expect(attachFixture(fixture)).resolves.toMatchObject({ ok: false, reason });
});
```

Add state-machine tests for: join with none; attach now/later when no session is active; newly joined observer cannot make an initial attachment during an active/frozen session; replace only with no active/frozen session; death creates the sole active-session replacement exception; owner death; scoped GM death; unrelated GM denial; death releases tenure; correction leaves tenure ended; active-session leave releases tenure and access; GM removal has the same cleanup; archive denied with active/frozen session.

- [ ] **Step 2: Implement eligibility as one query plus pure predicate**

```ts
export interface AdventurerEligibilityFacts {
  ownedByActor: boolean;
  finalized: boolean;
  lifeStatus: 'alive' | 'dead';
  archived: boolean;
  hasActiveTenure: boolean;
}

export type EligibilityFailure =
  | 'not-owner'
  | 'draft'
  | 'dead'
  | 'archived'
  | 'already-attached';
```

The service reads canonical migrated character JSON for final validation and uses denormalized columns only for indexed filtering. A successful attach inserts a tenure and audit event atomically.

- [ ] **Step 3: Implement lifecycle mutations atomically**

Required commands and end reasons:

- Attach: insert active tenure only when no active/frozen session, unless the membership's just-ended tenure has `endReason='died'` in the current session.
- Voluntary replace: ensure no active/frozen session, end old tenure as `replaced`, insert new tenure.
- Mark dead: claim character version; narrowly set JSON `life`, `lifeStatus='dead'`; end tenure as `died`; set `deathSessionId`; audit.
- Correct death: claim character version; narrowly set JSON life alive and denormalized status; add audit; do not insert tenure.
- Leave: set membership `leftAt`; end tenure as `left`; emit a sanitized cleanup audit event used by Increment 2 to remove private zones.
- Remove: set `removedAt`, `removedByUserId`; end tenure as `removed`; same cleanup contract.
- Archive: require no active/frozen session, set `archivedAt` and audit.

For a session-present death or leave before Increment 2 exists, the service must accept an injected session cleanup port and refuse to mutate if that port is unavailable; do not land a temporary partial-cleanup path.

- [ ] **Step 4: Validate join tokens without leaking campaign existence**

`POST /api/campaigns/join/[token]` requires sign-in, verifies signature/hash/version/open/archived state, rejects the owner, returns the existing active membership idempotently, or creates a new membership. Invalid, rotated, closed, or unauthorized links all return `404`.

The request may include `characterId`; joining succeeds even if attachment fails only when the client explicitly submits join-without-character. A combined join-and-attach command is atomic when a character ID is provided and no session is active/frozen. During an active/frozen session a new member always joins as an observer with no initial attachment.

- [ ] **Step 5: Run lifecycle and concurrency tests**

Run:

```bash
npm test -- tests/integration/campaign-membership.test.ts tests/integration/campaign-tenure.test.ts tests/integration/character-death.test.ts
npm run check
```

Expected: PASS, including simultaneous attachment of one character to two campaigns where exactly one succeeds.

- [ ] **Step 6: Commit lifecycle services**

```bash
git add src/lib/server/campaign/membership.ts src/lib/server/campaign/tenure.ts src/lib/server/character/life.ts src/routes/api/campaigns src/routes/api/characters/[id]/life tests/integration/campaign-membership.test.ts tests/integration/campaign-tenure.test.ts tests/integration/character-death.test.ts
git commit -m "feat(campaigns): manage membership adventurers and death"
```

### Task 7: Add feature-flagged campaign and join pages

**Files:**
- Create: `src/routes/campaigns/+page.server.ts`
- Create: `src/routes/campaigns/+page.svelte`
- Create: `src/routes/campaigns/new/+page.server.ts`
- Create: `src/routes/campaigns/new/+page.svelte`
- Create: `src/routes/campaigns/[id]/+page.server.ts`
- Create: `src/routes/campaigns/[id]/+page.svelte`
- Create: `src/routes/join/[token]/+page.server.ts`
- Create: `src/routes/join/[token]/+page.svelte`
- Create: `src/lib/components/campaign/CampaignRoster.svelte`
- Create: `src/lib/components/campaign/AdventurerPicker.svelte`
- Modify: `src/routes/+layout.server.ts`
- Modify: `src/routes/+layout.svelte`
- Modify: `playwright.config.ts`
- Create: `tests/e2e/fixtures/auth.ts`
- Test: `tests/e2e/campaign-foundation.spec.ts`

- [ ] **Step 1: Write the failing multi-user foundation flow**

Use two Playwright browser contexts with dev credentials and separate storage:

```ts
test('GM creates a campaign and a player joins then attaches one adventurer', async ({ browser }) => {
  const gm = await browser.newContext();
  const player = await browser.newContext();
  const gmPage = await gm.newPage();
  const playerPage = await player.newPage();
  await signInAs(gmPage, 'gm@example.test');
  await signInAs(playerPage, 'player@example.test');
  const invite = await createCampaignAndCopyInvite(gmPage, 'Undercrypt');
  await playerPage.goto(invite);
  await playerPage.getByRole('button', { name: 'Join campaign' }).click();
  await expect(playerPage.getByText('Joined without an adventurer')).toBeVisible();
  await playerPage.getByRole('button', { name: 'Attach adventurer' }).click();
  await expect(playerPage.getByText('1 active adventurer')).toBeVisible();
});
```

Add tests for closed/rotated invites, GM no-player controls, dead/archived/draft filtering, voluntary replacement, and campaign responses containing `private, no-store`.

Configure the Playwright web server with a dedicated temporary SQLite database, `NODE_ENV=development`, and `AUTH_DEV_LOGIN=true`. Add a pre-server setup script that applies migrations to that database. The auth fixture signs in through the credentials provider and generates unique email addresses per test; it does not use the ignored `dev-auto-login.ts` bypass or production OAuth credentials.

- [ ] **Step 2: Run the E2E file to verify it fails**

Run: `npx playwright test tests/e2e/campaign-foundation.spec.ts`

Expected: FAIL because campaign pages do not exist.

- [ ] **Step 3: Implement accessible Svelte 5 pages**

All pages use `$props()` and runes. The campaign detail shows metadata, invite controls for GM, roster document, current/historical tenures, and the player's eligible adventurer picker. Do not create table controls yet; link to the table only when Increment 2 supplies an active session.

The global layout receives a server-computed `showCampaignsNav` boolean. It renders Campaigns only for enabled/pilot signed-in users; client code cannot override the flag.

The join page presents campaign name and a confirmation button after sign-in. It never auto-joins on GET, preventing link-preview bots from creating memberships.

- [ ] **Step 4: Run the full foundation gate**

Run:

```bash
npm run db:migrate:d1:local
npm test -- tests/unit/campaign-access.test.ts tests/unit/campaign-invites.test.ts tests/integration/campaign-constraints.test.ts tests/integration/campaign-service.test.ts tests/integration/campaign-membership.test.ts tests/integration/campaign-tenure.test.ts tests/integration/character-death.test.ts
npm run check
npm test
npx playwright test tests/e2e/campaign-foundation.spec.ts
ADAPTER=cloudflare npm run build
```

Expected: every command exits 0.

- [ ] **Step 5: Commit Increment 1**

```bash
git add src/routes/campaigns src/routes/join src/lib/components/campaign src/routes/+layout.server.ts src/routes/+layout.svelte playwright.config.ts tests/e2e/fixtures/auth.ts tests/e2e/campaign-foundation.spec.ts
git commit -m "feat(campaigns): add campaign foundation interface"
```

## Increment 1 Completion Record

Recorded 2026-07-18, after the seven implementation commits (9a7c340 through
a92b528) plus the E2E-harness correction commit that followed.

- **Type check:** `npm run check` — 0 errors, 0 warnings.
- **Unit + integration:** `npm test` — 375 passed, 0 skipped, 38 files.
  `vitest.config.ts` now includes `tests/integration/**`; the previously
  flagged silent-exclusion risk is closed.
- **SQLite/local-D1 constraint results:**
  `tests/integration/campaign-constraints.test.ts` (SQLite),
  `tests/integration/campaign-lifecycle-d1.test.ts` and
  `campaign-service-d1.test.ts` (miniflare D1) all pass, covering unique
  active-membership/tenure claims, invite hash uniqueness, and
  session-boundary races on both engines.
- **Character writer inventory:** every writer migrated to required integer
  `expectedVersion` claims — see `tests/unit/character-versioned-write.test.ts`
  and `tests/unit/character-api-concurrency.test.ts` (stale-claim rejection,
  concurrent-write loser gets 409).
- **Invite rotation:** `tests/unit/campaign-invites.test.ts` plus the
  "closed and rotated invitations invalidate the exposed link" E2E (old link
  404s after close and after rotate).
- **Lifecycle matrix:** `tests/integration/campaign-membership.test.ts`,
  `campaign-tenure.test.ts`, `character-death.test.ts`, and
  `tests/unit/campaign-lifecycle-api.test.ts` cover join, attach, replace,
  death, correction, leave, removal, and archive across roles.
- **E2E artifacts:** full Playwright suite 27/27 passing twice consecutively
  against a production build served by `npm run preview`
  (7 campaign-foundation, 8 test-of-fate, plus denizens/wizard/deck suites).
- **Post-implementation corrections required to reach green** (found because
  the E2E gate had not actually been run before the final commit):
  1. The final implementation commit switched the Playwright web server from
     `npm run build && npm run preview` to `npm run dev`, which made every
     click race hydration — all 15 then-existing E2E tests failed. The
     build+preview server is restored; the dev-login provider works there
     because its `NODE_ENV` gate is read at runtime, not build time.
  2. `installCampaignHeaders` deduplicated `setHeaders` per *event*, but a
     form action and the load it triggers share one HTTP response with
     distinct events, so every campaign form action crashed with
     `"Cache-Control" header is already set`. The dedupe now keys on
     `event.locals` (shared per request). Mutation-tested: reverting the fix
     fails the "GM creates a campaign" E2E.
  3. The auth fixture's `waitForURL('**/characters')` glob already matched
     `/login?callbackUrl=/characters`, masking failed sign-ins; it now matches
     on the pathname alone. Test locators for the adventurer picker needed
     `{ exact: true }` because the surrounding region's accessible name
     ("Choose your adventurer") also substring-matches "Adventurer".

`CAMPAIGNS_ENABLED` remains `false`; this increment is not a playable campaign
table.
