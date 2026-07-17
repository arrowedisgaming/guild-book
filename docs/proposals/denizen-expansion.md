# Proposal: Denizen Expansion — Dungeon Lords, People, Saving, Encounters

**Status:** draft — for discussion
**Author:** Chris Wilson

Follow-up to the monster builder (#2). Four features, in dependency order:

1. **Dungeon lord building** — the pool editing deferred from #2 (your Option B).
2. **Man / adversary flow** — build a person-as-adversary in the builder, per the
   thread in #2 ("Man needs some thought").
3. **Saved denizens** — persist denizens per account, mirror the characters plumbing.
4. **Encounter tracker** — a GM screen: combatants, health (including pools), zones,
   and the Chapter 7 Challenge-hand calculation.

I'd deliver these as **three implementation PRs** (1+2 together, then 3, then 4) so
each is reviewable on its own and the builder patterns are settled before the DB work
builds on them.

Ground rules carried over from the #2 review, applied from the first commit this time:
every encoded rule reaches the user; supported paths can't produce invalid output; no
content-pack IDs hardcoded in app code — behavior branches on capability metadata;
persisted state is sanitized field by field; async operations announce failures and
disable in flight; a11y and the full validation suite are in scope, not polish.

---

## 1. Dungeon lords (multi-pool builder)

Everything downstream already works: `DenizenPool`, `specialRules`, stat-block
rendering, and both exports shipped in #2 for the Sporehulk and Yellow King. This adds
the missing editing layer.

- `DenizenDraft` gains `pools` (name, health, defense, "what defeating this means"
  text, per-pool notes/lesser dooms/greater dooms) and `specialRules`.
- Threats with `builderMode: 'pools'` become selectable; the wizard inserts a
  **Pools** step between Customize and Dooms, and Customize hides top-level HD
  (pools replace it — same invariant the content schema already enforces).
- Seeding per the template: attributes 3/3/3/3 with the "raise one to 6" stat note,
  one blank pool to start.
- Validation mirrors the schema: each pool needs a complete HD pair, ≥1 pool
  required, top-level HD and pools mutually exclusive — live warnings in the builder,
  blanks omitted on materialization, and a regression test that pool drafts can never
  export `Health/Defense: /`.
- Existing drafts in localStorage survive: the field-by-field sanitizer defaults the
  new fields, no state-version bump needed.

## 2. Man / adversary flow

The book says: represent people by making actual characters, then give them a few
gimmick dooms. The full character wizard is the wrong tool inside the denizen builder,
so this is a truncated version of it, honestly labelled:

- New theme capability `builderMode: 'person'` (types + schema + `denizens.json`;
  the "Man is unsupported" regression test updates accordingly).
- Choosing a person-mode theme swaps the wizard path: Concept → Theme → **Person** →
  Customize → Dooms → Review. The Threat step is skipped — people don't take a threat
  template; the materialized denizen omits the threat with a stat note instead of
  carrying an empty string.
- The Person step reuses character-creation pieces: the kith list (via the existing
  `getKiths()` accessor, added to the build page load) for flavour — chosen kith
  renders as a note — and the adventurer 4/3/2/1 attribute spread via the existing
  `engine/attributes.ts` helpers. Wording throughout makes clear this is an
  adversary, not a PC, and creation rules are guidance.
- The Dooms step drops template pick-lists for people and leads with the book's
  gimmick-dooms instruction.

## 3. Saved denizens

Mirrors the characters plumbing, and keeps the anonymous guarantee from #5: building
and exporting never require sign-in; saving is the only signed-in feature
(`anonymous-tools.test.ts` stays green).

- **Table** `denizens`: `id`, `userId` (FK, cascade), denormalised `name`/`theme`/
  `threat`, `data` JSON blob (draft + materialized definition), `isArchived`,
  timestamps. Migration `0003`, purely additive; no `shareId` yet — public sharing is
  a natural follow-up and the column can be added additively then.
  **Deploy note:** `npm run db:migrate:d1:remote` before merge, per DEPLOY.md.
- **API** `GET/POST /api/denizens`, `GET/PUT/DELETE /api/denizens/[id]`, following
  `api/characters` conventions (`ensureUser`, ownership checks, server-side ids).
  The Zod schema enforces the same stat invariants as the content-pack schema —
  HD as a pair or ≥1 valid pool, no blank stats — so the DB can't hold what the
  renderers can't show. Person-kind denizens are allowed no threat id.
- **UI:** a Save button on the builder's Review step (sign-in nudge otherwise),
  following the export buttons' resilience pattern (try/catch, announcer, disabled
  in flight). `/denizens/mine` lists them (modelled on `/characters`) with
  edit — loads the draft back into the builder — and delete. Detail pages live at
  `/denizens/mine/[id]`, keeping `/denizens/[id]` bestiary-only so user content can
  never shadow book content. `/denizens` gains a clearly-separated "Your denizens"
  section when signed in.
- **Tests:** schema units against malformed payloads, and handler tests against an
  in-memory better-sqlite3 drizzle DB (the `auth-lifecycle.test.ts` pattern) covering
  ownership and the anonymous-401 path. e2e stays anonymous — the repo has no
  signed-in e2e infrastructure and I don't propose building it here.

## 4. Encounter tracker

`/encounter` — client-side and localStorage-persisted like the builder drafts, no
login needed. Combatants come from the bestiary, saved denizens (when signed in), or
quick-add (name + HD). Each combatant tracks current/max health — one row per pool
for dungeon lords — a zone picked from a GM-editable zone list, and a defeated flag.
Zones are a plain list; deleting one moves its combatants to "unassigned".

### The Challenge-hand calculation

This is the deferred Chapter 7 rule from #2 (your changelog TODO). The procedure —
3 base cards, +1 per enemy type, +1 outnumbered, +1 at 2×, +1 per larger-than-human
enemy, +2 elite, +3 dungeon lord — is recomputed at step 1 of each round, so the
tracker models it that way:

- **The procedure is content-pack data**, a new small collection
  (`challenge.json`): base hand size, the count rules with display text, and a
  `threatBonuses` map keyed by threat id (`elite: 2`, `dungeon-lord: 3`). Threat IDs
  live in data, not app code; `denizens.json` is untouched, so the #2 regression
  test that keeps Chapter 7 procedure out of Appendix C data stays exactly as is.
  Wiring: `files.challenge` in `index.json`, a `challenge` entry in the (closed)
  files schema, collection schema + types + loader accessor. A unit test asserts
  every `threatBonuses` key resolves to a threat in `denizens.json`. Display text is
  book text, per the open-content approach settled in #1. This intentionally starts
  the Chapter 7 rules import your TODO defers to — scoped to just this rule.
- **Auto-derived counts** from encounter state: distinct enemy types, outnumbering
  vs a party-size field (default 4). Combatants carry their threat id, so bestiary,
  saved, and homebrew denizens all pick up their bonus from the map; ad-hoc
  quick-adds get a per-combatant override.
- **GM judgment stays manual:** a per-combatant "larger than human" toggle (the book
  leaves size undefined) and the override above for table rulings.
- **Round-based, not live:** the encounter tracks a round number; **Next round**
  snapshots the suggestion (from non-defeated combatants) into the dealt hand, which
  stays fixed until the GM advances. The suggestion renders as the rule's own
  line-by-line breakdown ("3 base + 2 types + 1 outnumbered + 2 elite = 8"), with a
  manual edit on the dealt total.

Engine logic is pure and unit-tested per rule line; the store gets the same
sanitize-on-load treatment as the builder.

## Non-goals (for now)

- **Public share links for saved denizens** — easy additive follow-up once saving
  exists (`shareId` column + the `/s/` pattern).
- **DB-backed encounters** — encounters are ephemeral; localStorage covers the use
  case. Could follow if cross-device demand appears.
- **Full Chapter 7 rules import** — only the hand-size procedure comes in here.
- **Initiative/turn-order tracking** — the card-based Challenge phase doesn't
  obviously need it; open to being wrong.

## Validation

Each PR: `npm run check`, `npm run test`, `ADAPTER=cloudflare npm run build`,
`npm run test:e2e`, `npx drizzle-kit check` (PR 2), and I'll run `content:verify`
locally against the vault and report the result, since CI can't.

## Open questions

1. Person step: should picking a kith seed suggested likes/hates, or stay purely
   flavour? I lean flavour-only — likes/hates feel like per-NPC choices.
2. Saved denizens: any cap per user? Characters have none, so I've assumed none.
3. Happy to hear a better shape for `challenge.json` if you have opinions on how
   Chapter 7 content should eventually be organised — this collection should be the
   first brick of that, not a one-off.
