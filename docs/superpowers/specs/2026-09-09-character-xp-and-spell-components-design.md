# Player-character XP and spell components

Status: shipped in v0.22.0, except talent spending/mentoring UI (the engine supports it; talent progress still uses the free steppers). See `docs/superpowers/2026-09-09-character-xp-components-completion.md` for decisions, deferrals, and verification.

## Purpose and recommendation

Address both player reports on the owned adventurer sheet: show available XP and where it came from, and let players write in their own spell components. This crosses character storage, play actions, inventory, and exports, so it merits a coordinated design. Deliver it as two independently reviewable feature increments: XP first, components second.

Recommended approach: a character-local XP ledger connected to talent spending, and component metadata on existing equipment entries. A bare counter plus a notes box would be cheaper but would leave talent spending disconnected and component encumbrance invisible. A campaign-wide advancement service and full spellcasting subsystem would cover more automation but exceed this feedback. No new database tables or dependencies are necessary.

## Rules reviewed

Primary sources are the repository's active Markdown vault (`assets-src/HMTW_md/`, the source consumed by `scripts/content-import/md-lib.mjs`), checked against the shipped JSON. Use section headings and stable JSON IDs below rather than assuming PDF page numbers. The vault is gitignored; do not add it to a commit. Paraphrases below distinguish rules from product decisions.

| Rule | Source | Consequence |
| --- | --- | --- |
| Everyone gains 3 XP when the guild agrees to pursue a quest, and 3 XP when it completes one. The guild pursues one quest at a time. | Chapter 2, “12. Experience”; `rules.json` → `adventurer-experience` | Separate source presets for accepting and completing a quest, with its name in the history. Editing a quest must never award XP automatically. |
| Completing an employer's contract grants everyone 1 XP. | Same section | Contract completion preset. |
| Carousing grants 1 XP for spending half the gold brought back, or 2 XP for spending all of it; the GM draws for a hangover. | Chapter 9, “Carouse”; `city-carouse` | Two mutually exclusive presets, with reminders about the cost and GM draw. No invented gold balance or automatic draw. |
| Joining the guild and its current quest at the end of a new adventurer's second session grants 3 XP. | Chapter 2, “At the end of your second session”; `adventurer-at-the-end-of-your-second-session` | An explicit joining-current-quest preset, not a blanket 3 XP starting balance. |
| Using an unmastered own-path talent costs 1 XP each time; 7 XP invested masters it. | Chapter 2, “11. Talents”; `adventurer-talents` | Debit available XP and advance the talent together. |
| Cross-path talents require a willing mentor who has mastered the talent. XP is invested during Train, preparing that many uses. Seven invested XP masters the talent. Other kith/kin talents cannot be trained. | Same section; Chapter 8 “Train” (`camp-phase-camp-actions`); Chapter 9 “Train” (`city-phase-city-actions`) | Separate invested XP from remaining prepared uses. Record mentor/context; do not charge XP again when consuming a prepared use. Camp training takes both participants' actions; City training costs 50 gold per XP. |
| XP can also be spent assembling a goblin horde: 2 + XP goblins, at most 8 in the horde. | Chapter 4, Orcish kin, “Horde”; `kith-and-kin-orcish-kin` | Support a named non-talent expenditure; do not assume all spent XP belongs to talents. Horde management itself is outside scope. |
| A funeral can reclaim XP for a successor at 100 gold per XP. Retirement grants successor benefits per 10 XP the retired character had. | Chapter 9 “Hold a Funeral”; Chapter 2 “Retirement” | Allow a documented funeral award/manual reconciliation; do not automatically transfer XP or calculate retirement benefits. The wording does not establish an unambiguous lifetime-earned retirement basis. |
| Each prepared component occupies one pack slot. Components are reusable, including powders, but can be lost, stolen, or destroyed. | Appendix A, “Casting Spells”, active source lines 99–149; Chapter 9 “Prepare Components” | Real inventory entries, one slot per component; never decrement a component for casting. |
| Casting normally requires holding the component, spending 1+ Resolve, and having the relevant Magic of the… talent. An in-training talent also requires XP. | Appendix A, “Casting Spells” | Show linked spell/tradition information. Owning a component does not grant a talent or certify casting eligibility. Keep full casting resolution outside this feature. |
| Individual spells have exceptions, e.g. Give Form to Nothingness needs two hands to play its drum during Challenges. | Appendix A, individual spell descriptions; `spells.json` | Preserve spell descriptions; a generic component tracker must not claim to enforce all casting requirements. |
| Prepare Components is a City Action; scavenging/preparing in the Underworld is rare and GM-adjudicated, probably a Camp Action. | Chapter 9 “Prepare Components”; Appendix A sidebar “Scavenging components in the Underworld” | Optional acquisition notes, no fabricated price/rarity or automatic city-action execution. |

Custom component descriptions and custom spell labels are a product affordance for table-approved material. The rules specify canonical components; this feature must not imply that any replacement automatically satisfies a canonical spell's requirements. Alchemical reagents/hermetic bottles are a separate system.

## Existing implementation and gaps

- `src/lib/types/character.ts`: schema version 3 already has `experience: number`, `TalentAllocation.xp`, and custom equipment names. Blank characters start at zero XP.
- `src/lib/components/character/edit/TalentsEdit.svelte`: XP +/- edits only talent progress, hardcodes mastery at seven, permits free mastery toggles, and has no mentored-use tracking.
- `src/lib/components/character/edit/GearEdit.svelte`: only adds catalogue items despite custom-item storage support.
- `src/lib/types/character-view.ts` and `src/lib/character/view.ts`: omit the XP balance and component associations; this also affects the shared sheet and exports.
- `src/routes/sheet/[id]/+page.svelte`: owner-only play tracking, debounced status saves, explicit edit Save/Cancel, and integer-version conflict handling already exist.
- `src/lib/server/character/versioned-write.ts`: writes the entire character and a version claim atomically for SQLite and D1. Reuse this boundary.
- `spells.json` already contains 40 spells with IDs, traditions, canonical components, and descriptions. `getSpells()` exists. The general Casting Spells material is not currently present as a dedicated rules entry; add the relevant entry through the import manifest if linking to it in the new UI.

## XP design

Show “Available XP” on the owned sheet during ordinary play, with Award XP, Spend XP, and History actions. Each action is an explicit form submission with a preview of the balance change. Disable duplicate submissions while saving. History shows date, source, signed amount, reason, and talent when applicable. Optional session label is plain text so this works without joining a campaign.

Award presets use content-pack values and require a short source description, such as “Accepted: Rescue the bellringer.” Include quest accepted, quest completed, contract completed, both carousing choices, joining a current quest, funeral recovery (variable amount), and other/table award (variable amount). Funeral and other awards require a reason. No automatic awards for editing story fields, joining campaign membership, or changing session phase.

Keep `experience` as the current spendable balance for compatibility. Add `xpLedger: { openingBalance: number; entries: XpEntry[] }`. Require `experience === openingBalance + sum(entries.delta)`. Opening balance represents XP carried into tracking; it is not lifetime earned. Show earned/spent *since tracking began*, if showing those totals at all.

Entries have an ID, recorded-at timestamp, signed integer delta, kind (`award`, `talent-use`, `mentoring`, `spend`, `correction`), source ID/label, reason, optional session label and talent ID. IDs and timestamps are supplied to pure engine functions by the caller. The normal UI appends records. Corrections append a reasoned balancing record instead of silently changing a historical award. This is player bookkeeping, not a tamper-proof GM audit service.

Own-path use spends one available XP and adds one talent XP in the same character change. Reaching the configured mastery threshold masters the talent. Reject insufficient XP, wounded talents, invalid IDs, and ineligible training. A mastered talent incurs no further XP cost. Other talent costs remain player-managed and must be stated beside the action.

Mentored talents use the existing in-training/mastered states plus `preparedUses` (nullable for unknown legacy counts). Identify own-path versus cross-path from content-pack path membership, not the allocation's `source` label. A Train form records mentor and Camp/City context, invests a positive amount capped at the remaining mastery threshold, deducts XP, and adds that many prepared uses. Consuming a prepared use does not affect available XP or invested progress. Once mastered, the prepared-use limit no longer applies. Trainer eligibility and taking/paying for the action are table-confirmed; no campaign roster mutation is implied.

Replace free XP/mastery buttons with these play actions. Preserve manual repair through a clearly labelled correction form requiring a reason. A talent correction explicitly sets progress/state/prepared uses and an independently specified balance adjustment, recording before/after talent snapshots; it does not guess refunds. Removing a talent never refunds historical XP and history retains its label. Restrict ordinary Train to other-path talents, not foreign kin/arête talents.

## Component design

Add “Spell components” under Gear in edit mode, with two entry paths:

1. Choose a spell from the content pack, prefill its canonical component, and optionally enter the player's description.
2. Write a custom component name/description and optional custom spell name without requiring a catalogue match.

Each component is one ordinary `EquipmentEntry` with optional `spellComponent` metadata: `spellId: string | null`, `spellName: string`, and `notes: string`. The existing `customName` holds the actual component description. For components, `itemId` is null; `packSpace` comes from the content-pack component-slot setting; quantity counts physical components, not charges. Use the existing tier field for storage compatibility, with a documented neutral default; it must not imply a component purchase price.

Keep canonical spell data unchanged. A filtered component list and the general gear list are views of the same equipment array, so edits/removal and encumbrance cannot drift. Ordinary additions start in the pack; allow pack, belt, or hand. Prevent components being marked “worn” to exploit the existing zero-slot treatment for unknown worn items. Over-capacity continues to warn rather than block, following current inventory behavior.

Show spell name, player description, quantity, location, and notes on the sheet. Allow editing and removal for loss/theft/destruction, but introduce no durability score without a rule. Do not add a “consume component” action. Unknown spell IDs remain readable using the stored spell-name snapshot and description. Anyone may record a carried component; do not hide the feature from non-Wands characters.

## Persistence, migration, and compatibility

Deliver XP with schema version 4 and components with version 5, using version-stepped transforms. Re-evaluate the next free version if other work has landed before implementation.

- Existing valid balances become the XP opening balance; ledger entries start empty. Existing talent XP/mastery is preserved without deducting XP retroactively or fabricating earned XP.
- Existing cross-path in-training talents have unknown remaining prepared uses. Migrate these to `preparedUses: null`, show “Set remaining uses,” and require explicit reconciliation before consuming/training that record. Do not assume all historical invested XP is still unused.
- Existing equipment stays equipment. Do not parse notes or guess components from item names. Players can explicitly classify an existing custom item as a component without duplicating it.
- Migration is pure and idempotent, including localStorage wizard drafts. No clock/UUID calls during migration. No SQL/D1 migration is expected.
- Strict new writes use finite integer balances/progress/counts and coherent ledger totals. Legacy out-of-range numeric values must remain visible for a reasoned repair rather than silently deleting player history; block XP actions until reconciled. Unrelated edits should remain possible through a bounded legacy-preservation validation path.
- Old schema payloads must never strip newly stored ledger/component data. Return a specific reload-required conflict for obsolete clients when a character has advanced to the new version. Initial legacy draft creation may be migrated before validation. Test this in both POST and PUT paths.
- Keep owner authorization and existing version claims. On save conflict, refetch and explain that the action was not recorded; never automatically replay an XP award. Save balance, ledger, and talent changes as one document.

## Display and boundaries

The public shared sheet and PDF/Markdown exports show available XP, talent progress/prepared uses, and component details. Full XP source history remains owner-only by default; an optional owner export can include it explicitly. Public view projection must omit the ledger rather than merely hiding it in markup. Long descriptions wrap in exports.

No new wizard step, campaign-wide award fan-out, retirement calculator, gold accounting, automatic cast action, GM permission workflow, homebrew spell-effect editor, alchemy system, or denizen changes. Existing footer/licensing remains intact. New mechanical constants and award presets belong in content-pack JSON, not Svelte components.

## Acceptance examples

- Award quest acceptance (+3), contract completion (+1), and use an own-path in-training talent once: available XP is 3, talent investment rises by 1, and history explains all three changes.
- Spend the seventh XP on a talent: mastery changes atomically; reloading preserves it. With zero available XP, spending fails without changing history or the talent.
- Invest 2 XP with a mentor: balance falls by 2, investment rises by 2, prepared uses rise by 2. Use once: only prepared uses fall by 1.
- Record a custom “Ash from the drowned chapel” component linked to a spell: it persists, adds one pack slot, and appears in sheet/share/exports. Casting elsewhere leaves its quantity unchanged.
- Two physical components take two slots. Moving one to a hand changes the appropriate load totals; neither list creates a second inventory record.
- Load a version-3 character with 5 available XP and a talent at 4 XP: preserve both values, start at opening balance 5, and invent no history or prepared-use count.
