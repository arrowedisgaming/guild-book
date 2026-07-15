# Review — Campaigns and Shared Tarot Design Specification

**Reviewing:** `2026-07-15-campaigns-shared-tarot-design.md`
**Date:** 2026-07-15
**Verdict:** Strong architecture, correct instincts, **not yet executable.** Four blocking issues and a set of rules-accuracy defects should be resolved before anyone writes code against it.

---

## 1. Summary

This is a well-built specification. The pure-engine boundary, the versioned-snapshot + journal shape, the projection-per-role privacy model, and the content-pack-driven procedure design all match the repository's existing conventions rather than fighting them. The deck split is right, the D1 atomicity claim is right, and the privacy model is the best-supported decision in the document. My criticism below is concentrated, not diffuse — the bones are good.

The problems cluster in three places:

1. **The plan asserts as settled two things the repository records as unsettled** — art permission, and the existence of imported Chapter 6–9 rules content. Both are on the critical path. Both are long-lead.
2. **The plan is normative about game rules and gets several of them wrong** — most seriously the Fool and the Resolve/push relationship. Because §9 pushes all rules into content JSON, a rules error in the spec becomes a content error, an engine error, and a test that asserts the wrong behavior.
3. **The release strategy is all-or-nothing**, gating five increments behind one acceptance suite whose central criterion is unverifiable as written.

### What the plan gets right — and should not be re-litigated

- **Deck split (§7.4)** is correct and already implemented. Ch1:199–214: "The GM uses the major arcana cards *except* the Fool… the GM's deck has 21 cards, numbered I–XXI" / "Players use the minor arcana cards *plus* the Fool." This matches `buildMajorDeck` and `buildPlayerDeck` in `src/lib/engine/tarot-deck.ts:64-75` exactly.
- **D1 atomicity premise (§6.6)** is correct. Cloudflare documents batch as: "Batched statements are SQL transactions. If a statement in the sequence fails… it aborts or rolls back the entire sequence."
- **Seeded, deterministic shuffle** already exists — `makeRng` (mulberry32 + FNV-1a) in `src/lib/engine/rng.ts`, consumed by `shuffleDeck`. No `Math.random` in the engine. §7.4's server-seed design drops straight in.
- **Hidden hands (§2 goal 7, §11)** is well-founded. Ch7:338–340 "No peeking!" — "Nobody but the player can look at the facedown card" — and the "Four aces" sidebar (Ch7:391–399): "The Challenge rules are a minigame; **a poker face is part of that mini-game.**" Worth noting in the doc that hidden *hands* (as opposed to hidden *face-down cards*) is an implication of physical play rather than a stated rule; the conclusion is still right.
- **`guildRosters` (§6.1)** maps cleanly onto Ch3, whose sections are literally: guild name, terms, sigil, marching order, role, current contracts, deeds and Fame. Fame is real (Ch3:126–140, rated 0–5).
- **Deriving roster entries from tenure records** rather than duplicating editable state is the right call and avoids a whole class of drift bugs.

---

## 2. Blocking issues

### B1. The art permission is *assumed*, and the repository says it has not been obtained

This is the most serious problem in the document, because it is stated as settled fact.

- §1: "the repository's **authorized** 80-image source set."
- §13: "The legal review **assumption** for this specification is that permission for this exact 80-image scan set has been obtained."

The repository says otherwise. `scripts/fetch-rwsa-tarot.sh:9-10`:

> Licensing: the 1909 deck is public domain, but these are the site owner's own cleaned-up scans and the page asks for can-I-use requests by e-mail. **Fine for private/dev use; get permission before shipping them in a public build.**

`.gitignore` corroborates: `assets-src/` is excluded as "Source art scans (large, licence-restricted)". And the project's established legal posture is explicitly zero-art — `static/content-packs/hmtw/README.md`: "**No book artwork, logos, or trade dress are reproduced**"; `index.json`'s `license` field repeats it.

So §13 converts an open, third-party-gated blocker into a parenthetical assumption, and then §16 puts the art pipeline on the critical path in Increment 2, with §17.4 asset tests and §18 acceptance depending on it.

**Suggestions:**

1. **Send the permission e-mail today.** It is gated on a stranger's reply and nothing in the plan can compress that latency. Track it as a named risk with an owner, not an assumption.
2. **Decouple art from the feature entirely.** This is the highest-leverage change in this review. `src/lib/components/tarot/TarotCard.svelte` already renders all 78 cards today with pure CSS and Unicode suit glyphs (`⚔ ✦ ❦ ❋`) and a `repeating-linear-gradient` card back — no images at all. The shared table does not need photographic art to be correct, playable, or shippable. Make §13 a **separate, parallel, non-blocking workstream**, and let the `TarotCard` component grow an art-or-glyph switch driven by the presence of `tarot-art.json`. Increment 2 then loses its only external dependency.
3. **Note the cheap fallback.** The 1909 Rider–Waite–Smith artwork is public domain; only steve-p.org's *cleaned-up scans* carry the claim. If permission does not arrive, equivalent public-domain scans (e.g. Wikimedia Commons) sidestep the issue. §13's "explicit source-to-card mapping rather than infer identity only from filenames" is exactly the right design to make that source swap cheap — say so, and make the manifest's `source` field a first-class variable rather than a credit line.

### B2. `tarot-procedures.json` depends on content-import work that does not exist and is not in the plan

§9 is the load-bearing section of the whole design: "All draw counts, deck choices, value tables, Fool behavior, selection rules, and rule references live in a new validated `tarot-procedures.json`." §16 Increment 2 lists "content procedure schema" as a line item.

But the content pack does not currently contain the rules this file must encode. `static/content-packs/hmtw/README.md`:

> **Partial / deferred:** `rules.json` — the browsable rules reference. **Chapter 1 (The Basics) is done as ten verbatim entries; the rest of the book's rules chapters are deferred.**

Chapters 6 (Crawl), 7 (Challenge), 8 (Camp), and 9 (City) — the four chapters this feature is *entirely about* — have never been imported. The project already knows this and left itself a note. `CHANGELOG.md:43-46`:

> TODO: The Elite/Dungeon Lord "draws an additional Challenge card" mechanic is intentionally NOT stored on Appendix C stat blocks — it's a **Chapter 7 hand-size procedure** keyed to threat type. Surface it in the rules reference when Chapter 7 combat content is imported, so it isn't lost.

That TODO is precisely the mechanic §8.6 waves at with "Hand-size and deal-size modifiers read from characters and content." The content does not exist.

Worse, §9's own framing implies this JSON gets hand-authored ("a new validated resource"), which would violate the project's strongest content norm. The README again:

> all prose is **exact wording from the core rulebook, extracted by a script pipeline rather than retyped — diffable and re-runnable**.

`npm run content:build` regenerates; `npm run content:verify` re-extracts and diffs against the committed pack. There are roughly **fifteen substantial verbatim tables** behind §9 — Meatgrinder (21 entries), We're Doomed (I–King), City Events (21), Signs (I–King), Hangover (21), four Maleficence tables (I–King each), Malediction (I–King), Random Totem (a 14×4 grid), Doomsaying, the Ch10 Twist table, and per-creature disposition oracles. Hand-typing those is exactly what the pipeline exists to prevent.

The licensing of this text is *fine* — the Adherent of the Worm licence states "the mechanics and game text of His Majesty the Worm may be reused freely," and `denizens.json` already reproduces Appendix C in full. The problem is purely that the work is large, unestimated, and absent from §16.

**Suggestions:**

1. Add an explicit **Increment 0: import Chapters 6–9** to §16, with `scripts/content-import/manifest/md/` entries, an `md-procedures.mjs` generator, and `content:verify` coverage. Nothing in §9 can start until this lands. Size it honestly — the existing manifest covers nine collections and took a dedicated pipeline.
2. Rewrite §9 to state that `tarot-procedures.json` is **generated by `scripts/content-import/`, not authored**, and is covered by `npm run content:verify` drift checks like every other prose field.
3. Close the `CHANGELOG.md:43-46` TODO as part of that import, and reference it from §8.6.

### B3. The `409` design will produce a conflict storm at a live table

§10.2 makes `expectedSessionVersion` a hard precondition on every command. §10.4 then defines the failure UX:

> A `409` stale-version response does not apply or automatically replay the intent; the client synchronizes, explains that the table changed, and asks the user to retry if the action is still relevant.

Walk the numbers. Every accepted command bumps one global session version. Clients learn about bumps by polling at ~1 Hz (§10.3). During a Challenge round with a GM and eight players, card plays arrive in bursts. Player B's client last synced at v=10; Player A plays a card, taking the table to v=11; Player B plays their own, unrelated card with `expectedSessionVersion: 10` → `409` → "the table changed, please retry."

These two commands do not conflict in any meaningful sense. B is playing a card from B's own hand. But a single global version makes every command conflict with every other command, and the ~1 s polling window guarantees a wide collision surface. The busier the table, the more it happens — which is exactly backwards. §18's acceptance criteria will pass (they test correctness, not contention) and the table will still be miserable to use.

**Suggestion — move the retry to the server, keep correctness:**

The read-then-reduce-then-write cycle genuinely does need compare-and-set to prevent lost updates; that part is right. What is wrong is *surfacing the CAS failure to the user*. The reducer plus §8.2's invariants are the real guard on legality — a command that is still legal against fresh state should simply apply.

```
apply(command, actor):
  for attempt in 1..N:                  # N ≈ 3–5
    state, version = read()             # public snapshot + private rows
    result = reduce(state, command)     # pure; enforces zones, ownership, phase
    if result.rejected: return 4xx      # genuinely illegal — tell the user
    ok = writeGuarded(expected=version, ...)
    if ok: return projection
  return 409                            # lost the race N times; now tell the user
```

Then:
- Treat client-supplied `expectedSessionVersion` as an **advisory staleness hint for the UI**, not a hard precondition — useful for "your view is behind," useless as a lock.
- Reserve hard client-side version pinning for **GM structural commands** (`advance-procedure`, `end-round`, `complete-procedure`), where "the thing I was looking at changed" is genuinely the user's problem.
- Card-level intents are naturally self-checking: "play card X from my hand to initiative" either finds X in the actor's hand in a legal phase or it does not.

This keeps every atomicity guarantee in §6.6 and deletes the failure mode.

### B4. Content-pack version pinning is not implementable as specified

§6.4 pins "Content-pack ID, content-pack version, and procedure schema version… at start." §7.4 promises "The session survives navigation, refresh, disconnect, process restart, and an overnight pause."

But the content pack is not data the server can look up by version — it is **compiled into the deployment bundle**. `src/lib/server/content/loader.ts:1-7` `import`s the JSON directly, specifically because Cloudflare Workers has no filesystem. There is exactly one pack version in any given deploy: whatever was committed.

So a deploy during an overnight-paused session leaves that session pinned to a version the running Worker no longer contains. The pin is a dangling reference that can only be detected, never honoured. Right now `index.json` is `version: "1.0.0"` and nothing enforces a bump, so this will fail silently rather than loudly.

**Suggestions:**

1. Decide the actual policy and write it down. The three real options:
   - **Retain packs.** Bundle historical pack versions under a version key and resolve by the pinned value. Costs bundle size; genuinely honours the pin.
   - **Detect and freeze.** On load, if `session.contentPackVersion !== currentPack.version`, transition the session to `frozen` (§14 already defines this state and the GM's safe end/export path). Cheap, honest, reuses machinery you already need.
   - **Pin only the schema.** Accept that content may shift mid-session, and pin `procedureSchemaVersion` alone so a *structural* break freezes but a typo fix does not.
2. **Recommend option 2** for the first release. It is a handful of lines, it reuses `frozen`, and it converts a silent correctness hazard into a visible operational event.
3. Add a CI check that any change under `static/content-packs/` bumps `index.json`'s `version`. Without it, the pin compares equal across incompatible packs and options 1 and 2 both quietly fail.

---

## 3. Rules-accuracy defects

§9 makes the spec normative about game rules — components "do not encode game rules in conditionals," so whatever the spec says becomes content JSON, engine behavior, and test assertions. These need to be right.

### R1. The Fool — two different rules have been merged into one, and the more important one is missing

§8.4 says:

> The Fool's effect is contextual: During a Challenge, it completes at the end of the round. During another guided procedure, it completes at that procedure's rule-defined boundary. The effect reshuffles the configured major and player draw/discard piles while leaving held and in-play cards untouched.

What §8.4 describes is the **reshuffle trigger**, and for that it is correct — Ch1:214: "Whenever the Fool is drawn, both decks are reshuffled at the end of the round."

But that is not "the Fool's effect." The Fool has two other rules, and the spec models neither:

1. **The Challenge play effect resolves immediately, not at end of round.** Ch7:352–356: "The Fool is not played like other Challenge cards. The Fool has a value of 0 and is always played in conjunction with another card. When you play the Fool, **you get an additional turn**… this counts as an interrupt action. **The Fool _always_ goes first, no matter what.**" This is a turn-order and action-economy rule with no home anywhere in the spec — not in §8.4, not in §8.6's Challenge ownership list, not in §8.3's vocabulary.
2. **Pulling the Fool while pushing fate is an automatic great failure.** Ch1:299–300. §9's Basics row claims "Tests of fate, push, favor, disfavor, group tests, **Fool**" is covered, but §8.4 defines only the reshuffle, so this rule is asserted as covered and specified nowhere. It is also absent from `classifyOutcome` in `src/lib/engine/tarot-resolution.ts` today.

**Suggestion:** split §8.4 into three named rules — `fool.reshuffleTrigger` (end of round / procedure boundary), `fool.challengePlay` (immediate extra turn, interrupt, always first), and `fool.onPush` (automatic great failure) — and give each its own content key, engine branch, and test. Add the extra-turn rule to §8.6's ownership list.

### R2. Pushing fate does not cost Resolve

§8.5:

> Pushing a test never spends Resolve implicitly. The player receives a confirmation showing the exact cost and resulting Resolve. Acceptance issues an atomic command carrying the expected character version; character Resolve and session events update together.

The rules disagree on the premise. Push is **free**:

- Ch1:287 — "If the result of the test is a failure, the player may opt to push fate. **Pull an additional card and add its value** to the original total… You can never achieve a great success if you push fate. If the total result is 13 or less, the test becomes a great failure." No cost.
- Ch1:344 — "You may elect to **spend a point of Resolve _prior_ to a test of fate in order to gain favor**." Favor is +3 (Ch1:330–336), not cumulative, and cancels against disfavor.

So Resolve is a **pre-test favor purchase**, and the spec has attached it to the **post-failure push**. These are different decisions, at different moments, with different UI. As written, the guided test panel prompts for a cost that does not exist and never offers the purchase that does.

This propagates: §17.1 tests "Tests, push, favor/disfavor, group results, and **Resolve confirmation**" as one cluster, and §18 makes "**Resolve is never spent without explicit player confirmation**" an acceptance criterion — a criterion that, against the real rules, is satisfied trivially because pushing never spends Resolve at all.

**Suggestion:** restructure the guided test flow to match the actual sequence:

```
1. declare test (attribute + suit)
2. optional: spend 1 Resolve → favor (+3)     ← the confirmation belongs HERE
   (also: relevant motif → favor; aid → +3; disfavor → −3; favor/disfavor cancel, not stack)
3. draw → total = attribute + card values (+3/−3)
4. success at ≥ 14
5. on failure, optional: push (free) → draw again
   - great success is now impossible
   - total ≤ 13 → great failure
   - drew the Fool → automatic great failure
```

If a Resolve cost on push is a deliberate Arrowed house rule, say so explicitly — the codebase already documents one such ruling (`tarot-resolution.ts:45-49` marks the great-success condition as "an Arrowed ruling"), so there is a precedent and a convention for flagging it. But it must be labelled, not silently specified.

### R3. Favor/disfavor and group tests are new engine work, described as reuse

§8.1 frames the engine work as consolidation:

> The existing `tarot-deck.ts` and `tarot-resolution.ts` functions should be reused or refactored into shared primitives where their behavior matches the rulebook. Campaign code must not duplicate shuffle, value, suit, or test rules.

Reasonable — but §8.5 requires the engine to calculate "card value, suit interactions, **favor/disfavor, group results**," and §9's Basics row and §17.1 both list them. **Neither exists.** `tarot-resolution.ts` exports `classifyOutcome` and `testOfFate` and has no concept of favor, disfavor, or group tests anywhere.

These are core single-player rules being smuggled into a multiplayer spec, where they will be estimated as "refactoring." They are not.

**Suggestion:** call them out as new work in §8.5 and §16, ideally landing them in `tarot-resolution.ts` (with tests, at the existing 90% bar) **before** Increment 2 depends on them. They are also independently useful to `/deck`'s existing `TestOfFate.svelte`, so this is a clean, shippable, standalone slice — good early value with zero campaign risk.

### R4. Five of the eleven "Challenge exceptions" are not Challenge mechanics

§8.6 says these get "typed subprocedures or modifiers" **inside the Challenge procedure**. Verified against the rulebook, the list is miscategorised:

| Named in §8.6 | Actually is | Cite |
|---|---|---|
| Counsel | Ch5 path talent — Challenge-adjacent ✓ | `05:230` |
| High Chant | Ch5 talent, a **Camp Action** producing inspiration cards later spent in a Challenge | `05:238` |
| Guardian Angel | Appendix A **spell** ✓ (Challenge-adjacent) | `11:915` |
| Aim | Ch9 **bow gear** rule ✓ (Challenge-adjacent) | `09:760` |
| Shield initiative | Ch7 + Ch9 ✓ | `07:554`, `09:693` |
| Area Sense | Ch4 wood elf arête talent — a **Crawl** action ("meditate for a watch") | `04:270` |
| Leeches | Ch9 item used via the **Use an Item Camp Action** | `09:619` |
| Augury | Appendix A spell — a **test-of-fate** exception (GM draws instead of the player) | `11:831` |
| Maleficence | Appendix A — a **table**, triggered from several places | `11:195` |
| Malediction | Appendix A spell — a **table** | `11:373` |
| Random Totem | Appendix A — an **optional sub-table of the Totem spell** | `11:603` |

This is not pedantry about sourcing. §8.6 says the Challenge state machine *owns* these. Building Camp actions (High Chant, leeches), a Crawl action (Area Sense), and a test-of-fate exception (Augury) into `challenge.ts` produces exactly the module boundary §15 is trying to avoid, and `src/lib/engine/session/challenge.ts` becomes a junk drawer.

**Suggestion:** re-file them by the procedure they actually modify — Camp, Crawl, test-of-fate, or Challenge — and let §8.3's shared vocabulary (`transfer`, `select-from-discard`, `place-facedown`, `reveal`) carry them. That is what the vocabulary is *for*, and most of these need no bespoke code at all. Note also that Counsel, High Chant, and Guardian Angel all pass cards **between players** — `transfer` needs to be a first-class, privacy-preserving primitive, not an afterthought.

### R5. Lesser and greater dooms are missing entirely — and Appendix C is built on them

The GM's card economy has a two-tier structure the spec never mentions:

- Ch7:667–705 — majors **I–XIV are lesser dooms** (drive standard Challenge Actions, analogous to minors 1–14); **XV–XXI are greater dooms** (trigger monster special abilities). Majors have no suits, so the GM ignores suit-matching on minor actions (`07:371`, `07:705`).
- Appendix C is not a bestiary of static abilities — the stat block *is* card economy (`13:130-190`). "Play a card" and "Discard a card" are defined, distinct terms: playing is **one per turn**; "there are **no limits to the amount of cards the GM can discard per round**." Ability text keys off "lesser doom vs greater doom, **even value vs odd value**."
- Examples: jinn "Discard any card to turn tangible or intangible… does not count towards the one card per turn" (`13:916`); wraith "Discard any card to automatically disengage from _all_ adventurers" (`13:1562`); kelpie "you can always spend any lesser doom card to Dash" (`13:1230`).

§8.6 dismisses this: "Denizen abilities that only use normal Challenge play/discard operations use the generic commands rather than bespoke automation." But "play a lesser doom," "discard any card (unlimited)," and "even value" *are* the generic operations here — and the engine models none of the concepts they need: doom tiers, the play-vs-discard distinction, the one-per-turn play limit against the unlimited discard budget, or value parity.

Also missing: the GM's hand size is a **per-round formula**, not a constant. Ch7:607–635 — draw 3, plus modifiers for enemy count and threat tier, **recomputed every round** ("if the number of enemies decreases, you will draw fewer cards"; worked example: 12 imps vs 4 adventurers = 6 cards). §8.6's "Hand-size and deal-size modifiers read from characters and content" understates a live per-round recalculation, and per **B2** the content backing it does not exist yet (`CHANGELOG.md:43-46`).

**Suggestion:** add a §9 row for the GM card economy, add `doomTier` and `valueParity` to the card/zone model in §8.2, and distinguish `play` from `discard` in §8.3 with their separate per-turn and per-round budgets. This is a genuine gap in the *engine model*, not a content gap — of everything in this review, it is the item most likely to force a redesign if discovered during Increment 3.

### R6. §9's coverage table contradicts §9's own deferral boundary

§9 draws a clean line:

> Preparation-oriented tables in Gamemastering, **City Creation**, and Underworld Creation remain deferred even if they also use tarot. The boundary is the moment of use.

Then the City row requires **Doomsaying**, **Strange Communions**, and **Stargazing** — all three of which are **Appendix D (City Creation)** content, specific to districts of the *sample* city, not core Ch9 rules:

- Doomsaying — `14:806`, a district's Special City Action.
- Strange Communions — `14:1050`, Church of the Snake Special City Action.
- "Stargazing" — `14:1066`, actually named "**As above so below**," at the Sidereal House.

The same row lists **Job Board**, which is not a procedure at all — just flavor in Ch9's "Example Contracts" (`09:400`): "Draw ~5 cards to create a job board." That is GM prep, which §9 explicitly defers.

**Suggestion:** drop Job Board. For the Appendix D trio, pick one and state it: either they are in scope (and Appendix D is partially in scope, so say which parts), or they are deferred with the rest of Appendix D. They are also good evidence for a **content-pack-extension seam** — sample-city districts are exactly the kind of thing §19 should leave a seam for.

### R7. §18's central acceptance criterion is unverifiable

> Challenge, Crawl, tests, Camp, in-session City, sorcery, oracle, and generic table procedures **cover all in-session tarot use found in the imported Markdown rules.**

Nobody can prove this, and nobody can test it. It is an unbounded claim over 19 Markdown files. A targeted read already found at least ten in-session tarot procedures the §9 table misses:

1. **Camp watch oracle** (`08:177`) — "look at the top card of the minor arcana discard pile: the suit displayed corresponds to the path" to pick who is on watch, followed by a Cups test; failure means the guild is surprised, asleep and unarmored. §9's Camp row covers neither the oracle nor the test.
2. **Stun → discard a Challenge card** (`01:527`) — "When Stunned, immediately choose and discard a Challenge card from your hand." Cumulative via Stinking Cloud (`11:442`): "draw 1 fewer card at the beginning of the round."
3. **Black honey → draw 5 instead of 4** (`06:489`) — an affliction that overrides the Challenge deal rule.
4. **Brainfever → forced-lowest Initiative** (`11:302`) — "they must always play the lowest-value card they draw for their Initiative."
5. **Ch10 Twist table** (`10:352-370`) — "Glance at the top of the minor arcana discard pile" for a mid-Challenge complication. An in-session Challenge procedure living outside Ch7.
6. **Ch10 random-target oracle** (`10:189`) — target "the player whose path matches that suit," disambiguated by card value. §9's "random target" row is much thinner than the actual rule.
7. **Overland Travel** (`08:223-241`) — an optional phase loop with its own Meatgrinder draws, outside the Crawl/Camp structure.
8. **Deck-exhaustion reshuffle** (`07:592`) — "If either the players or the GM must draw cards but there are not enough remaining, shuffle the discard pile and continue." **Distinct from the Fool reshuffle**; §9's single "reshuffle" cell conflates them, and §8.4 only defines the Fool one. (Good news: `drawWithReshuffle` in `tarot-deck.ts:100-123` already implements exactly this.)
9. **Per-creature disposition oracles** (`13:860`, `13:1130`) — bespoke per-monster variants beyond the generic Ch6 disposition table.
10. **Non-tarot randomizers** — several rules call for a flat "50% chance" (`06:338`, `06:356`, `11:385`) with no card method specified. A tarot-only procedure vocabulary cannot express these; §8.3 has no random primitive.

Also: §9's "Session setup" row implies a draw. There isn't one — Ch1:210 is just "separate the minor and major arcana into the two separate decks and shuffle each," and Ch1:82–94's "Before play" has no tarot procedure at all, only a discretionary Resolve award for a good recap.

**Suggestion:** replace the criterion with an **enumerated, versioned checklist**. Do the audit once, as a deliverable — a `docs/` table of every in-session tarot procedure with chapter and line cite, each marked supported / deferred / not-applicable. Then §18 reads: "every procedure marked *supported* in `tarot-procedure-audit.md@v1` has a passing engine test." That is provable, reviewable, and honest about the tail. It also naturally absorbs the "50% chance" cases as explicitly not-applicable rather than silent gaps.

Ch1:212 is worth quoting in §9 as design justification, incidentally: two discard piles are maintained deliberately because "certain rules will call for you to look at the **top card of a discard pile**." That single fact is load-bearing for at least eight of the oracles above, and §8.2's "public pile tops" is the right response to it.

---

## 4. Significant design issues

### D1. `expectedCharacterVersion` does not exist, and the existing mechanism is weaker than the spec assumes

§10.2's envelope carries `expectedCharacterVersion?: number`, and §6.6 item 5 folds character mutations into the guarded batch.

There is no version column on `characters` (`src/lib/server/db/schema.ts:55-78`). The existing optimistic-concurrency mechanism is `expectedUpdatedAt` — an epoch-ms timestamp compared on PUT (`src/routes/api/characters/[id]/+server.ts:52-89`) — and it writes back a monotonically-advancing `updatedAt` at **second precision** (`:84-89`). Two writes within the same second are indistinguishable.

§16's migration list adds "the denormalized character life column" and says nothing about a version column.

**Suggestions:**

1. Add `characters.version INTEGER NOT NULL DEFAULT 1` in the same forward-only migration as `lifeStatus`, bump it on every write, and list it in §16.
2. Decide what happens to the existing `expectedUpdatedAt` callers — run both for a release, or migrate them. Either is fine; leaving two concurrency schemes on one table is not.
3. **Reconsider coupling character writes into the session batch at all.** A player editing their sheet in another tab bumps character state; under §10.4 their teammate's Resolve spend then 409s for reasons neither can see. If **B3**'s server-side retry is adopted this mostly dissolves, but the narrower the coupling, the better. The only genuinely coupled mutation is the Resolve spend — scope the character precondition to `resolve.current` rather than the whole document.

### D2. The `BEFORE INSERT` + `RAISE(ABORT)` trigger is unnecessary complexity

§6.6:

> The guard must fail the transaction, not merely update zero rows. A small guard table and `BEFORE INSERT` trigger using SQLite `RAISE(ABORT, ...)` is the expected implementation technique.

The diagnosis is exactly right — `UPDATE … WHERE version = ?` affecting zero rows is not an error, so D1's batch happily commits the rest. But the prescribed cure is heavier than needed, and Cloudflare's D1 docs do not document trigger support either way, so this bets the atomicity model on an unverified platform feature.

**A constraint violation is already a statement failure, and already aborts the batch.** So make the version claim a unique-index insert:

```sql
-- add to the sessionCommands table you are already writing:
CREATE UNIQUE INDEX session_commands_version_claim
  ON session_commands (session_id, resulting_version);
```

Two concurrent commands both read v=5 and both try to write `resulting_version = 6`. One inserts; the other violates the unique index, the statement fails, and D1 rolls the whole batch back — which is precisely the documented behavior ("If a statement in the sequence fails… it aborts or rolls back the entire sequence"). No trigger, no guard table, no `RAISE`, no extra row. It composes with the `(sessionId, commandId)` idempotency key you already have on the same table, and it behaves identically on better-sqlite3 and D1 — which makes §17.2's "equivalent behavior on both backends" test meaningful rather than aspirational.

Worth noting: local D1 (miniflare) and production D1 can differ on edge-case semantics, so §17.2's "local D1" tests do not fully derisk this. A unique-index constraint is standard SQLite that behaves the same everywhere; a trigger is exactly the kind of thing that might not.

### D3. Polling economics — the free tier is out, and the load test measures the wrong axis

§10.3 specifies ~1 sync request per second per mounted client, and §17.4 load-tests one GM plus eight players. Against Cloudflare's published limits:

- **Workers Free is 100,000 requests/day.** Nine clients × 1 Hz × a four-hour session = **129,600 requests — one session exceeds the daily free-tier cap.**
- **Workers Free allows 10 ms CPU per request.** A command reads the public snapshot plus up to nine private rows, Zod-validates them, reduces over 78 cards, and writes a batch. That will not fit in 10 ms. (Paid defaults to 30 s.)
- **D1 is single-threaded per database.** Every no-change poll still costs at least one query to learn the campaign's max cursor. Nine clients per campaign is ~9 queries/second **per active campaign**, all serialized against one database.

That last point is the real issue. §10.3 says "There is no hard eight-player product cap," and §17.4 tests eight players in one campaign — but players-per-campaign is not the scaling axis. **Concurrent campaigns** is. Ten simultaneous tables is ~90 queries/second of pure "nothing happened," before any actual commands, against a single-threaded D1. The specified load test will pass and tell you nothing about the ceiling you will actually hit.

**Suggestions:**

1. State the **Workers Paid plan as a hard requirement** in §16's Enablement increment. It is $5/month and the design does not work without it. Better to write it down than discover it at launch.
2. **Change §17.4's load test axis** to N concurrent campaigns × 9 clients, and find the knee. Keep the single-campaign latency test for the 2-second target, but stop calling it load verification.
3. **Pause polling on `visibilitychange`.** §10.3 polls "while the table route is mounted" — a player who leaves a tab open overnight burns 86,400 requests doing nothing. This is a five-line fix.
4. **Make the interval adaptive**: ~1 s while a procedure is active, 3–5 s while idle. The 2-second visibility target only matters when something is happening.
5. **Make the no-change poll not touch D1.** A short-TTL cache of the campaign's latest cursor (KV, or even a Worker-isolate-local cache with a 1 s TTL) turns the common case into zero database work. This is the single highest-leverage change to the sync design.

### D4. The Durable Objects non-goal is doing a lot of unacknowledged damage

§3 rules out "Real-time WebSockets, Cloudflare Durable Objects, or peer-to-peer state synchronization." §19 lists DO transport as a later seam.

But look at what that non-goal costs. A Durable Object is a **single-threaded actor with exclusive ownership of its state** — which is, almost exactly, "a campaign has at most one active play session, commands must serialize, and state must stay consistent." Adopting one would make **B3** (version conflicts), **D2** (the CAS guard), and **D3** (polling economics) largely evaporate: serialization is free inside the actor, and WebSocket hibernation replaces the polling design outright.

Instead, §6.6, §10.3, §10.4, and §14 are each partly dedicated to reconstructing those properties on top of a stateless Worker and a shared D1. And §19's framing — that DO is a later "seam" — understates the switch: the atomicity adapter and the entire polling/cursor infrastructure would be thrown away, not extended.

To be clear, **the non-goal may well be right.** Avoiding DO's pricing, avoiding deeper Cloudflare lock-in against a local-SQLite dev story, and staying on machinery the team already runs are all real reasons. But the document does not give a reason — it just asserts the constraint, and readers cannot tell whether the cost was weighed.

**Suggestion:** add a short subsection to §3 or §5 stating *why* DO was rejected, and what it would have bought. If the reason turns out to be thin, this is the one decision in the document worth revisiting before Increment 2, because it is the only one that gets more expensive to change with every increment.

### D5. Players can be soft-locked out of their own characters indefinitely

Three rules compose badly:

- §7.2 — "During an active session… A living adventurer cannot be voluntarily detached or replaced."
- §7.3 — "A player may leave only when no session is active."
- §6.3 — "At most one active tenure for a character across all campaigns."
- §7.4 — the session "survives navigation, refresh, disconnect, process restart, and an overnight pause."

A GM who starts a session and never ends it — through neglect, a dead campaign, or a falling-out — traps every player in the campaign **and** globally locks each of their characters out of every other campaign. There is no timeout, no player-side escape, and no admin path. Sessions are explicitly designed to persist indefinitely, so this is not an edge case; it is the natural end state of any abandoned campaign.

**Suggestion:** the mechanism already exists. §7.3's GM-removal path performs "an audited cleanup command that returns the removed user's private cards to their owning draw pile and shuffles that pile, logging counts but no identities," resolves public cards through configured destinations, and ends the tenure. That is precisely what a player-initiated leave needs.

1. Let a player leave during an active session using that same cleanup command, with `endReason: 'left'`.
2. Add a session inactivity expiry (say, 24 hours with no accepted command → auto-end, or transition to `frozen`), which also bounds the private-secret retention window that §6.5 and §7.4 care about.

Either fixes it; both is better.

### D6. The idempotency response envelope is a second copy of every secret

§6.5 has `sessionCommands` store "a private response envelope used only to replay a duplicate request during an active session," purged at session end.

This works, but it means player card identities live in **two** places during play: `sessionPrivateStates` (whose entire purpose is holding secrets, with the projection discipline to match) and `sessionCommands` (an audit table, described in the same section as holding "non-secret audit metadata"). §11's leak surface doubles, and the second copy sits in the table an operator or a debug endpoint is most likely to dump wholesale.

**Suggestion:** do not store it. On a duplicate `commandId`, return the recorded outcome status plus the actor's **current projection**, freshly computed. For a draw, the original response said "you drew the Three of Cups" — and the current projection already shows the Three of Cups in that player's hand. The replay is equivalent, the secret never gets a second home, and §14's "end-session must purge secret-bearing idempotency response fields" step disappears along with a whole class of purge bugs.

If there is a case where the original response is genuinely not recoverable from current state, name it in the spec — that would be the justification, and right now it is missing.

### D7. The integrity digest and the shuffle commitment need a stated threat model

Two claims sit uneasily together:

- §6.5 / §7.4 — an `integrityDigest` "over the ordered public history and final public state."
- §7.4 — "Ending the session purges any value that could reconstruct an unrevealed card identity; only a **one-way commitment** may remain in the public integrity record."

The digest is stored unsigned in the same database as the data it attests. Against the only party who could tamper — an operator with database write access — it provides nothing, since they can recompute it. §3 already concedes "no end-to-end encryption against database operators," which is the honest position; the digest quietly implies a stronger one.

The commitment is more concretely wrong. A shuffle commitment proves fairness **only if published before play begins** — commit to the seed at session start, reveal the seed at session end, and anyone can verify the shuffle was not manipulated mid-session. A commitment that first appears in the record *at the end* proves nothing at all; the server could have chosen the seed after seeing what it wanted.

**Suggestions:**

1. If you want provable-fair shuffling, do proper commit–reveal: publish `H(seed || salt)` in a public event **at session start** (§7.4's session-start list), reveal `seed` and `salt` at session end, and document the verification steps.
2. Otherwise, drop the commitment and call the digest what it actually is: **corruption detection**, protecting against accidental data damage, not adversarial tampering. That is a legitimate and useful thing to have — it just needs an honest label.
3. Either way, state the threat model in §11. As written, both features read as security theatre, which is worse than not having them.

---

## 5. Smaller corrections

- **§8.3 vocabulary vs §9's table.** §9 lists **mulligan** and **reshuffle** under Challenge; neither appears in §8.3's fourteen commands nor in §8.6's ownership list. Given the mulligan rule is driven by the lesser/greater doom split (**R5**), this is likely a symptom of that gap rather than an independent omission.
- **§8.3 has no random primitive.** Needed for the "50% chance" rules (`06:338`, `06:356`, `11:385`). Add one, or explicitly declare them GM-adjudicated.
- **Frozen vs active for archival.** §6.4 — "A partial unique index allows only one active **or frozen** session per campaign." §7.3 — "The GM may archive a campaign only when no session is **active**." Is a frozen session active for archival purposes? §14 gives the GM a "safe end/export path" for frozen sessions, which implies archival should wait — but the text does not say. One sentence fixes it.
- **Request hash canonicalization is unspecified.** §6.5 — "Reusing a command ID with a different request hash is rejected." Hash of what, exactly? Raw bytes, or canonical JSON? If a client serializes object keys in a different order on retry, a legitimate retry gets rejected as a hash mismatch — a bug that will be rare, non-deterministic, and horrible to diagnose. Specify canonical JSON with sorted keys, or hash the validated-and-normalized command rather than the raw body.
- **The existing rate limiter does not work on Workers.** §11 — "Command and invitation endpoints receive conservative request throttling." `src/hooks.server.ts` has an **in-memory** per-IP+path limiter (60 writes/60 s on `/api/`, bucket cap 4096). In-memory state on Workers is per-isolate and per-region, so the effective limit is unpredictable and much weaker than it reads. Note this in §11 rather than inheriting a false sense of protection. (It does not block the sync poll — that is a GET — but it does govern the command endpoint.)
- **404-not-403 convention.** §11 defines a capability service but does not state the response convention. The existing code deliberately returns **404** for non-owned rows (`api/characters/[id]/+server.ts:20,67,114`) so ownership is not leaked by status code. The campaign capability service should say it does the same — this matters more for campaigns, where a join token makes campaign IDs semi-guessable.
- **Migrate-on-read and the `lifeStatus` column can drift.** §6.3 — "Character JSON remains the canonical character record, and updates to both representations occur atomically." True for characters that get written. But `migrateCharacterData` (`src/lib/engine/character-migration.ts:20-76`) is merge-over-blank-base and only materializes new fields **on read**, stamping `schemaVersion` unconditionally without version-stepped branching (`:44`, with a header note that stepped transforms go there later). A character never re-saved has the backfilled column and no `life` key in its JSON. Harmless if the migration always supplies the default — but §16 should say so, and the v2→v3 step is the first real test of that "add stepped transforms here" note.
- **"Stargazing" is not its name.** §9's City row — the Appendix D procedure is called "**As above so below**" (`14:1066`). If it stays in scope after **R6**, use the book's name; the content pipeline diffs against book text.
- **The Fool is never "card 0" or "card XXII".** §8.2's "each of the 78 tarot cards has one stable content-pack card ID" is fine, and `index.json` already keys it `fool` with value 0. Just don't let the procedure schema introduce a positional number for it — the rules only ever give it a *value* of 0 (Ch1:203), never an index, and XXII appears nowhere in the book.
- **Hold a Funeral.** Ch7:850–868 — when an adventurer dies, guild-mates can use the **Hold a Funeral** City Action to transfer a portion of the dead adventurer's XP to a new one. That is a campaign-scoped, cross-character mutation touching exactly the tenure/death model §6.3 defines. Almost certainly out of scope for the first release — but §6.3 or §19 should name it, because it is the one place where death has consequences beyond ending a tenure, and the seam is cheaper to leave now than to cut later.
- **§12 references an approval the document does not contain.** "The active table uses the approved **Table First** layout." The header says "incorporating the approved product design," but §20's source list has no link to that brainstorm or decision record. Add it — otherwise the rationale for the layout is unrecoverable in six months.
- **§16's "unlinked feature gate" needs a server half.** "The work lands behind an unlinked campaign feature gate. The existing navigation does not expose campaigns until the acceptance suite passes." Unlinked routes are still routable. Given §11's threat model, the gate should be enforced server-side (env flag checked in the capability service), not just by omitting nav links.

---

## 6. Recommended restructure of §16 and §18

The current plan gates five increments behind one acceptance suite, and §18's fourteen criteria must **all** hold before navigation is enabled. Nothing reaches a user until everything works — on a feature this size, that is a long time with no feedback, and the riskiest items (the Challenge state machine, the doom economy, art permission) are precisely the ones you learn most from shipping early.

Increments 1 and 2 already deliver a real, usable product: a campaign you can create and join, a shared table with authoritative decks, generic audited card commands, and tests of fate. That is genuinely valuable without a single line of Challenge code — and Challenge is where the entire risk is concentrated.

**Suggested changes:**

1. **Make the gate per-increment, not global.** Ship Increment 2 to real tables behind a flag. §8.3's generic vocabulary plus §9's content-driven procedures already cover most of what a table needs; the guided Challenge machine is the expensive tail. Let real GMs run real sessions with generic controls while Increment 3 is built — they will find things the acceptance suite cannot.
2. **Split §18 by increment.** Each increment gets criteria it can actually satisfy. The privacy criteria ("The GM cannot obtain a player's private card face through any supported application response or rendering path") and the correctness criteria ("Every accepted command is idempotent, version-checked, invariant-safe, atomic, and auditable") should gate **Increment 2** — they are foundational and cheap to hold to from the start. The Challenge and coverage criteria gate Increment 3 and 4.
3. **Add Increment 0 (content import, per B2)** and **move the art pipeline out of Increment 2 into a parallel track (per B1).** Between them, this removes both of Increment 2's external dependencies.
4. **Land favor/disfavor and group tests early (per R3)**, as a standalone slice against `tarot-resolution.ts` and the existing `/deck` route. Real value, zero campaign risk, and it de-risks §8.5.
5. **Replace §18's coverage criterion with the enumerated audit (per R7).**

A revised sequence:

| # | Increment | Gates on | External deps |
|---|---|---|---|
| 0 | Import Ch 6–9 into the content pack; `tarot-procedures.json` generator + `content:verify` | Content drift tests pass | — |
| 0.5 | Favor/disfavor + group tests in `tarot-resolution.ts`; wire into `/deck` | Engine tests, 90% | — |
| 1 | Schema, character life + version migration, membership, invites, roster, capabilities, empty session lifecycle | Service + authz tests | — |
| 2 | Decks, projection privacy, sync, generic commands, tests of fate, Crawl | **Privacy + correctness criteria.** Ship behind flag to real tables | — |
| 3 | Challenge state machine, doom economy, private hands, round flow, exceptions, death replacement | Challenge criteria | — |
| 4 | Camp/City/sorcery, history + purge, corrections, recovery, archival, a11y | Coverage criteria vs the audit | — |
| ∥ | **Art pipeline** (parallel, non-blocking) | Asset tests | **Permission e-mail** |
| 5 | Enablement: migration verification, Cloudflare build, full suite, legal review, nav | All of the above | Workers Paid plan |

---

## 7. Verification notes

Everything above was checked against the repository and the rulebook rather than reasoned from the document alone.

**Confirmed accurate in the spec:** the I–XXI / minors+Fool deck split (Ch1:199–214, and `tarot-deck.ts:64-75`); D1 `batch()` rollback-on-failure semantics (Cloudflare D1 docs); the hidden-hand premise (Ch7:338–340, Ch7:391–399); the Ch3 guild roster field list including Fame (Ch3:126–140); the existence of a seeded deterministic shuffle (`rng.ts`, `tarot-deck.ts:78-81`); `drawWithReshuffle` already implementing the deck-exhaustion rule (`tarot-deck.ts:100-123`); the completed-character predicate (`src/lib/server/validation/character.ts:17-59`); `characters.isArchived` (`schema.ts:68`); the unused `guilds`/`guildMembers`/`guildDraws` tables (`schema.ts:80-83`, "schema-only; multiplayer UI deferred to a later phase").

**Contradicted by the repository:** art permission (`scripts/fetch-rwsa-tarot.sh:9-10`; `.gitignore`; `content-packs/hmtw/README.md` "No book artwork… reproduced"); Chapters 6–9 rules content exists (`content-packs/hmtw/README.md` "the rest of the book's rules chapters are deferred"; `CHANGELOG.md:43-46`); `expectedCharacterVersion` (`schema.ts:55-78` has no version column; `api/characters/[id]/+server.ts:52-89` uses second-precision `expectedUpdatedAt`); favor/disfavor and group tests exist (`tarot-resolution.ts` has neither); content-pack versions are resolvable at runtime (`server/content/loader.ts:1-7` imports and bundles).

**Contradicted by the rulebook:** the Fool's effect (Ch1:214 reshuffle vs Ch7:352–356 immediate extra turn vs Ch1:299–300 push→great failure); push costing Resolve (Ch1:287 push is free; Ch1:344 Resolve buys pre-test favor); five of eleven "Challenge exceptions" (see R4's table); the Appendix D City procedures against §9's own deferral rule (`14:806`, `14:1050`, `14:1066`); Job Board as a procedure (`09:400`); complete in-session coverage (ten counterexamples in R7).

**Platform limits used in D3:** Workers Free = 100,000 requests/day and 10 ms CPU per request; Workers Paid = unlimited requests, 30 s default CPU; D1 query concurrency is single-threaded per database. All from Cloudflare's published limits pages.

**Not verified:** whether D1 supports SQLite triggers and `RAISE(ABORT)` — Cloudflare's D1 documentation does not address it either way, which is itself the argument for D2's constraint-based alternative.
