# Campaigns & Shared Tarot — Status, Failure Modes, and What's Left

**Date:** 2026-07-16
**Author:** Claude (Opus 4.8), updated by Codex after the Tarot Procedure
Correctness v2 implementation and adversarial review
**Scope:** everything from `177af5b` (Release v0.1.0) through the v2 correctness
bundle

This is a handover, not a progress report. It is written to be useful to whoever
picks this up — including me in a fresh session — so it leads with what went
wrong rather than what got built.

---

## 1. TL;DR

Three increments landed on `main` (0a, 0b, 0.5), followed by two correction
rounds and the Tarot Procedure Correctness v2 bundle. Everything remains **local
and unpushed**. The engine and content pipeline are real and well-tested.

**But two adversarial reviews found 27 issues between them, and the same root
cause produced at least four rules errors — including one where I deleted a real
game rule from the specification after telling the owner the game didn't have
it.** That deletion was approved by the owner on the strength of my false claim.

The structural fix recommended by this handover is now implemented on
`codex/tarot-procedure-correctness-v2`: schema v2 separates definition sources
from every material invocation citation, all 31 supported procedures were
re-audited, the known domain errors were corrected, and the existing Test of
Fate client now executes the required Fool reshuffle. Work still stops before
Campaign Foundation.

---

## 2. Current state

| | |
|---|---|
| Branch | `codex/tarot-procedure-correctness-v2` (isolated worktree; not merged or pushed) |
| `main` | 3 increments + 1 fix round merged, **13+ commits ahead of `origin`, nothing pushed** |
| Tests | 273 passing, 22 files; focused Playwright 8 passing |
| `npm run check` | 0 errors |
| Content drift | 0 across all collections |
| Rules reference | 57 entries |
| Procedure catalog | 31 procedures, 14 oracle tables (194 rows), 8 modifiers, 3 formulas |
| Content pack | v3.0.0, digest-enforced |

### Gates

- **Gate A1 (0a — rules prose):** passing
- **Gate A2 (0b — procedure contract):** superseded by schema v2 and the full
  definition/invocation re-audit. Generated/runtime/CI boundaries are explicit.
- **Increment 0.5 (resolution engine):** complete, including provenance-aware
  success, exact group-test arity, and executable Fool reshuffling; verified in
  a real browser.

### Decision log (`docs/superpowers/plans/…-roadmap.md`)

| ID | Status |
|---|---|
| D1 art permission | Resolved — confirmed by owner |
| D2 oracle scope | Resolved — full lookup |
| D3 spec approval | Resolved — approved |
| D4 Pages vs Workers | **OPEN** — deliberately deferred to Increment 5 |
| D5 no invented rules | Standing rule — the rulebook overrides the spec |
| ~~D6 Signs deck~~ | **WITHDRAWN — my premise was false** |
| D7 rules live at the call site | Standing rule — now enforced by schema v2 `invokedFrom` |
| D8 Fool reshuffle trigger | Resolved — **drawn**, with the lone `played` wording treated as an erratum |

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

Included in the earlier commit containing this handover. The historical list is
preserved because it explains the baseline that v2 corrected.

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

The v2 correctness bundle then completed the follow-on work:

- schema v2 requires `source`, `scope: 'supported-v1'`, and non-empty unique
  `invokedFrom` evidence; the generated audit renders definition and invocation
  locations separately;
- all 31 procedures were re-audited through the five mechanical search families
  against the local vault, while runtime and CI remain vault-independent;
- Challenge now models both decks, hidden GM Initiative, round cleanup, exact
  modifier timing, facedown card rules, and the Fool boundary;
- Crawl/Camp, City, sorcery, and oracle procedures now preserve their filters,
  choices, delayed branches, limits, costs, and mechanical outcomes;
- rules-reference aliases are validated instead of skipped;
- Test of Fate now tracks card provenance, group tests enforce two distinct
  actors and two outcomes, and drawing the Fool executes a card-conserving
  reshuffle of both eligible decks without erasing the visible result; and
- the content pack contract advances to v3.0.0.

---

## 5. Structural fix — implemented

**Add `invokedFrom` to the procedure contract, alongside `source`.**

Every rules error above traces to conflating two different locations:

- `source` — where the table/rule is **printed** (what the audit records today)
- `invokedFrom` — where the book says **how and when to use it** (unrecorded)

For Signs: `source` = Ch9's `## Signs and Portents`; `invokedFrom` = Ch9:130's
City Events XXI paragraph, which is the *only* place stating you consult the
discard top. For Guard: the effect (`Initiative`) is the searchable term, not the
noun (`shield`).

It is now **required** for `supported-v1` entries. The importer rejects missing
or duplicate invocation citations and locally resolves every definition,
invocation, table, modifier, and formula source against the vault. Generated
content and CI use only committed inputs, so the Markdown vault is never read by
the running application.

---

## 6. What's left

### 6.1 Resolved by this bundle

- The owner confirmed the Fool ruling: **drawn** is canonical and `played` is
  treated as an erratum.
- Every previously listed P0/P1/P2 catalog or existing-engine finding is
  corrected and mutation-tested where it guards executable behavior.
- The final independent review found six Important issues and no Critical
  issues. Its findings are resolved: Questing Beast oil and the missing
  Maleficence modes/citations are represented, supplied Fools preserve their
  provenance, all typed table/step references are cross-validated, and Patrol's
  two-encounter condition has explicit source/cardinality semantics.
- The former browser gap is closed: the focused Test of Fate/Fool Playwright
  suite passes against a fresh preview server.

### 6.2 Still deferred

- **D4 — Pages vs Workers.** Still open, blocks Increment 5 only. `wrangler.toml`
  is a Pages config; Increment 5 assumes Workers (`wrangler deploy --dry-run`
  errors; `[[ratelimits]]` type-checks but is `undefined` at runtime).
- **`vitest.config.ts` only includes `tests/unit/**`.** Increments 1–3 create
  ~12 integration suites that would silently not run. Increment 1 owns this fix.
- **The "Four aces" poker-face sidebar** (Ch7:391-399) — the review's *other*
  privacy citation — is still unimported. It sits under `3. Take turns`, so
  `keepCallouts` there would pull in that section's other callouts too.
- **`deckScope` was removed** with D6. If anything ever genuinely needs a fresh
  deck, it must be re-justified from the book, not from inference.

---

## 7. Suggested order for whoever continues

1. Integrate the v2 correctness branch after reviewing its final verification
   and adversarial-review record.
2. Proceed to Increment 1 (Campaign Foundation), which is the first increment
   to touch the database.
3. Keep D4 deferred until Increment 5, as recorded in the roadmap.

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
