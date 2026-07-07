# Proposal: Dungeon Denizen Reference & Builder

**Status:** draft — for discussion
**Author:** Chris Wilson

A browsable bestiary reference and a guided monster builder for His Majesty the Worm,
following the same content-pack-driven approach as the adventurer creator and rules
reference.

## Why

HMTW GMs build monsters by combining two templates and customizing the result. The book
(Appendix C: Dungeon Denizens) describes this as "monstrous mixology":

- **Theme** — the creature's mythological context: Beast, Sorcerous, Elemental, Spirit,
  Man, or Undead. A theme contributes likes/hates, standing notes, and default
  *lesser dooms*.
- **Threat** — the creature's strength and tactics: Minion, Brute, Strategist, Elite, or
  Dungeon Lord. A threat contributes attributes, Health/Defense, and a pick-list of
  *greater dooms*.
- The GM combines the two, **exaggerates one aspect**, and invents one or two dooms for
  that aspect.

This is exactly the kind of structured-but-creative flow Guild Book already does well for
adventurers. The book also includes ~22 pre-made denizens (skeleton, mimic, dragon, …)
that make a natural reference companion to `/rules`.

## What

Two user-facing pieces, one data foundation:

1. **Denizen reference** — a browsable, filterable bestiary (filter by theme/threat,
   search by name), with a stat-block detail view. Read-only, no login needed. Also
   surfaces the theme and threat templates themselves, since GMs use those at the table.
2. **Denizen builder** — a guided wizard: pick a theme, pick a threat, get the merged
   template as a starting stat block, then customize (name, concept, exaggerated aspect,
   stats, dooms). Output is a finished stat block exportable as Markdown.
3. **Content pack data** — templates and bestiary live in
   `static/content-packs/hmtw/denizens.json`, validated with Zod, loaded through the
   existing `src/lib/server/content/loader.ts` pattern. No code changes needed to swap
   or extend the data, same as every other collection.

### Non-goals (for now)

- **Saving denizens to an account.** The builder ends at "export/copy your stat block."
  Persistence means a DB schema change and share-link plumbing; that's a natural
  follow-up PR *if we want it*, but the builder is useful without it.
- **Encounter building** (grouping denizens, challenge-card math across a fight).

## Data model

New file `denizens.json` in the hmtw content pack, three collections:

```jsonc
{
  "themes": [
    {
      "id": "undead",
      "name": "Undead",
      "description": "…",            // original wording, not book text
      "likes": ["Some Fond Memory of Life"],
      "hates": ["The Living"],
      "notes": [ { "name": "Breathless and Undreaming", "text": "…" } ],
      "lesserDooms": [ { "name": "Fear", "text": "…" } ],
      "chooseLesserDooms": 1          // "choose 1 of the following", where the book says so
    }
  ],
  "threats": [
    {
      "id": "brute",
      "name": "Brute",
      "description": "…",
      "attributes": { "swords": 6, "pentacles": 4, "cups": 1, "wands": 1 },
      "health": 2,
      "defense": 6,
      "notes": [ { "name": "Tough", "text": "…" } ],
      "greaterDooms": [ { "name": "Deadly Attack", "text": "…" } ],
      "chooseGreaterDooms": 2,
      "extraChallengeCards": 0        // elites and dungeon lords prompt extra draws
    }
  ],
  "bestiary": [
    {
      "id": "skeleton",
      "name": "Skeleton",
      "theme": "undead",
      "threat": "brute",
      "flavor": "…",                  // paraphrased, see Licensing
      "attributes": { "swords": 6, "pentacles": 1, "cups": 1, "wands": 4 },
      "health": 6,
      "defense": 0,
      "likes": ["Almost Nothing"],
      "hates": ["Life", "Sound", "Light"],
      "notes": [ … ],
      "lesserDooms": [ … ],
      "greaterDooms": [ … ]
    }
  ]
}
```

The book has deliberate irregularities the schema must survive, so a few fields are
looser than you'd expect:

- **Special stat values.** The slime's Swords/Pentacles equal its current Health; the
  bloodybones has infinite Health. So attribute values and `health` are
  `number | string`, with the schema documenting the convention (`"∞"`, `"X"`) and an
  optional `statNote` explaining it.
- **Multiple HD pools.** Dungeon lords (the Sporehulk, the Yellow King) are fought in
  named sections — legs/arms/torso, body/crown/phylactery — each with its own HD, notes,
  and dooms. Bestiary entries get an optional `pools` array carrying
  `{ id, name, health, defense, notes, lesserDooms, greaterDooms, text }`; when present
  it replaces the top-level HD. Simple creatures never use it.
- **Sidebars.** Some entries have attached extras (the face rat's disease stages, the
  vampire's "four of these rumors are true" list). An optional `sidebars` array of
  `{ title, body }` keeps these without complicating the core shape.

## UI

### Reference — `/denizens`

- Index page: card list of bestiary entries, filter chips for theme and threat, name
  search. Styled like the existing `/rules` reference.
- `/denizens/[id]`: full stat block. Stat-block rendering is one shared component
  (`DenizenStatBlock.svelte`) so the reference and the builder preview render
  identically.
- A "Templates" section (or tab) showing the six themes and five threats, since GMs mix
  from these directly at the table.

### Builder — `/denizens/build`

Follows the `create/hmtw` wizard pattern (steps under a shared layout, client-side store
holding the draft). Steps mirror the book's recipe:

1. **Concept** — name, the classic monster you're starting from, the one exaggerated
   aspect. Free text.
2. **Theme** — pick one of six; shows what it contributes.
3. **Threat** — pick one of five; shows attributes/HD and what it contributes.
4. **Customize** — merged stat block, everything editable: attributes, health/defense,
   likes/hates. Template values prefilled; the book explicitly blesses tweaking
   ("You can change any detail provided by a template").
5. **Dooms** — the template's doom pick-lists (with the "choose N" guidance shown), plus
   add-your-own dooms and notes for the exaggerated aspect.
6. **Review & export** — final stat block, copy-as-Markdown. (Dungeon lord multi-pool
   authoring is builder-v2 territory; the wizard covers single-pool creatures, which is
   every threat except dungeon lord. Dungeon lords still appear fully in the reference.)

No login required; the draft lives in the client store. Losing a draft on refresh is
acceptable for v1 (localStorage persistence is a cheap follow-up if it annoys anyone).

## Licensing
Claude suggests that we use the same policy as the rest of the pack: **mechanics summarized in original wording, no book prose reproduced and there is a summary below. 
### Is that still the plan? 
Josh seemed happy that the full book text was open content. I’m happy to go either way but its wasted effort to rewrite text if that has changed the plan.  

** Sticking with the original “no book text we would have:
- Stats, template structure, doom *mechanics* — fine to include (facts/mechanics, and the
  Adherent of the Worm licence covers referencing them).
- Flavor text for bestiary entries — rewritten from scratch, not transcribed. Same for
  doom descriptions where the book's phrasing is distinctive.
- Doom/ability *names* kept where they're functional ("Tough", "Fleet") — flagged for
  review where they're clearly creative writing (the Yellow King's dooms are song
  titles; his entry likely wants renamed dooms or a trimmed adaptation).
- Follow the existing pack's `PLACEHOLDER SUMMARY` convention during development if we
  want to land structure before finished prose.

## Implementation plan

Sliced into small, independently reviewable PRs. Each lands green (`npm run check`,
`npm run test`) and nothing depends on an unmerged PR.

### PR 1 — data foundation

1. Zod schemas for themes/threats/bestiary in `content-pack.schema.ts` + types in
   `content-pack.ts`.
2. `denizens.json` with all six themes and five threats, fully written.
3. Bestiary entries: stats/mechanics for all ~22 creatures, flavor as placeholder or
   final prose (whichever review prefers).
4. Loader functions (`getDenizenThemes`, `getDenizenThreats`, `getBestiary`) + register
   the file in `index.json`.
5. Unit tests: every bestiary entry validates; every `theme`/`threat` reference resolves;
   special cases (slime, bloodybones, dungeon lords) parse.

### PR 2 — reference

1. `DenizenStatBlock.svelte` (handles pools, special stat values, sidebars).
2. `/denizens` index with theme/threat filters and name search.
3. `/denizens/[id]` detail page.
4. Theme & threat template display.
5. Nav entry + Playwright smoke test (index renders, filter works, detail renders the
   skeleton and one dungeon lord).

### PR 3 — builder

1. Draft store (`denizen-builder.ts`) with template-merge logic; unit tests for the merge.
2. Wizard shell + steps 1–3 (concept, theme, threat).
3. Steps 4–5 (customize, dooms).
4. Step 6 (review, Markdown export — reuse `src/lib/export` patterns).
5. Playwright test: build a monster end-to-end, export it.

### PR 4 (optional, separate decision) — persistence

Save built denizens to an account, share links. Touches the DB schema — **not started
until we've agreed it's wanted.**

## Open questions

1. **Route/word choice:** `/denizens` vs `/bestiary` vs `/monsters`? The book says
   "dungeon denizens"; "bestiary" may be clearer to users.
2. **Is PR 4 (saving/sharing) wanted at all?** And if so, does a saved denizen belong in
   its own table or generalize the existing `characters` storage?
3. **Placeholder vs. final prose in PR 1** — land structure fast with placeholders (like
   `rules.json` does today), or hold PR 1 until the rewritten flavor text is done?
4. **Where should this live in the nav** — top-level alongside Rules and Deck, or under a
   "GM tools" grouping (anticipating encounter tools later)?
