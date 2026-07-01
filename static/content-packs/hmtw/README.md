# HMTW content pack

This folder is the **single source of His Majesty the Worm game data** for Guild Book.
The app reads it through `src/lib/server/content/loader.ts`, validated by the Zod schemas
in `src/lib/schemas/`. **No rules are hardcoded in components or routes** — everything the
wizard and rules reference display comes from these JSON files.

## Status: PLACEHOLDER

The committed pack is a **placeholder**. Structure and core mechanics (the four suits/
attributes, tarot ranks and values, the 4/3/2/1 attribute spread, the Omphalic Market
tiers) reflect the real rules, but kith/kin, path, talent, item, and rules-text entries
are representative stubs. Every stub is marked `PLACEHOLDER`. `index.json` sets
`"license": "placeholder"`.

## How to swap in the real rules

1. Replace the entries in each file with data transcribed from the His Majesty the Worm
   rulebook. Keep the **JSON shapes** — they are defined by the schemas in
   `src/lib/schemas/content-pack.schema.ts`.
2. **Keep ids stable** where possible so saved characters keep resolving. Cross-file
   references that must stay valid:
   - `kins[].masteredTalentId` / `kins[].areteTalentId` → a `talents.json` id
   - `paths[].talentIds[]` → `talents.json` ids
   - `paths[].suit` and `attributes[].suit` → one of `swords|pentacles|cups|wands`
   - `talents[].requiredItemIds[]` → `items.json` ids
3. Set `index.json` `"license"` and `"authors"` to the real values and remove the
   `PLACEHOLDER` markers.
4. Run `npm run test` — the schema round-trip and loader tests will reject a malformed
   pack before it ever reaches the UI.

No application code needs to change to swap real data in.

## Legal

Only reuse His Majesty the Worm **mechanics and game text**, per the "Adherent of the
Worm" licence. Do **not** paste large verbatim passages, art, or trade dress. Summarise
and paraphrase rules text for the reference. See `/licensing` in the app.
