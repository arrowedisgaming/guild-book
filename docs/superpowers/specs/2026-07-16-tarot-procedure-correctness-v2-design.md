# Tarot Procedure Correctness v2 — Design

**Status:** Approved in conversation on 2026-07-16

## Goal

Replace the self-consistent but incomplete tarot procedure catalog with a
rule-correct schema and catalog:

- distinguish where a rule is defined from every place that materially invokes
  it;
- re-audit all 31 `supported-v1` procedures against those invocation sites;
- correct every mismatch found during that audit in this bundle;
- fix the existing executable Test of Fate and group-test behavior where the
  audit exposes a real runtime bug; and
- leave campaign persistence, routes, and full phase runners to their planned
  increments.

This is a correctness foundation, not Campaign Foundation. It changes the
authoritative content contract and the existing tarot reference client without
starting database-backed campaign work.

## Owner rulings

### Fool reshuffle trigger

Guild Book treats the lone player-facing sentence that says the Fool reshuffles
the decks when it is *played* as a rulebook erratum.

The canonical rule is:

> When the Fool is drawn, schedule both eligible decks to be reshuffled at the
> procedure's legal boundary, regardless of whether the Fool is played.

This follows Chapter 1 and the detailed GM Challenge cleanup rule, both of which
say *drawn*. The catalog, tests, engine, UI, audit, and handover must use that
interpretation consistently.

### Invocation coverage

`invokedFrom` records every rule-relevant call site, not one representative
example. A call site is rule-relevant when it materially defines:

- when a procedure runs;
- which deck or existing pile it uses;
- what branch or table applies;
- what choice is available;
- what mechanical result follows;
- when a delayed effect is checked; or
- how often or how long the effect lasts.

Incidental mentions, examples that add no rule, and preparation-only references
do not become invocation citations.

## Build-time and runtime boundary

The local Markdown vault is authoring and verification input. It is not
application code and is never read by a running Guild Book application.

```text
Local authoring and verification:
Markdown vault + committed manifest
  -> content importer
  -> generated JSON + generated audit
  -> committed content pack

Application runtime:
committed JSON
  -> Zod validation
  -> application and engine
```

Local `npm run content:verify` proves every declared definition and invocation
citation still resolves in the vault. CI, which does not have the copyrighted
vault, proves that the committed manifest, generated metadata, generated audit,
and content digest agree with each other.

## Schema version 2

`tarot-procedures.json` moves from schema version 1 to schema version 2.

Every supported procedure contains:

```ts
interface TarotProcedureDefinition {
  id: string;
  title: string;
  phase: TarotProcedurePhase;
  scope: 'supported-v1';
  source: TarotSourceRef;
  invokedFrom: [TarotSourceRef, ...TarotSourceRef[]];
  ruleEntryIds: string[];
  steps: TarotProcedureStepDefinition[];
  modifierIds: string[];
}
```

`source` remains the place where a rule, table, spell, talent, item, or action is
defined. `invokedFrom` is a non-empty, duplicate-free list of all material call
sites.

If a rule defines and invokes itself in the same passage, the same
`TarotSourceRef` appears in both fields. This is intentionally explicit: it
states that the invocation was checked rather than treating absence as
equivalent to self-invocation.

Unsupported audit entries may retain only `source`; they do not need invocation
evidence until they become runtime-supported.

### Citation validation

The content importer resolves:

- every supported procedure's `source`;
- every supported procedure's `invokedFrom` entries;
- every lookup-table, modifier, and formula source; and
- all heading, repeated-heading `after`, and bullet `anchor` selectors.

Duplicate invocation references are rejected after normalizing their
`file`/`heading`/`after`/`anchor` fields. Generated runtime content preserves the
manifest order so citations can follow the book's procedure order rather than
alphabetical object order.

The generated audit gains separate **Defined at** and **Invoked from** columns.
Multiple invocation sites render as deterministic line breaks or a stable list
within one table cell.

## Narrow typed correctness vocabulary

Schema v2 adds only concepts required by verified rules. It does not attempt to
be a general-purpose workflow language.

The procedure contract must be able to express:

- conditional branches and mutually exclusive outcomes;
- a choice of one applicable lookup table;
- immediate versus delayed triggers;
- card source selection from draw pile, discard top, discard selection, or a
  mixture of sources;
- card provenance, including an initial deck draw versus a supplied card;
- fixed, filtered, or formula-driven draw counts;
- card-range and suit filters;
- choose-one-from-multiple-draws behavior;
- used-entry depletion or no-op behavior;
- duration and expiration boundaries;
- per-round, per-session, and single-instance limits;
- explicit costs, including Resolve, gold, charges, and action budget;
- explicit mechanical results, including favor, gold, charges, visions, card
  placement, and card movement; and
- the `fool-drawn` reshuffle trigger and its legal resolution boundary.

These concepts may be represented by discriminated unions, typed modifier
parameters, or small procedure-specific definitions. The implementation should
prefer the smallest reusable shape that makes the verified rule unambiguous.
It must not add speculative primitives solely for future convenience.

## Full procedure re-audit

All 31 `supported-v1` manifest entries are re-read from both their definition
and every material invocation site.

For each entry, the audit records:

1. the definition location;
2. every material invocation location;
3. the procedure's legal trigger;
4. deck and card source;
5. draw, choice, filter, and branch behavior;
6. visibility and ownership;
7. mechanical results and costs;
8. timing, duration, and frequency;
9. recovery or boundary behavior; and
10. rule-reference, lookup-table, modifier, and formula links.

Any discrepancy discovered during this pass is corrected in this bundle. The
known review list is a starting checklist, not a completeness claim.

## Required correctness changes

### Tests of Fate and group tests

- A resolution card carries provenance.
- A great success requires a matching-suit card genuinely drawn as the initial
  test card. A card supplied by High Chant, Augury, or another source cannot
  manufacture a great success.
- Augury may supply the initial card while still allowing pre-test Resolve and a
  normal push; the accepted card is not an initial deck draw for great-success
  purposes.
- Augury has explicit accept and decline branches. Declining discards the card
  and preserves Bound by Fate.
- Drawing the Fool schedules both eligible decks for reshuffling at the legal
  boundary.
- Group tests require exactly two distinct selected actors and exactly two
  resolved outcomes. Solo selection and arbitrary result counts are rejected.

### Challenge

- Challenge Initiative covers both player/minor cards and facedown GM/major
  Initiative for each significant enemy or enemy group.
- End-round cleanup names every affected deck and uses the canonical
  `fool-drawn` trigger.
- Brainfever includes favor on Attacks and its lowest-Initiative-card
  restriction.
- Counsel includes its timing, once-per-round transfer limit, suit restriction,
  and Resolve-enabled interrupt use.
- Guardian Angel includes facedown placement, Dodge/Riposte restriction,
  cumulative value, facedown-limit exemption, single-instance limit, target,
  and duration.
- Black Honey preserves the optional five-card deal and teeth consequence
  rather than reducing the rule to an unconditional `+1`.
- Aim retains its facedown target, Swords restriction, later reveal, bow
  requirement, and Attack bonus lifecycle.
- Guard remains a shield-gated, any-suit miscellaneous action that replaces
  public Initiative and discards the old card.

The bundle corrects the authoritative contract and semantic tests. It does not
create the future database-backed Challenge runner.

### Crawl and Camp

- Meatgrinder preserves ordinary-room, moving-carefully, loud-noise, and other
  verified invocation modes with their correct filters.
- Used/depleted Meatgrinder entries are represented so a redrawn used result can
  become a no-op where the rule requires it.
- Camp watch begins with the Meatgrinder draw and only branches into watch
  selection and the Cups test on a random-encounter result.
- Patrol draws twice and chooses one legal non-encounter result.
- Leeches records the Use an Item Camp Action, suit branch, target, and two-charge
  affliction-cure result.
- Area Sense records the two-Resolve-per-watch cost, watch passage, and a number
  of meaningful visions equal to the drawn value.
- High Chant records discard selection, distribution, one-card-per-player
  limit, alternative Challenge/Test-of-Fate use, provenance, and expiration.
- Overland Travel and disposition procedures retain every material call-site
  rule rather than only the table definition.

### City

- City Events records its actual draw/consult invocation and used-entry upkeep.
- Signs and Portents consults the top card of the minor discard pile when City
  Events yields XXI; it does not make a fresh draw.
- Beg & Busk includes the `value + Wands` gold result.
- Carouse retains its major draw and the Hangover table's minor-discard bracket
  convention.
- Doomsaying records four minor draws, left-to-right suit lookup, price, and
  future Resolve refill condition.
- Strange Communions records the once-next-expedition duration and its choice of
  deck top, minor-discard top, or a mixture.
- As Above So Below records a private look at the top three minor cards followed
  by reordering those same cards.

### Sorcery and oracles

- Maleficence selects exactly one table for the appropriate far realm and draws
  once; it never resolves all four tables.
- Malediction draws the curse once, then represents only the result-specific
  delayed 50-percent checks at their actual timing.
- Random Totem retains its table axis and mechanical bonus.
- GM Twist glances at the top of the minor discard pile without consuming it.
- Rules-reference links from procedures and lookup cells are validated instead
  of skipped.

## Existing executable surfaces

Most procedure entries are content for future Campaign runners. The current
executable surfaces are the pure tarot engine, the group-test helper, the
client-side deck store, and the `/deck` reference UI.

This bundle changes those surfaces where current behavior is already wrong:

- `ResolutionCard` gains typed provenance.
- test resolution uses provenance when determining great success;
- group-test selection and resolution enforce exact arity and distinct actors;
- the Test-of-Fate table state owns both the player/minor deck and the
  GM/major deck even though only the player deck is drawn in this reference
  flow, so the Fool rule can actually reshuffle both physical decks;
- the deck store gains an operation that reshuffles eligible remaining
  draw/discard state while preserving the currently displayed result cards;
- Test of Fate schedules and performs the Fool reshuffle without erasing the
  visible result;
- an initial Fool can still be pushed normally from the reshuffled deck; and
- the UI explains the pending/completed reshuffle state.

The Challenge runner will apply the same `fool-drawn` trigger at the Challenge
round boundary when that runner is implemented.

## Test of Fate reshuffle boundary

Calling the existing `reshuffleAll()` immediately would erase the visible test
hand and its result. The reference UI therefore uses a result-preserving
boundary:

1. draw and resolve the card;
2. if the Fool was drawn, mark a reshuffle as required;
3. preserve the visible result card or cards;
4. reshuffle the remaining player/minor draw and discard state and the complete
   GM/major state, without moving the preserved cards;
5. allow a legal push after an initial Fool from the refreshed deck; and
6. when the result is cleared, discard or retire the visible cards according to
   the completed procedure without shuffling them into the already-refreshed
   draw pile.

The pure deck operation must prove card conservation and uniqueness. A card can
never exist in both the visible result and a deck zone.

## Validation and tests

### Contract tests

- schema version is exactly 2;
- every supported entry has at least one invocation citation;
- invocation citations are unique;
- unsupported entries retain rationale and no runtime steps;
- every rule, lookup-table, modifier, and formula reference resolves;
- every typed branch, trigger, limit, cost, result, and provenance value is
  valid; and
- manifest and committed runtime content agree.

### Local vault tests

- every definition and invocation reference resolves;
- headings, repeated headings, and bullet anchors fail loudly when renamed;
- all generated tables still re-extract with zero drift; and
- the generated audit matches a fresh render.

### Semantic tests

Tests name and assert the rule rather than merely checking that an ID exists.
At minimum they cover every correction listed above, including modifier
parameters, branch timing, filters, outcomes, costs, durations, and card
movement.

New guards are mutation-tested where practical: temporarily restore the faulty
shape or value, prove the focused test fails for the intended reason, then
restore the correct content.

### Engine and component tests

- supplied cards cannot create a great success;
- genuine initial deck draws still can;
- a card supplied through the provenance used by Augury is ineligible for great
  success, while the catalog's accept/decline semantic test preserves the Bound
  by Fate branch;
- Fool draws conserve all cards while scheduling/performing both-deck
  reshuffling;
- an initial Fool remains pushable;
- the pushed Fool remains an automatic great failure;
- group tests reject solo or repeated actors and non-two result counts; and
- Test of Fate displays the result and reshuffle cue without permitting
  post-draw declaration changes.

### Browser verification

The focused Test-of-Fate Playwright suite gains Fool and provenance scenarios.
If the known local dependency/preview issue prevents a trustworthy run, the
failure is reported as an environmental gap and is not counted as a pass.

### Independent review

An adversarial code/content review is required before the final code commit.
All Critical and Important findings must be addressed or explicitly brought
back to the owner when a rule decision is required.

## Versioning and compatibility

The procedure schema changes incompatibly from version 1 to version 2. The HMTW
content pack therefore moves from `2.3.0` to `3.0.0` and receives a regenerated
content digest.

No migrate-on-read path is required. Procedure definitions are bundled
reference content, not stored character or campaign records. A consumer either
loads a schema-v2 pack or rejects it during normal Zod validation.

## Delivery structure

Work proceeds on `codex/tarot-procedure-correctness-v2` in the isolated
worktree. Reviewable commits are:

1. this approved design;
2. the implementation plan;
3. schema v2, invocation validation, and generated audit;
4. corrected domain catalog data and semantic tests;
5. live engine, store, component, and browser-test corrections; and
6. final generated pack, version/digest update, audit notes, and handover.

The final implementation is verified with:

```bash
git diff --check
npm run content:verify
npm run check
npm test
npx playwright test tests/e2e/deck-test-of-fate.spec.ts
CONTENT_BASE_REF=<pre-increment-base> node scripts/content-import/verify-pack-version.mjs
```

The final browser command is subject to the explicitly documented environment
gap. All other gates must pass.

## Non-goals

This increment does not:

- add campaign or shared-session database tables;
- add Campaign routes, authorization, commands, reducers, or projections;
- implement the full Challenge, Camp, Crawl, City, or sorcery runners;
- resolve Cloudflare Pages versus Workers deployment;
- import the copyrighted Markdown vault into the application or repository;
- generalize the procedure schema beyond rules actually verified in this
  audit; or
- begin Campaign Foundation before the corrected contract is reviewed and
  committed.
