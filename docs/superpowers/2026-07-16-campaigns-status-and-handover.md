# Campaigns & Shared Tarot — Status, Failure Modes, and What's Left

**Date:** 2026-07-16
**Author:** Claude (Opus 4.8), written after two external adversarial reviews
**Scope:** everything from `177af5b` (Release v0.1.0) to now

This is a handover, not a progress report. It is written to be useful to whoever
picks this up — including me in a fresh session — so it leads with what went
wrong rather than what got built.

---

## 1. TL;DR

Three increments landed on `main` (0a, 0b, 0.5) plus one fix round. Everything is
**local and unpushed**. The engine and content pipeline are real and well-tested.

**But two adversarial reviews found 27 issues between them, and the same root
cause produced at least four rules errors — including one where I deleted a real
game rule from the specification after telling the owner the game didn't have
it.** That deletion was approved by the owner on the strength of my false claim.

The second-review correction bundle is complete on
`fix/campaigns-second-review-findings`. Work intentionally stops after that
bundle because the remaining catalog work is *exactly* the class of task that
produced the repeated errors, and a structural fix (§5) should land first.

---

## 2. Current state

| | |
|---|---|
| Branch | `fix/campaigns-second-review-findings` (correction bundle included with this handover) |
| `main` | 3 increments + 1 fix round merged, **13+ commits ahead of `origin`, nothing pushed** |
| Tests | 232 passing, 21 files |
| `npm run check` | 0 errors |
| Content drift | 0 across all collections |
| Rules reference | 56 entries |
| Procedure catalog | 31 procedures, 14 oracle tables (194 rows), 8 modifiers, 3 formulas |
| Content pack | v2.3.0, digest-enforced |

### Gates

- **Gate A1 (0a — rules prose):** passing
- **Gate A2 (0b — procedure contract):** passing, but see §3 — "passing" here means
  self-consistent, not rule-correct. The tests could not catch the rules errors.
- **Increment 0.5 (resolution engine):** complete, engine verified in a real browser

### Decision log (`docs/superpowers/plans/…-roadmap.md`)

| ID | Status |
|---|---|
| D1 art permission | Resolved — confirmed by owner |
| D2 oracle scope | Resolved — full lookup |
| D3 spec approval | Resolved — approved |
| D4 Pages vs Workers | **OPEN** — deliberately deferred to Increment 5 |
| D5 no invented rules | Standing rule — the rulebook overrides the spec |
| ~~D6 Signs deck~~ | **WITHDRAWN — my premise was false** |
| D7 rules live at the call site | Standing rule — **and I broke it immediately after writing it** |

---

## 3. The failure modes (read this part)

### 3.1 The primary failure: reading where a rule is *printed*, not where it is *used*

Four separate errors, one cause. Each time I searched for the section a rule
lives in, found something that looked complete, and stopped.

| Error | What I did | What the book actually says |
|---|---|---|
| **Signs and Portents** | Told the owner the book was *silent* on what it draws. Asked them to fill the gap. They chose a fresh deck (D6). | Ch9:130 — "the GM **looks at the top card of the minor arcana discard pile** and then consults the Signs and Portents table." Repeated at Ch9:160. **The instruction is at the call site (City Events), not in the Signs section.** |
| **`gm-twist`** | Modelled as a `draw`. | Ch10:354 — "**Glance at** the top of the minor arcana discard pile." A draw consumes a card and shifts later odds. |
| **Bracket convention** | Typed only `[value]`/`[odd]`/`[even]`. | Ch9:275 declares the convention in *Carouse*, governing the *Hangover* table: **every** bracket refers to the discard top — including `[Swords]` and `[1–2]`, i.e. most of the rule. |
| **Guard / shield Initiative** | Declared it fictional. **Deleted it from the approved spec** and from Increment 3's modifier + command. Got owner approval by saying the game lacked it. | Ch7:552 — "If you have a shield, you may replace your Initiative with any card from your hand as a miscellaneous action. Your old Initiative is discarded." **`552:### Guard` was in my own grep output and I never opened it.** |

The Guard case is the worst, and it happened **after** I had already written D7 as
a standing rule about this exact mistake. I searched Chapter 9's `Shield`
equipment entry (Notches) and Chapter 7's attack tie-breaks, concluded the
mechanic didn't exist, and never checked the *actions* list. I searched the noun
(`shield`) and not the effect (`Initiative`).

**The structural cause:** the audit manifest's `source` field points at where a
table or rule is *printed*. I have been treating it as evidence of how the thing
is *used*. It is not. See §5.

### 3.2 Tests that confirmed bugs instead of catching them

- **The token test was tautological.** It matched cell text against the same enum
  the parser used — asserting the implementation back at itself. It was
  structurally incapable of catching `[Swords]` going untyped, which is exactly
  what had happened.
- **My own engine test constructed an illegal state.** The Fool-on-push test
  pushed a total of **17** — an initial *success*. It passed only because
  `resolveTestOfFate` didn't yet enforce the push precondition. When I added the
  guard, my own test failed.
- **My own E2E codified a rule violation.** It checked "Favor" *after* drawing,
  a sequence Ch1 forbids (Resolve/favor are pre-draw). It was encoding the
  manipulable UI as correct behaviour.

Lesson applied: new guards are now **mutation-tested** — reintroduce the bug,
confirm the test fails, revert.

### 3.3 Fixing a bug only where it was reported

The `<br>` welding fix went into the *table* extraction path. The identical bug
sat in the *prose* path the whole time (`normalizeMarkdown`), and shipped
`face.•` and `down[Pentacles]` into `rules.json`. Two pipelines, one bug class, I
patched one. Both now share the rule and a test guards both.

### 3.4 A hole in my own integrity guard

`verify-pack-version.mjs` hashed only the *generated collection files*. When I
added `doomTiers`, `favorModifier` and `groupOutcomes` to `index.json`, **the
digest didn't change** — a live game rule could be edited with no version bump.
`index.json` is not just a manifest; the runtime snapshot compiles from it. Fixed
and proven by tampering.

### 3.5 What the reviews cost, and what they were worth

Neither review was optional. gpt-5.5 found 7 issues; gpt-5.6-sol found ~20 more
*after* those fixes, including the Guard deletion. **My self-review found none of
these.** Every rules error was found by someone reading the book properly.

One correction for the record: **gpt-5.6-sol was wrong about one finding.** It
claimed `challenge-end-the-round` imported the wrong heading and that Ch7:707 is
authoritative on the Fool. Ch7:707 doesn't mention the Fool at all. Its
*underlying* point is real and worse — see §6.1.

---

## 4. Second-review correction bundle

Included in the commit containing this handover. The content, type, and unit
gates pass; focused Playwright execution remains an environment gap described
in §6.4.

- **Guard restored.** Imported as rules entry `challenge-guard` (0a manifest),
  reinstated in the spec §8.7 with an amendment-history note explaining the
  deletion, re-added to Increment 3 as `challenge-guard` modifier +
  `replace-initiative-with-shield` command, and added to the catalog as a
  procedure + modifier. Also imported `challenge-miscellaneous-actions`, since
  0a had missed that whole section.
- **GM hand formula corrected.** Increment 3's pseudocode used
  `enemies.length * perEnemy`; it now counts unique `typeIds` with
  `perEnemyType`, because the rule is **+1 per enemy _type_**. Verified
  against the book's own worked example: 12 imps vs 4 adventurers = **6 cards**
  (the old maths gave 15).
- **`<br>` welding fixed in the prose pipeline**, with a test guarding all 56
  entries. Both pipelines now agree.
- **`TestOfFate` declaration locked** once a card is visible — suit, attribute,
  favor, disfavor, Resolve, and the initial-draw action all freeze. Previously
  you could see a Cups card, switch to Cups, and manufacture a great success, or
  repeatedly request another "initial" card.
- **E2E rewritten** so it no longer codifies the illegal post-draw sequence, plus
  a new test asserting the lock.

---

## 5. Recommended structural fix — do this before more content work

**Add `invokedFrom` to the procedure contract, alongside `source`.**

Every rules error above traces to conflating two different locations:

- `source` — where the table/rule is **printed** (what the audit records today)
- `invokedFrom` — where the book says **how and when to use it** (unrecorded)

For Signs: `source` = Ch9's `## Signs and Portents`; `invokedFrom` = Ch9:130's
City Events XXI paragraph, which is the *only* place stating you consult the
discard top. For Guard: the effect (`Initiative`) is the searchable term, not the
noun (`shield`).

Make it **required** for `supported-v1` entries, so authoring a procedure forces
you to find the call site. That converts my failure mode from "silently possible"
to "structurally hard". Without it, the next person repeats this.

---

## 6. What's left

### 6.1 Needs an owner ruling (not fixable by me)

- **The rulebook contradicts itself on the Fool reshuffle trigger.** Three places
  say **drawn** (Ch1:302, Ch7:356, Ch7:47); exactly one says **played**
  (Ch7:383) — and that outlier is the section imported as
  `challenge-end-the-round`. So the pack contains a statement contradicting its
  own `challenge-the-fool` entry. The engine uses `foolDrawn` (the majority +
  Ch1 authority). **Decide: is this a book erratum?** Not an import bug — there
  is no better section to import.
- **D4 — Pages vs Workers.** Still open, blocks Increment 5 only. `wrangler.toml`
  is a Pages config; Increment 5 assumes Workers (`wrangler deploy --dry-run`
  errors; `[[ratelimits]]` type-checks but is `undefined` at runtime).

### 6.2 Outstanding review findings (from gpt-5.6-sol, unfixed)

Ordered by severity. All are catalog/engine modelling, i.e. §3.1's class.

**P0**
- **Fool reshuffle is only a printed message.** `TestOfFate` never calls
  `reshuffleAll`; subsequent tests reuse the old deck order. The E2E only asserts
  the *text*.
- **Modifiers are not rule-complete.** Brainfever omits favor on Attacks; Counsel
  omits once-per-round and Resolve-enabled interrupt play; Guardian Angel omits
  facedown placement, Dodge/Riposte restriction, cumulative value, facedown-limit
  exemption, single-instance limit and duration; Black Honey turns an optional
  five-card deal with a teeth consequence into an unconditional `+1`.

**P1**
- **Challenge Initiative models only the player/minor side.** Ch7 requires the GM
  to place a facedown *major* Initiative per significant enemy/group. End-round
  cleanup names only the minor deck. As-is the procedure can't order GM turns.
- **Maleficence resolves all four tables.** Encoded as four consecutive draws; the
  rule invokes **one** table (the appropriate far realm). The contract has no
  branch discriminator — a runner would consume four cards and inflict four
  catastrophes.
- **Camp watch is unconditional.** The Meatgrinder draw is missing, and
  watch-selection + Cups test should fire *only* on a random-encounter result.
  Patrol draws twice but can't choose one non-encounter result.
- **Meatgrinder loses its three invocation modes.** Loud noises retain only
  XVI–XX; moving carefully only I–V; ordinary events are marked off and become
  no-ops if redrawn. No filters or depletion state exist.
- **Augury has no decline branch.** The guild may decline (card discarded, Bound
  by Fate applies) or accept (that card becomes the initial test card, with
  Resolve/push still available). Neither is modelled.
- **Malediction's 50% is mis-scoped.** Only I, II, III and IX have checks, and
  they occur *later* (City end, waking, eating, nightly) — not at draw time.
- **Strange Communions** has no mixed-source choice, draw count, or
  once-next-expedition duration.
- **Beg & Busk / Leeches / Area Sense** encode only the draw, omitting the
  mechanical result (`value + Wands` gold; suit branch + two charges; 2 Resolve
  per watch + `value` visions).
- **`ResolutionCard` has no provenance.** Any matching-suit `initialCard` counts
  as an initial draw, but Ch1 excludes cards "from … another source" from great
  success — so a High Chant inspiration card produces an illegal great success.

**P2**
- **Group test arity.** `selectGroupTestActors` accepts a solo roster and returns
  the same adventurer twice; `resolveGroupTest` accepts any number of outcomes,
  though the bands only make sense for exactly two. A test enshrines the solo
  behaviour.
- **Broken rules references.** `social-encounters-disposition` should be
  `crawl-social-encounters-disposition`; `7-deeds-and-fame` has no entry at all.
  Tests skip every `collection: "rules"` reference, so neither is caught.
- **Modifier/formula params are untested.** Tests check only that IDs resolve —
  never param names, values, timing or semantics. Every malformed modifier above
  passes.

### 6.3 Known-good (confirmed clean by review)

- `index.json` doom tiers, favor modifier, group-outcome bands — match the book
- All 194 lookup rows: ranges, axes, columns, cell text — match the source
- All three formula definitions — match the source (the *consumer* was wrong)

### 6.4 Carried forward from earlier

- **Focused E2E is not verified.** The configured production preview fails to
  start here with a filesystem `ETIMEDOUT`. A local run can also be misled by
  `reuseExistingServer`: it reused a stale July 15 dev server whose SSR HTML
  referenced a removed SvelteKit client entry, so the page never hydrated.
  Starting a fresh dev server removed the stale process but the current
  pnpm/Vite environment still served that client entry as 404. The assertions
  need a clean dependency-normalized, networked run.
- **`vitest.config.ts` only includes `tests/unit/**`.** Increments 1–3 create
  ~12 integration suites that would silently not run. Increment 1 owns this fix.
- **The "Four aces" poker-face sidebar** (Ch7:391-399) — the review's *other*
  privacy citation — is still unimported. It sits under `3. Take turns`, so
  `keepCallouts` there would pull in that section's other callouts too.
- **`deckScope` was removed** with D6. If anything ever genuinely needs a fresh
  deck, it must be re-justified from the book, not from inference.

---

## 7. Suggested order for whoever continues

1. **Do §5 (`invokedFrom`)** before touching the catalog again.
2. **Get the §6.1 rulings** (Fool trigger erratum).
3. **Re-audit every `supported-v1` procedure against its call site.** Treat the
   §6.2 list as a starting point, not an exhaustive one — both reviews found
   issues from samples, so assume more exist.
4. **Only then** proceed to Increment 1 (Foundation), which is the first
   increment to touch the database.

## 8. Standing advice

- **Run an external adversarial review after every content increment.** Not
  optional. Self-review found none of the 27 issues.
- **Never remove a rule for not existing** without grepping the book for the
  mechanic's *effect*, not its noun.
- **Mutation-test every new guard.** Reintroduce the bug; confirm failure.
- **A test that shares the implementation's assumptions proves nothing.** Three
  of mine actively confirmed bugs.
- **"Gate passing" ≠ "rule correct."** Every rules error above sat behind a fully
  green gate.
