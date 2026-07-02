# HMTW content pack

This folder is the **single source of His Majesty the Worm game data** for Guild Book.
The app reads it through `src/lib/server/content/loader.ts`, validated by the Zod schemas
in `src/lib/schemas/`. **No rules are hardcoded in components or routes.**

## Status: transcribed

Kith & kin (with arête triggers and talents), the four paths and their seven talents
each, the Omphalic Market (all three tiers plus weapons and ammunition), conditions,
and staged afflictions are transcribed from the His Majesty the Worm core rulebook.
Effect text is **summarised in the project's own wording** — mechanics faithful,
prose condensed. The `rules.json` reference entries remain summaries.

Not yet included (deferred): the sorcery appendix's individual spell lists (the four
Magic of the — talents reference the rulebook), overland travel, and City-phase
economy tables.

## Editing / extending

Keep the JSON shapes — they're defined by `src/lib/schemas/content-pack.schema.ts`.
Cross-file references that must stay valid (enforced by `tests/unit/content-pack.test.ts`):

- `kins[].masteredTalentId` / `kins[].areteTalentId` → a `talents.json` id
- `paths[].talentIds[]` (seven per path) → `talents.json` ids
- `talents[].requiredItemIds[]` → `items.json` ids
- `paths[].suit` and `attributes[].suit` → one of `swords|pentacles|cups|wands`

Item fields that drive the encumbrance engine: `slots`, `carry` (`belt-only` for
oversized gear, `hand` for wielded), `wornBeltSlots` (armor), `stack.per`
(units per slot), `notches` (durability).

Run `npm run test` after any edit — the schema round-trip and referential-integrity
tests reject a malformed pack before it reaches the UI.

## Legal

Published under the [Adherent of the Worm open licence](https://www.hismajestytheworm.games/open-license).
His Majesty the Worm is copyright Joshua McCrowell. No book artwork, logos, or trade
dress are reproduced; effect text is summarised, not copied. See `/licensing` in the app.
