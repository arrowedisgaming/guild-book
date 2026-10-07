# Player-character XP and Spell Components Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task after implementation is authorized. Steps use checkbox syntax for tracking. No implementation is authorized by the planning request alone.

**Goal:** Let players count and explain XP, spend it consistently on talents, and record reusable custom spell components as carried gear.

**Architecture:** Extend the existing character JSON and pure engines, then expose the changes through the owner sheet and common view/export pipeline. Reuse integer-version whole-character saves for atomic balance/history/talent updates. Deliver XP and components as separate increments.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, TypeScript, Zod, Vitest, Playwright, existing SQLite/D1 persistence and pdfmake exporters. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-09-character-xp-and-spell-components-design.md` — includes the reviewed rule sources, UI decisions, migration semantics, and acceptance examples. Implementation is complete; see `docs/superpowers/2026-09-09-character-xp-components-completion.md` for final decisions and verification. The checklist below preserves the original proposed steps.

## Global constraints

- Engine functions must be pure — no side effects, no imports from `$app/` or `$lib/server/`.
- All game data changes go in content-pack JSON, not application code.
- Use Svelte 5 runes and the existing theme role tokens.
- XP opening balance is not lifetime earned; never invent pre-migration history.
- Spell components are reusable equipment; never consume them when casting.
- Preserve owner authorization, integer-version conflicts, and atomic SQLite/D1 writes.
- Public projection excludes XP ledger history by default.
- Do not commit the gitignored source vault or change denizens.
- `main` is pull-request-only. Publishing is a separate authorized step under AGENTS.md; no direct main push or deployment is part of this plan.

## Increment A: XP balance, sources, and spending

### Task 1: Content-backed advancement configuration

**Modify:** `static/content-packs/hmtw/index.json`, `src/lib/types/content-pack.ts`, `src/lib/schemas/content-pack.schema.ts`, `tests/unit/content-pack.test.ts`.

**Produces:** `GuildBookContentPack.advancement: AdvancementConfig`.

```ts
interface AdvancementConfig {
  masteryXp: number;
  pathUseXp: number;
  cityTrainingGoldPerXp: number;
  awards: {
    id: string;
    label: string;
    amount: number | null; // null means a positive amount entered by the player
    ruleEntryId: string;
    reminder: string;
  }[];
}
```

- [ ] Add schema tests rejecting zero/fractional mastery thresholds and duplicate award IDs. Add referential tests for `ruleEntryId` against shipped rules.
- [ ] Run `npm test -- tests/unit/content-pack.test.ts`; confirm the new expectations fail before adding configuration.
- [ ] Add mastery 7, own-path use 1, and City training cost 50. Add award IDs `quest-accepted` (3), `quest-completed` (3), `contract-completed` (1), `carouse-half` (1), `carouse-all` (2), `join-current-quest` (3), `funeral` (variable), and `other` (variable). Map sources to the spec's stable rules IDs. Label `other` as a table award, not a rule entitlement.
- [ ] Add reminders for quest agreement/one active quest, alternative carousing options and hangover draw, funeral expenses, and the specific second-session joining rule. These are guidance, not checks against campaign state.
- [ ] Verify pack-version requirements using `scripts/content-import/verify-pack-version.mjs`; update the pack version according to that script's actual contract. Run the focused tests and `npm run content:verify:ci`.

### Task 2: XP data model and safe legacy migration

**Modify:** `src/lib/types/character.ts`, `src/lib/schemas/character.schema.ts`, `src/lib/engine/character-migration.ts`, `src/lib/stores/wizard.ts` only if needed for migration plumbing.

**Tests:** `tests/unit/character-migration.test.ts`, `tests/unit/character-validation.test.ts`, `tests/unit/stores/wizard.test.ts`.

**Produces:** `XpEntry`, `XpLedger`, `GuildBookCharacterData.xpLedger`, and `TalentAllocation.preparedUses`.

```ts
interface XpEntry {
  id: string;
  at: string;
  delta: number;
  kind: 'award' | 'talent-use' | 'mentoring' | 'spend' | 'correction';
  sourceId: string;
  sourceLabel: string;
  reason: string;
  sessionLabel?: string;
  talentId?: string;
  talentBefore?: { xp: number; state: 'mastered' | 'in-training'; preparedUses: number | null };
  talentAfter?: { xp: number; state: 'mastered' | 'in-training'; preparedUses: number | null };
}
interface XpLedger { openingBalance: number; entries: XpEntry[] }
// TalentAllocation gains preparedUses: number | null.
```

- [ ] Add a migration regression using a version-3 blank-character fixture whose experience is 5 and first talent investment is 4. Assert balance 5, opening balance 5, empty history, talent investment 4, and `migrate(migrate(old)) === migrate(old)`.
- [ ] Test absent old balance defaults to zero; existing mastered states, equipment, life state, notes, and draft status survive unchanged. Legacy talents receive `preparedUses: null`; new own-path allocations may use zero because they do not consume prepared uses. No timestamp or random ID is manufactured.
- [ ] Run the focused tests to demonstrate missing fields, then implement version 4, fresh defaults, and the explicit v3→v4 transform.
- [ ] Validate integer finite new XP values, nonnegative balances, unique nonempty entry IDs, valid timestamps, nonempty trimmed reasons (maximum 1,000 characters), source labels/session labels (maximum 200), and the balance equation. Ordinary award amounts are positive; ordinary spends negative. Zero-delta correction is allowed only when it records an actual talent-state repair.
- [ ] Separate strict new XP validation from preserving unchanged anomalous legacy XP. Compare the stored XP slice on the server: unchanged legacy values may survive unrelated edits, but XP actions require a correction to a valid state. Never silently clamp an old balance or infer missing uses. Add fixtures covering negative/fractional legacy numbers.
- [ ] Run migration, schema, and wizard tests. Update character-construction fixtures and allocation factories affected by the new required property.

### Task 3: Pure XP actions and talent accounting

**Create:** `src/lib/engine/experience.ts`, `tests/unit/experience.test.ts`.

**Consumes:** character, advancement config, and content-pack paths/talents. Caller supplies record ID/time, so the engine stays deterministic.

**Produces:** the following API (export these types from the same module):

```ts
type XpAction =
  | { kind: 'award'; presetId: string; amount?: number }
  | { kind: 'spend'; amount: number }
  | { kind: 'talent-use'; talentId: string }
  | { kind: 'mentoring'; talentId: string; amount: number; mentor: string; phase: 'camp' | 'city' }
  | { kind: 'prepared-use'; talentId: string }
  | { kind: 'correction'; balanceDelta: number; talent?: {
      talentId: string; xp: number; state: 'mastered' | 'in-training'; preparedUses: number;
    } };
interface XpRecordContext { id: string; at: string; reason: string; sessionLabel?: string }
interface ExperienceContent {
  advancement: AdvancementConfig;
  paths: PathDefinition[];
  talents: TalentDefinition[];
}
type XpResult = { ok: true; character: GuildBookCharacterData }
  | { ok: false; error: string };
// applyXpAction(character, action, context, content): XpResult
```

- [ ] Write concrete rule tests before implementing each operation. For example, award 3 to a fresh character and assert experience 3, delta 3, and original input still zero. Then spend one XP on a fixture talent from the character's own path and assert experience 2 and talent XP 1.
- [ ] Implement action validation before producing a cloned result. Ordinary actions reject malformed balances, reused record IDs, unsupported presets, insufficient XP, duplicate/unknown talent IDs, and invalid amounts. Derive path eligibility from `PathDefinition.talentIds`.
- [ ] Test the sixth-to-seventh investment transition and reject further training of mastered talents. Reject using wounded talents. A mastered talent use returns unchanged XP; the UI need not offer an XP action for it.
- [ ] Test mentoring 2 XP produces +2 invested/+2 prepared/-2 available; a prepared use changes only prepared uses. Require mentor/context, other-path eligibility, and an explicit prepared count for legacy records. Cap investment at remaining mastery cost. At mastery clear the now-irrelevant prepared count to zero.
- [ ] Test non-talent spending with a goblin-horde reason. It changes balance/history only, not any talent.
- [ ] Implement corrections with before/after talent snapshots and explicit balance delta. A zero-delta correction can reconcile unknown prepared uses. Reject negative final balances and invalid repaired progress. Do not automatically refund when a talent is deleted or corrected.
- [ ] Run `npm test -- tests/unit/experience.test.ts`; target at least 90% branch/line coverage of this engine using the project's existing coverage configuration. Include an alternate content configuration test so mastery/use costs cannot become hidden constants.

### Task 4: Owner-sheet XP controls and persistence contracts

**Create:** `src/lib/components/character/ExperiencePanel.svelte`, `src/lib/components/character/edit/TalentTrainingControls.svelte`, `tests/e2e/sheet-experience.spec.ts`.

**Modify:** `src/lib/components/character/edit/TalentsEdit.svelte`, `src/routes/sheet/[id]/+page.svelte`, `src/routes/sheet/[id]/+page.server.ts`, `src/routes/api/characters/+server.ts`, `src/routes/api/characters/[id]/+server.ts`, `src/lib/server/validation/character.ts`.

**Tests:** extend `tests/unit/character-api-concurrency.test.ts`, `tests/unit/character-versioned-write.test.ts` and `tests/e2e/sheet-navigation.spec.ts`.

**Interfaces:** controls receive the working character and `ExperienceContent`; emit a complete replacement character from `applyXpAction`, never independent balance and talent mutations. The page owns persistence/error state.

- [ ] Add owner-browser tests for the spec's award/spend example, source history, a failed insufficient-balance spend, and reload persistence. Reuse the auth/setup pattern from `sheet-languages.spec.ts`.
- [ ] Add the panel during ordinary play. Keep full ledger out of shared projection. Use labelled forms and a preview such as “Available XP: 4 → 3; talent progress: 2 → 3.” Render reasons as text.
- [ ] Load advancement config and paths alongside talents. Replace the old hardcoded XP buttons/mastery toggle with training controls and the explicit reasoned correction form. New mentored allocations start with zero known prepared uses; existing unknown records show “Set remaining uses.”
- [ ] Use one page-level save queue for XP actions and pending status writes. Flush a pending debounce before submitting an XP action and use the returned current version; disable a second action until completion. In edit mode actions participate in the explicit Save/Cancel working copy. A cancel must restore balance, history, and talent together.
- [ ] Validate the XP invariant on the server for drafts as well as final characters. Enforce obsolete schema rejection before new-field defaults could erase stored data: PUT returns 409 with a reload-required message for old-schema payloads targeting an upgraded character. POST can migrate an old draft before validation. Keep existing owner checks and version claims.
- [ ] Test stale version/old schema writes, unauthorized users, rapid double-submit, status-change overlap, switching characters with a pending save, and network failure. A 409 never silently replays an award. On network uncertainty, refetch before retrying and check whether the entry ID was already persisted.
- [ ] Run focused unit tests and `npx playwright test tests/e2e/sheet-experience.spec.ts tests/e2e/sheet-navigation.spec.ts`.

### Task 5: XP view and exports; finish increment A

**Modify:** `src/lib/types/character-view.ts`, `src/lib/character/view.ts`, `src/lib/components/character/CharacterSheet.svelte`, `src/lib/export/markdown-export.ts`, `src/lib/export/pdf-export.ts`, `tests/unit/export.test.ts`, `CHANGELOG.md`.

- [ ] Add expectations for available XP and prepared-use displays in view/export tests. Assert that serialized public `CharacterView` contains no ledger entries or reasons.
- [ ] Add `experience` and talent `preparedUses` to the resolved view. Display unknown counts explicitly rather than as zero. Remove the sheet's hardcoded `/7` display in favor of a view value resolved from the content pack.
- [ ] Include available XP and progress in PDF/Markdown, with no ledger by default. Do not add an optional history-export control in this first increment; owner History already meets the requirement.
- [ ] Test legacy/current/draft/shared projections and long talent names. Run `npm run check`, `npm test`, `npm run build`, and the targeted browser tests from Task 4. Record actual outcomes when implementing; do not claim they ran during planning.
- [ ] Update the Unreleased changelog with the delivered behavior. This increment is ready for its own focused review/PR, under the repository's publishing workflow.

## Increment B: Custom spell components in inventory

### Task 6: Component metadata, migration, and load rules

**Modify:** `src/lib/types/character.ts`, `src/lib/schemas/character.schema.ts`, `src/lib/engine/character-migration.ts`, `src/lib/types/content-pack.ts`, `src/lib/schemas/content-pack.schema.ts`, `static/content-packs/hmtw/index.json`, `src/lib/engine/encumbrance.ts`.

**Create:** `src/lib/engine/spell-components.ts`, `tests/unit/spell-components.test.ts`.

**Tests:** extend `tests/unit/character-migration.test.ts`, `tests/unit/encumbrance.test.ts`, `tests/unit/content-pack.test.ts`.

**Interfaces:**

```ts
// Optional property on EquipmentEntry; no separate component inventory.
spellComponent?: { spellId: string | null; spellName: string; notes: string };
// GuildBookContentPack gains:
sorcery: { componentSlots: number; componentDefaultTier: ItemTier };
// createSpellComponent(input, config): EquipmentEntry
// input: { description: string; spellId: string | null; spellName: string; notes: string }
// config: GuildBookContentPack['sorcery']
```

- [ ] Test that a created component has `itemId: null`, the player description in `customName`, location pack, quantity 1, zero notches, and the configured slot size. Configure one slot and an impoverished storage default; the latter is an application compatibility value, not a price ruling.
- [ ] Implement version 5 without rewriting existing gear. Accept unknown spell IDs with a nonempty spell-name snapshot. Component descriptions must be trimmed/nonempty and at most 2,000 characters; spell labels at most 200; notes at most 4,000; quantity a positive integer. Validate component `packSpace` against the pack configuration.
- [ ] Test two components occupy two slots, movement to hand/belt updates totals, and auto-arrangement returns components to the pack. Reject “worn” for components at validation and flag it defensively in load calculation; do not let it become a free slot. Keep ordinary worn-gear behavior unchanged.
- [ ] Support explicit conversion of a custom equipment row to a component in place. Do not convert catalogue gear automatically or infer metadata from text. Confirm reclassification creates no extra row.
- [ ] Run component, migration, and encumbrance unit tests; repeat alternate pack-slot configuration to verify data-driven behavior.

### Task 7: Component editor, reference data, and persistence

**Create:** `src/lib/components/character/edit/SpellComponentsEdit.svelte`, `tests/e2e/sheet-spell-components.spec.ts`.

**Modify:** `src/lib/components/character/edit/GearEdit.svelte`, `src/routes/sheet/[id]/+page.server.ts`, `src/routes/sheet/[id]/+page.svelte`. If adding the missing Casting Spells reference link, also modify `scripts/content-import/manifest/rules-md.json`, its coverage ledger, and generated rules/search artifacts through the existing import pipeline.

**Consumes:** working character, `getSpells()` output, and sorcery config. Both gear/component views edit `char.equipment`.

- [ ] Write browser tests for selecting a canonical spell, entering a custom component description, creating an unlinked custom component, editing/removing, saving, cancelling, and reloading. Include a character with no Wands talent.
- [ ] Implement an “Add spell component” form with catalogue search/select and a Custom option. Selecting a spell prefills its canonical component; a subsequent player edit is saved locally to the character. Show canonical wording separately when the player substitutes a description.
- [ ] Restrict component location choices in both gear and component controls. Quantity controls mean physical items; add concise reusable-component help. Do not show ammo/charges or infer availability of a spell from component ownership.
- [ ] Show optional acquisition notes and rule guidance. If publishing the missing Casting Spells entry, import only permitted text through the manifest, preserving the existing artwork guards; update coverage/search artifacts and run `npm run content:verify:ci`. Do not hand-edit generated rule prose.
- [ ] Apply the schema compatibility guard from increment A to version 5; stale version-4 clients cannot erase component metadata. Test save failure/conflict and draft round trips.
- [ ] Run `npx playwright test tests/e2e/sheet-spell-components.spec.ts tests/e2e/sheet-navigation.spec.ts` and the focused schema/API tests.

### Task 8: Component views, exports, and integrated verification

**Modify:** `src/lib/types/character-view.ts`, `src/lib/character/view.ts`, `src/lib/components/character/CharacterSheet.svelte`, `src/lib/export/markdown-export.ts`, `src/lib/export/pdf-export.ts`, `tests/unit/export.test.ts`, `CHANGELOG.md`.

- [ ] Extend the existing equipment view rows with optional component spell-name/notes metadata. Snapshot labels allow the browser-safe builder to render components without requiring spell data for every wizard/share consumer.
- [ ] Show component details within the gear presentation on owner/shared sheets and both exports. Count inventory only once even if a separate component subsection is presented. Long multiline descriptions and notes must wrap rather than truncate.
- [ ] Test unavailable spell IDs, two components with the same spell but different descriptions, custom components without a spell name, and public output with XP history still omitted.
- [ ] Verify PDF wrapping visually with long component fixtures using the existing exporter; test Markdown content and shared-sheet read-only behavior. No remote spell lookup is needed.
- [ ] Run `npm run check`, `npm test`, `npm run build`, `npm run content:verify:ci`, and `npm run test:e2e`. Check the production adapter build with `ADAPTER=cloudflare npm run build`; no deployment or database migration command is required for JSON-only changes.
- [ ] Verify the complete acceptance examples in the spec, mobile keyboard/form usability, error announcements, and Save/Cancel behavior. Update Unreleased changelog and record validation results for the focused components PR.

## Review checklist

- Every XP source in the rules table has a preset or a documented manual route.
- Own-path use, mentoring investment, prepared-use consumption, and unrelated XP spending remain distinct.
- Migration preserves historical choices and never fabricates lifetime totals or remaining uses.
- Balance/history/talent updates cannot save independently or be replayed silently after conflict.
- Custom components are equipment with truthful load accounting, reusable quantities, and readable fallback labels.
- Shared views and exports include useful character state without exposing owner-only ledger reasons.
- Planning preceded implementation; see the completion report for executed changes and verification.
