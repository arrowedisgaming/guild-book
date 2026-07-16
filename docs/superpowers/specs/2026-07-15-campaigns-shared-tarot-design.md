# Campaigns and Shared Tarot — Design Specification

**Status:** **Approved 2026-07-15** by the project owner, after the written-spec review, the plan-amendment round, and the Increment 0a rules import.

**Date:** 2026-07-15

**Amendments since approval** are marked inline and recorded in the roadmap's Decision Log (`docs/superpowers/plans/2026-07-15-campaigns-shared-tarot-roadmap.md`). This document stays normative: where a plan and this specification conflict, stop and amend the plan. Where this specification and the **rulebook** conflict, the rulebook wins and this document is amended — see Decision D5. Two such corrections are already recorded in §8.7.

**Target:** Guild Book, SvelteKit monolith on SQLite/D1

## 1. Summary

Guild Book will add a campaign area where one GM can create and own a campaign, share a persistent join link, accept signed-in players immediately while the link is open, and maintain one in-world Guild Roster. Each player may attach one completed adventurer they own. An adventurer may be active in only one campaign globally, and a player may have no more than one active adventurer in a campaign.

The campaign's primary play surface is a server-authoritative shared tarot table. It implements every tarot operation required during an active session, with guided flows for the Challenge and Crawl phases and reusable procedures for the remaining in-session rules. The interface deliberately stops short of being a virtual tabletop: it manages cards, ownership, visibility, procedure state, and the small number of values needed to resolve tarot rules, but it does not model maps, positioning, wounds, inventory consumption, gold, or narrative consequences.

The 78 Rider–Waite–Smith card faces and two card backs in the repository's authorized 80-image source set will be processed into responsive production assets. Cards appear uncropped in an archival frame so the original border and artwork remain visible. A card identity that is private to a player is never included in the GM's or another player's server response, rendered HTML, DOM attributes, image URLs, accessible labels, logs, or error messages.

## 2. Goals

The first release must let a table:

1. Create, join, view, archive, and manage a campaign.
2. Maintain a separate in-world Guild Roster within that campaign.
3. Attach, replace, release, and mark adventurers dead under the agreed campaign rules.
4. Start and end one persistent play session at a time.
5. Share the correct major and minor tarot decks across all connected participants.
6. Run every v1-supported procedure in a versioned, cited audit of in-session tarot use, including Challenges, exploration, tests, Camp, City, sorcery, and cross-cutting card modifiers.
7. Preserve private hands and face-down cards even from the GM.
8. Recover cleanly from refreshes, reconnects, duplicate submissions, stale clients, and transient network failures.
9. Retain an auditable public session history without exposing private card faces after the session.
10. Work with both local SQLite and production Cloudflare D1.

## 3. Non-goals

The first release does not include:

- GM preparation generators for cities, dungeons, the Underworld, denizen encounters, treasure, or adventure seeds.
- Maps, tokens, measured movement, spatial positioning, fog of war, voice/video, chat, or a general-purpose virtual tabletop.
- Automatic application of wounds, conditions, inventory changes, equipment damage, gold, or fictional consequences.
- Co-GMs, GM transfer, spectators outside the campaign, or multiple simultaneous GMs.
- Campaign deletion. Campaigns may be archived read-only.
- Real-time WebSockets, Cloudflare Durable Objects, or peer-to-peer state synchronization.
- Automating rules that specify a flat random chance without using tarot; those remain GM-adjudicated and are marked not applicable in the tarot-procedure audit.
- End-to-end encryption against database operators. Privacy is an application authorization guarantee: the GM and other players cannot receive a player's private card identities.
- Destructive migration or repurposing of the existing unused `guilds`, `guildMembers`, and `guildDraws` tables.

The existing standalone `/deck` utility may reuse the upgraded card renderer and artwork, but it remains local utility state and is not an authoritative campaign session.

The first release deliberately keeps the existing SvelteKit + SQLite/D1 deployment model instead of introducing Durable Objects. A per-session Durable Object would serialize commands and make hibernating WebSockets possible, but it would add Cloudflare-only state and replace the local SQLite persistence/synchronization path. The v1 design accepts an internal compare-and-set retry loop and polling in exchange for local/production parity and lower operational complexity. The sync and repository interfaces remain isolated so this decision can be revisited if the multi-campaign load gate fails before public enablement.

## 4. Terminology

- **Campaign:** The application container owned by one GM. It contains membership, invite settings, the Guild Roster, adventurer tenures, play sessions, and history.
- **Guild Roster:** The single in-world guild record inside a campaign: name, sigil description, terms, marching order, roles, contracts, deeds, Fame, and the active/historical adventurer roster.
- **Member:** A signed-in non-GM user who joined the campaign.
- **Adventurer tenure:** The interval during which one character is the member's active adventurer in a campaign.
- **Play session:** A GM-started, persistent period of shared tarot play. A campaign has at most one active play session.
- **Procedure:** A guided tarot interaction such as a test of fate, Crawl draw, Challenge round, or oracle draw.
- **Public state:** State visible to every current campaign participant.
- **Private state:** Card identities and other procedure values visible only to one authorized user.
- **Command:** A validated user intent that the server evaluates against the latest durable session state. Only structural commands require the client to pin the exact state they observed.
- **Event:** An immutable audit record emitted by an accepted command or campaign lifecycle change.

## 5. Architectural shape

The campaign table uses a versioned snapshot plus an append-only command/event journal.

```mermaid
flowchart LR
    UI["Svelte table UI"] -->|"command + commandId + observed version"| API["SvelteKit command endpoint"]
    API --> AUTH["Authentication and campaign authorization"]
    AUTH --> REDUCER["Pure session command reducer"]
    REDUCER --> INV["Card and procedure invariants"]
    INV --> TX["Atomic persistence adapter"]
    TX --> SNAP["Versioned public/private snapshots"]
    TX --> JOURNAL["Append-only event and command journal"]
    SNAP --> PROJECT["Role-specific projection"]
    JOURNAL --> PROJECT
    PROJECT -->|"cursor polling or command response"| UI
```

The browser never determines the authoritative shuffle, draw, rule result, or card destination. It sends intent. The command service reads the latest state, a pure engine function validates the intent and returns the next state and events, and the persistence adapter attempts one atomic version claim plus snapshot/event write. If an unrelated command wins that claim, the server reloads and reduces the intent again. Only a command that becomes illegal, a structural command whose observed state changed, or repeated contention is surfaced to the user.

This design provides cheap reads and straightforward recovery without relying on client determinism. The event journal is an audit and synchronization source, not the only way to reconstruct current state in the first release.

## 6. Domain and persistence model

All IDs are opaque generated IDs. All timestamps are stored in UTC. JSON columns have a schema version and are validated with Zod at every application boundary. Table and column names below are normative at the domain level; the implementation plan may adapt exact Drizzle syntax to existing repository conventions without changing their meaning.

### 6.1 Campaigns

`campaigns` stores:

- `id`
- `ownerUserId` — the sole GM and immutable owner in the first release
- `name`
- `description`
- `inviteTokenHash` — lookup/revocation hash; the raw token appears only in the share URL
- `inviteNonce`, `inviteVersion` — inputs for reproducing the current signed link for the authorized GM without storing the raw token
- `joinOpen`
- `archivedAt`
- `createdAt`, `updatedAt`

Only the owner can change campaign metadata, invite state, Guild Roster content, session lifecycle, or GM-only table controls. The owner is not a player membership and cannot attach an adventurer.

`guildRosters` has a one-to-one `campaignId` and stores a versioned document containing:

- Guild name and sigil description
- Terms
- Marching order
- Guild roles
- Contracts
- Deeds
- Fame

The GM edits this shared document; every current member can read it. Active and historical adventurer entries are derived from tenure records rather than duplicated as manually editable roster data.

### 6.2 Membership

`campaignMembers` stores:

- `id`, `campaignId`, `userId`
- `joinedAt`
- `leftAt`
- `removedAt`, `removedByUserId`

A partial unique index permits only one active membership for a user in a campaign. Rejoining after a voluntary departure creates a new membership record so prior tenure and audit history remain stable.

Membership and adventurer attachment are separate. A player can join with no adventurer, observe a live session, and attach an eligible adventurer later under the session rules below.

### 6.3 Adventurer tenures and death state

`campaignAdventurerTenures` stores:

- `id`, `campaignId`, `membershipId`, `characterId`
- `startedAt`, `startedByUserId`
- `endedAt`, `endedByUserId`
- `endReason`: `replaced`, `left`, `removed`, `died`, or `corrected`
- `deathSessionId` when death occurred during play

Two database constraints enforce the central ownership rules:

- At most one active tenure for a membership.
- At most one active tenure for a character across all campaigns.

An adventurer is eligible for attachment only when it:

- Is owned by the attaching user.
- Passes the existing completed/finalized character predicate.
- Is alive.
- Is not archived.
- Has no active campaign tenure.

The character document gains a versioned life record:

```ts
type CharacterLife =
  | { status: 'alive' }
  | {
      status: 'dead';
      diedAt: string;
      campaignId?: string;
      sessionId?: string;
      markedByUserId: string;
    };
```

A denormalized indexed `lifeStatus` column mirrors the JSON document for eligibility queries. A new integer `version` column, starting at 1 and incremented by every character writer, replaces timestamps as the authoritative optimistic-concurrency value. Character JSON remains the canonical character record, and updates to its denormalized columns occur atomically.

`characterVersionClaims` stores a unique `(characterId, resultingVersion)` for every character mutation, including a backfilled version-1 claim. Whole-sheet saves and session resource/death commands insert the next claim in the same transaction as the JSON/column update. This gives D1 a constraint failure on competing writers instead of relying on a zero-row conditional update to abort a batch.

The v2→v3 migrate-on-read step supplies `{ status: 'alive' }` when stored JSON has no life record; the database migration backfills the same default into `lifeStatus`. A character need not be resaved for the JSON normalizer and eligibility query to agree.

Existing whole-sheet writes and all first-party autosave callers migrate to a required `expectedVersion`. The server accepts `expectedUpdatedAt` only for one compatibility release and does not retain an unguarded whole-document write path. Session resource commands update only the targeted JSON field, such as `resolve.current`, rather than writing a stale full character blob. They re-read and revalidate after an internal version collision, so an unrelated sheet edit cannot be overwritten.

The character owner may mark their own adventurer dead. A campaign GM may mark only an adventurer with an active tenure in that GM's campaign. Death globally marks the character dead, ends the current tenure, releases the player's campaign slot, and preserves the tenure in roster history.

An audited correction may reverse an erroneous death. If a replacement is already attached, the corrected character becomes alive but remains unattached; restoring its active tenure would violate the one-adventurer rule and therefore requires a later voluntary replacement when no session is active.

### 6.4 Play sessions and snapshots

`playSessions` stores:

- `id`, `campaignId`, monotonically increasing `sequence`
- `status`: `active`, `ended`, or `frozen`
- `phase` and active procedure identifier
- Content-pack ID/version, procedure schema version, and content digest pinned at start
- `runtimeContentId` referencing the immutable validated rules snapshot for that session
- `version` for compare-and-set commands
- Versioned `publicStateJson`
- `startedAt`, `startedByUserId`, `endedAt`, `endedByUserId`
- `finalPublicStateJson` and `publicHistoryChecksum` after ending

A partial unique index allows only one active or frozen session per campaign. A frozen session still occupies the slot until recovered or ended and blocks campaign archival.

`sessionRuntimeContents` stores one immutable versioned `runtimeContentJson` document per session containing the tarot config, procedure definitions, modifiers, and lookup tables the session needs. Keeping it in a separate one-to-one row prevents the rules snapshot and mutable public state from competing for D1's row-size limit.

The runtime snapshot is compiled from the current bundled content when the session starts and is then the source of rules for that session. A later deployment can therefore honor an overnight session even when the bundled pack changes. Build validation keeps each snapshot below D1's 2 MB row limit, and CI rejects any content-pack change that does not also bump `index.json`'s pack version.

`sessionPrivateStates` stores one validated private projection fragment per `(sessionId, recipientUserId)`. Player hands, private face-down identities, and the GM's hand are held here, not in public JSON.

`sessionServerStates` stores the one-to-one server-only fragment: ordered draw-pile identities, shuffle recovery data, and pending identities not owned by any user. It is never projected to a participant. Full reducer state is reconstructed from public, server-only, and per-recipient fragments, and each fragment carries the session version it represents.

### 6.5 Commands, events, and secrets

`sessionCommands` stores:

- `(sessionId, commandId)` as a unique idempotency key
- Actor and a request hash computed from canonical, validated command JSON with recursively sorted object keys
- Client-observed version, optional structural precondition, and the internal expected/resulting versions used for the accepted write
- Command type and non-secret audit metadata
- Outcome status and nullable resulting version; accepted commands have a unique `(sessionId, resultingVersion)` claim and `resultingVersion = expectedVersion + 1`, while rejected commands carry no version claim
- `createdAt`

Reusing a command ID with a different request hash is rejected. Reusing it with the same request returns the recorded outcome metadata plus the actor's current authorized projection and does not apply the command again. The command journal never stores a second copy of private card identities.

`campaignEvents` provides a monotonically increasing campaign cursor and stores campaign/session lifecycle and accepted-command events:

- `id`/cursor, `campaignId`, optional `sessionId`, optional `commandId`
- Actor, event kind, sanitized public payload, timestamp

`campaignEventSecrets` stores an optional payload for a single event and recipient. Private event payloads are returned only to that recipient. They are never copied into the public payload.

When a session ends, the server replaces mutable session state with the final public projection, removes all `sessionPrivateStates`, removes the secret-bearing `sessionServerStates` payload, removes private event payloads, and records a checksum over the ordered public history and final public state. Publicly revealed and discarded card identities remain in history. Cards that never became public remain permanently redacted.

`publicHistoryChecksum` detects accidental corruption or incomplete writes; it is not signed and does not claim to prove integrity against a database operator. The feature makes no provable-fair-shuffle claim.

### 6.6 Atomicity on SQLite and D1

Local SQLite uses a database transaction. D1 uses a sequential `D1Database.batch()`. An accepted command inserts its `(sessionId, resultingVersion)` claim into `sessionCommands`; the unique index turns two writers that both read version N and attempt version N+1 into a constraint failure for one writer, aborting that entire batch. Character writes use the same integer-version/unique-claim pattern across every character writer. No trigger-specific behavior is required.

For non-structural intents, the server handles a version-claim collision by re-reading, re-running the pure reducer, and retrying up to four total attempts. Player card commands therefore compose when they affect independent hands. GM phase/round completion and other structural commands carry a hard observed-version precondition and return `409` if the structure changed. Four lost internal races also return `409` with current cursor/version metadata.

The guarded batch includes, as applicable:

1. The idempotency and resulting-version claim insertion.
2. The versioned public snapshot update.
3. Server-only and per-recipient private snapshot changes.
4. Public and private event inserts.
5. Narrow character resource, life, and tenure changes plus any character-version claim.
6. The stored command outcome.

Any failure rolls back the complete mutation. The same reducer and persistence contract are tested against better-sqlite3 and local D1.

## 7. Campaign lifecycle

### 7.1 Creation and invitation

`/campaigns/new` creates the campaign and its separate Guild Roster in one transaction. The creator becomes the immutable GM owner. The invite is an unguessable, versioned token signed with a dedicated deployment secret. The database stores its lookup hash and rotation inputs, allowing the server to reproduce the current link only for the authorized GM without storing the raw token. Rotation changes the nonce/version and hash.

The GM can:

- Copy the persistent join link.
- Close or reopen joining without changing the link.
- Rotate the token, immediately invalidating the old link.

`/join/[token]` displays a minimal campaign preview. An unauthenticated visitor signs in and returns to the same invitation. A signed-in visitor confirms joining. If the campaign is open, membership is created immediately without GM approval. The action is idempotent and redirects an existing active member to the campaign. A closed, invalid, rotated, or archived invitation cannot create membership.

### 7.2 Attachment and replacement

Outside an active session, a member may replace their active living adventurer at any time. The existing tenure ends with `replaced`, making that living character eligible for another campaign, and the new tenure begins atomically.

During an active session:

- A newly joined player may observe but cannot make an initial attachment.
- A living adventurer cannot be voluntarily detached or replaced.
- If the member's active adventurer dies during that session, the member may attach a replacement immediately.
- Outside a Challenge, the replacement enters the session roster immediately.
- During a Challenge, the replacement appears as joining and receives a hand at the next legal deal or round boundary. It is never injected into a partially resolved turn.

This exception supports the rulebook's instruction to create a new adventurer and rejoin play as soon as possible after a death without allowing mid-session roster swapping.

### 7.3 Leaving, removal, and archival

A player may leave at any time after an explicit destructive-action confirmation. Without an active session, leaving ends any active living tenure with `left` and releases that character. During an active session, leaving invokes the same audited privacy-preserving cleanup used for GM removal: private cards return to their owning draw pile and that pile is shuffled without revealing identities; public cards follow configured cleanup destinations. The membership and tenure then end with `left`, and the character becomes available elsewhere. In either path, historical sessions and tenures remain in the audit record while the former member loses campaign and history access. This escape does not permit the player to remain in the campaign and swap living adventurers mid-session.

The GM may remove a member immediately for access safety. If a session is active, the server performs an audited cleanup command that returns the removed user's private cards to their owning draw pile and shuffles that pile, logging counts but no identities. It also resolves public cards through their normal configured cleanup destinations, ends the tenure with `removed`, and revokes sync access before returning success.

The GM may archive a campaign only when no session is active or frozen. An archived campaign and its completed histories are read-only. Current members and the GM can still view it; invitations and new sessions are disabled.

### 7.4 Session lifecycle

The GM explicitly starts and ends sessions.

Starting a session:

- Compiles and stores the validated runtime content snapshot with its content-pack/procedure versions and digest.
- Builds fresh major and player decks from the configured card catalog.
- Places trumps I–XXI in the GM deck and the four minor suits plus the Fool in the player deck, as specified by the rules content.
- Uses a server-generated shuffle seed and stores only the information needed for authoritative recovery and auditing.
- Initializes distinct draw and discard zones.
- Adds every currently attached living adventurer to the session roster.

The session survives navigation, refresh, disconnect, process restart, deployment of a newer content pack, and an overnight pause. The browser stores no authoritative deck state. Sessions do not auto-expire; player-initiated active-session leave prevents an abandoned GM from locking a character indefinitely.

The shuffle seed and recoverable shuffled order remain server-private during play. Ending the session purges any value that could reconstruct an unrevealed card identity. A seed is not revealed later because doing so could reconstruct cards that never became public.

Ending a session is an explicit GM command. It closes the active procedure safely, creates the final public projection and public-history checksum, purges unrevealed secrets, and makes the completed session visible to the GM and every current campaign member. The history contains the public event timeline, revealed cards, discard history, procedure outcomes, corrections, and roster events; it never contains private faces that were not revealed during play.

## 8. Shared tarot engine

### 8.1 Pure engine boundary

New functions under `src/lib/engine/session/` are pure, stateless, and isolated from SvelteKit, UI, and database imports. They receive validated content-pack configuration, complete server-only engine state, actor capabilities, and a command. They return either a typed rejection or a next state plus typed public/private events.

The existing `tarot-deck.ts` and `tarot-resolution.ts` functions should be reused or refactored into shared primitives where their behavior matches the rulebook. Campaign code must not duplicate shuffle, value, suit, or test rules. Favor/disfavor, group tests, Resolve-for-favor, and the Fool-on-push rule do not exist in the current engine and are explicit new engine work, not refactoring estimates.

### 8.2 Card identity and zones

Each of the 78 tarot cards has one stable content-pack card ID. The Fool uses the stable ID `fool` and numeric value 0; the procedure schema does not treat that value as a positional card number or label the Fool 0/XXII. Major cards expose derived `doomTier` (`lesser` for I–XIV, `greater` for XV–XXI) and `valueParity` so GM and denizen operations can use typed predicates. At every active-session version, each card exists in exactly one engine zone. Events may reference a card but never constitute a second live location.

Required zone categories are:

- Major draw and discard piles
- Player draw and discard piles
- A private GM hand
- One private player hand per participating adventurer
- Public initiative and played-card areas
- Private face-down or prepared areas with a public card-back projection
- Inspiration and other rule-defined held-card zones
- Procedure-owned pending and selection zones

Every zone declares its owning deck, visibility, ordering semantics, allowed card kinds, and legal transitions. The engine conserves the complete configured deck after every command. It rejects duplicate IDs, missing cards, cross-deck moves, illegal visibility changes, and ownership violations.

Public projections expose card counts, public cards, public pile tops, procedure status, and authorized controls. A player's projection adds only that player's private identities. The GM's projection adds only the GM hand and GM-private procedure identities. No projection code path grants the GM a player's secret values.

The rulebook explicitly forbids peeking at another player's face-down card. Private hands also preserve the physical game's poker-hand/poker-face play and are an approved product privacy rule even though the book states the face-down-card prohibition more directly than hand visibility.

### 8.3 Command vocabulary

The engine exposes a small composable vocabulary:

- `draw`
- `deal`
- `play`
- `place-facedown`
- `reveal`
- `discard`
- `transfer`
- `select-from-discard`
- `reorder-top`
- `mulligan`
- `begin-procedure`
- `advance-procedure`
- `complete-procedure`
- `end-round`
- `apply-correction`

Procedure modules constrain these primitives by phase, actor, owner, count, source, destination, and rule configuration. `play` and `discard` are distinct operations: Challenge play consumes the appropriate per-turn action budget, while rules may allow unlimited GM discards up to cards held. `transfer` is a first-class privacy-preserving move between authorized private zones for Counsel, High Chant, and Guardian Angel. Generic table controls use the same commands and therefore retain all authorization, visibility, conservation, and audit behavior.

### 8.4 Drawing, deck exhaustion, and the Fool

Draws are server-authoritative. If a requested draw exceeds the eligible draw pile, the engine automatically shuffles only the eligible discard pile and continues. Cards in hands, initiative, face-down play, inspiration, pending selections, and any other in-play zone are excluded.

The engine models three distinct Fool rules:

- **Reshuffle trigger:** Drawing the Fool schedules both configured decks for reshuffle at the end of the Challenge round or the guided procedure's explicit round/boundary. Held and in-play cards remain excluded.
- **Challenge play:** The Fool is played with another card as an interrupt, always resolves first, grants an additional turn, and grants no minor actions for that extra turn. This resolves immediately; it is separate from the later reshuffle.
- **Push:** Drawing the Fool initially gives value 0 and may be pushed normally; drawing it as the additional card while pushing fate makes the test an automatic great failure.

Deck-exhaustion reshuffling is a fourth, independent rule: when a required draw cannot be completed, shuffle only that deck's eligible discard and continue. The content pack specifies all triggers, boundaries, and affected zones so the UI does not hardcode them.

### 8.5 Tests and calculated values

Guided tests read the attached character's required attribute and current Resolve value from server-side character data. The flow is:

1. Declare the acting adventurer, tested attribute/suit, and any aid or relevant motif.
2. Establish favor and disfavor. Each is non-cumulative, and one cancels the other. Before drawing, the acting player may explicitly confirm spending 1 Resolve to gain favor.
3. Draw and calculate attribute + card value + the resulting +3/−3 modifier.
4. Resolve success/failure and initial-suit great success from content thresholds.
5. After a failure, offer a free push. Draw one additional card, make great success impossible, and resolve a total of 13 or less—or a Fool drawn on the push—as a great failure.

Resolve is therefore a pre-test favor purchase, not a cost of pushing. Confirming the purchase issues a narrow atomic resource command using the current `resolve.current` and character version; the command service retries an unrelated character-version collision against the latest sheet without overwriting other fields.

Group tests select the most- and least-qualified adventurers, run two complete tests, convert great success/success/failure/great failure to 2/1/0/−1 hits, and classify the group outcome from the configured hit table. Wounds and fictional consequences remain manual character-sheet/table decisions.

### 8.6 Challenge state machine

The guided Challenge procedure owns:

- Participant selection from the live session roster
- Initial and round dealing
- Private player and GM hands
- Initiative placement and reveal
- Active turn/phase markers
- Legal player and GM card plays
- Minor actions and interrupts as logged declarations
- Prepared and face-down cards
- Public played cards and discard destinations
- End-of-round cleanup
- Fool extra-turn and reshuffle resolution
- Player deal modifiers such as black honey
- Forced hand changes such as Stun's immediate discard and Brainfever's lowest-value Initiative
- The GM hand formula, recalculated from current enemy count/type/size/threat at the start of every round
- Lesser/greater doom legality, value parity, and the distinct GM play/discard budgets
- GM mulligan when the configured greater-doom condition is met
- Joining a replacement adventurer at a legal boundary after death
- Ending the Challenge and returning cards to configured zones

The GM advances phases and rounds. Players control only their own allowed hand and face-down commands. The application calculates card and hand totals where rules require them, but the GM records the fictional target and outcome. It does not model a battle map, range, movement, wounds, monster health, or status application.

Challenge-adjacent rules with distinct card movement or privacy receive typed modifiers rather than free-text instructions. The Challenge module includes Counsel transfer, Guardian Angel, Aim, and shield Initiative replacement. It does not own Camp, Crawl, or test-of-fate procedures.

Aim is granted by bow equipment rather than by the Challenge chapter (`09 - Chapter 9 …:760-762`): it is a Swords action played face-down against a declared target, revealed on a later Attack to add its value. It is a Challenge card operation and is therefore owned here despite its source.

Shield Initiative replacement is the **Guard** miscellaneous action (`07 - Chapter 7 …:552-554`): "If you have a shield, you may replace your Initiative with any card from your hand as a miscellaneous action. Your old Initiative is discarded." It is a card movement between a private hand and the public Initiative zone plus a discard, so it belongs to the Challenge module.

> **Amendment history — read before editing this paragraph.** A 2026-07-15 revision *removed* shield Initiative replacement, asserting no such mechanic existed. That was wrong and is reverted. The error: the author searched Chapter 9's `Shield` equipment entry (Notch absorption) and Chapter 7's attack tie-breaks, and never opened `### Guard` in Chapter 7's miscellaneous-actions list. This is the third instance of roadmap decision **D7** — reading where a rule is *printed* rather than where it is *used* — and the second time it destroyed correct content. Do not remove a mechanic from this specification on the grounds that it "does not exist" without grepping the rulebook for the mechanic's **effect** (here: `Initiative`), not just its noun (`shield`).

Denizen abilities use generic typed predicates over `doomTier`, `valueParity`, and operation type whenever the rule is “play/discard a qualifying card.” The engine enforces one normal card play per turn and the separate unlimited-discard allowance; the GM still adjudicates the ability's fictional target and consequence.

### 8.7 Cross-procedure modifiers

Rules are filed under the procedure they actually modify and compose through the shared card commands:

- **Camp:** High Chant selects from discard and distributes private inspiration cards; leeches draw and classify by suit.
- **Crawl:** Area Sense draws after its watch/Resolve requirements are confirmed.
- **Tests of fate:** Augury gives the GM a private draw, a public parable state, and a later reveal/discard decision without exposing the card early.
- **Challenge:** Counsel, Guardian Angel, Aim, shield Initiative (Guard), Stun, black honey, and Brainfever use Challenge hooks.
- **Oracle/table:** Maleficence, Malediction, Random Totem, the GM twist table, disposition variants, and other lookups use generated procedure definitions.

### 8.8 Corrections

The GM receives scoped correction controls for mistaken card movement, premature phase advance, and procedure cleanup. A correction is a new compensating command and event; it never rewrites or deletes history. Corrections use server-selected opaque references where necessary so the GM can repair a player's hidden zone without learning card identities.

Corrections must still satisfy card conservation, ownership, deck boundaries, session membership, and privacy. A correction that cannot preserve invariants is rejected.

## 9. In-session procedure coverage

Coverage begins with a versioned `docs/rules/tarot-procedure-audit.md`. The audit enumerates every tarot-related rule found across the Markdown vault with a stable procedure ID, chapter/line citation, and one disposition: `supported-v1`, `deferred-preparation`, or `not-applicable-non-tarot`. Review of that finite list defines v1 completeness; the product does not make an untestable claim over unenumerated prose.

All draw counts, deck choices, value tables, Fool behavior, selection rules, modifiers, and rule references live in a validated `tarot-procedures.json` content-pack resource declared in `index.json.files`. It is generated by a new `scripts/content-import/md-procedures.mjs` from committed manifests and the Markdown vault, not hand-authored. `npm run content:build` regenerates it and `npm run content:verify` detects drift. The import covers Chapters 6–9 plus the targeted live-play rules identified by the audit in Chapters 1, 4, 5, 10, Appendices A/C, and the in-session portions of Appendix D. Components render generated definitions and engine outcomes; they do not encode game rules in conditionals.

| Rules area | First-release support | Interaction model |
|---|---|---|
| Session setup | Major/player split, fresh shuffle, two separate discards, visible configured discard tops | Automatic initialization; setup itself does not draw |
| Basics | Tests of fate, pre-test Resolve for favor, free push, favor/disfavor, aid, group tests, all three Fool rules | Guided test panel using character values and explicit pre-draw Resolve confirmation |
| Crawl and travel | Meatgrinder, room/watch/noise/careful-movement, darkness/We're Doomed, and optional Overland Travel draws | Guided exploration/travel panels plus reusable oracle draws |
| Crawl and GM oracles | Disposition including per-denizen variants, random target, belt/pack equipment target, and other discard-top lookups | Read the configured discard top or draw, show the lookup result, and log the public outcome |
| Challenge core | Deal, private hands, Initiative, turns, actions, interrupts, facedown/prepared cards, cleanup, mulligan, deck exhaustion, and Fool | Full guided Challenge state machine |
| GM card economy | Per-round hand formula, lesser/greater dooms, parity, play-vs-discard budgets, minor actions, and denizen predicates | Typed GM-hand rules plus generic qualifying-card commands |
| Challenge modifiers | Counsel, Guardian Angel, Aim, shield Initiative (Guard), Stun, black honey, Brainfever, and the GM twist oracle | Typed hooks sharing the Challenge and oracle commands |
| Camp | Meatgrinder/Patrol draw-twice choice, watch-person discard oracle and Cups test, High Chant, and leeches | Guided Camp procedures sharing test, selection, transfer, and draw operations |
| Core City during play | City Events and Signs, Beg & Busk, and Carouse | Reusable guided draw and lookup procedures |
| Sample-City actions used during play | Doomsaying, Strange Communions, and As above so below | Draw, mixed draw/discard selection, and top-three reorder procedures |
| Sorcery and tarot tables | Augury, Maleficence tables, Malediction, Random Totem, and other live tarot spell lookups | Configured private draw, reveal, oracle, selection, and reorder controls |
| Unforeseen in-session use | Draw, deal, reveal, discard, transfer, select from discard, reorder top | Generic audited table controls with deck and privacy constraints |

The two discard piles remain distinct because multiple rules inspect a specific pile's top card. The engine's public projection therefore preserves the configured visible top without treating it as a new card location.

Preparation-oriented tables in Gamemastering, City Creation, and Underworld Creation remain deferred even if they also use tarot. The boundary is the moment of use: the three named Appendix D Special City Actions occur during play and are supported, while generating a city or Job Board before play is not. Flat “50% chance” rules that do not prescribe tarot remain manual and are recorded as `not-applicable-non-tarot` in the audit.

Every generated procedure definition includes a stable ID, human-readable title, exact rule-source citation, deck, visibility, draw count or formula, lookup table if any, legal actors, result visibility, completion boundary, and recovery behavior. A content validator proves that referenced cards, character fields, modifiers, tables, and artwork IDs exist. CI also requires a content-pack version bump whenever generated or source pack content changes.

## 10. API, synchronization, and projection

### 10.1 Routes

Primary pages are:

- `/campaigns` — campaigns the user owns or has joined
- `/campaigns/new` — GM campaign creation
- `/campaigns/[campaignId]` — campaign dashboard, Guild Roster, membership, attachment, invite settings, and session history
- `/campaigns/[campaignId]/table` — active shared tarot table
- `/campaigns/[campaignId]/sessions/[sessionId]` — completed public session history
- `/join/[token]` — invitation preview, authentication return, and join confirmation

Mutation endpoints remain narrow. The table centers on:

- `GET /api/campaigns/[campaignId]/sync?after=<cursor>&version=<version>`
- `POST /api/campaigns/[campaignId]/sessions/[sessionId]/commands`

Campaign, membership, tenure, invite, death, and session-lifecycle endpoints use the same service-layer authorization and event conventions. Page form actions may wrap these services where they improve progressive enhancement.

### 10.2 Command envelope

Every session command includes:

```ts
type SessionCommandEnvelope = {
  commandId: string;
  observedSessionVersion: number;
  expectedStructuralVersion?: number;
  observedCharacterVersion?: number;
  command: SessionCommand;
};
```

`observedSessionVersion` is an advisory freshness signal. `expectedStructuralVersion` is required only for structural intents such as advancing/completing a procedure, ending a round, ending a session, or applying a correction. A resource-spend command carries the exact current resource value the player confirmed; an unrelated character version change may be retried, but a changed resource value requires a new confirmation.

The server authenticates the user, validates and canonicalizes the envelope with Zod, loads campaign capabilities and the stored runtime content snapshot, reconstructs current engine state, runs the pure reducer and invariants, and attempts the atomic version claim/write. Non-structural version collisions repeat that read/reduce/write cycle internally. Success returns the actor's new projection plus cursor/version metadata.

### 10.3 Polling

While a visible table route has an active session, the client automatically performs approximately one sync request per second. A no-change response is `204` or an equivalently tiny cursor/version response. A changed response contains only events and projection fragments authorized for that requester. Campaign/dashboard polling without an active table backs off to approximately five seconds.

Polling starts immediately on mount and after every command response, backs off on transient failures, pauses while the document is hidden, and resumes immediately on focus or network recovery. The client shows last-sync time and connection status. A sub-second isolate-local cache may hold only the latest opaque campaign cursor after authorization so repeated no-change checks can avoid D1; expiration or uncertainty falls through to the indexed D1 cursor query.

The first release target is that an accepted command becomes visible to all connected participants within two seconds under the single-table baseline. Capacity testing also measures multiple concurrent nine-client campaigns because D1 serializes queries within one database. There is no hard eight-player product cap.

### 10.4 Client behavior

The campaign session store contains only the current authorized projection, cursor, version, connection state, and pending command metadata. It does not persist private card faces to `localStorage` or reconstruct a deck.

Card-changing UI waits for authoritative acceptance. A network retry reuses the same command ID. Most independent card intents survive unrelated concurrent activity through server-side retries. A `409` is reserved for a changed structural precondition or four lost internal races; the client synchronizes, explains what changed, and asks the user to retry if the action is still relevant. While offline, the table is read-only and does not queue draws or card plays.

## 11. Authorization, privacy, and security

Every read and mutation passes through a centralized campaign capability service. Capabilities distinguish GM, active member, character owner, active-tenure owner, session participant, and history viewer. Client controls are conveniences; server checks are authoritative.

Key requirements are:

- The campaign feature flag is enforced in the server capability service as well as navigation; disabled campaign routes and APIs return 404.
- Requests for a campaign/session/character the actor cannot know about return 404 rather than distinguishing existence with 403, following the existing character ownership convention.
- The GM can see the GM major-card hand but not any player's private hand or private face-down values.
- A player can see only their own private identities.
- Everyone can see public plays, initiatives, revealed cards, configured discard tops, public results, and zone counts.
- Campaign sheets are visible to the GM and active members. Only the character owner can edit the sheet; the campaign GM receives only the scoped mark-dead action.
- A removed or departed member loses campaign sync and history authorization immediately.
- Hidden identities do not appear in SSR data, JSON not intended for the recipient, HTML, DOM attributes, image URLs, preload hints, alt text, analytics, structured logs, exception messages, or telemetry.
- A hidden card renders an authorized back asset with accessible text such as “Face-down tarot card,” never the concealed name.
- Invite tokens have high entropy, use a dedicated signing secret, are stored only as a hash plus non-secret rotation inputs, are redacted from logs, and are invalidated by rotation.
- Authenticated campaign/session responses and invitation responses send `Cache-Control: private, no-store`; Cloudflare caches must not store or share personalized projections.
- State-changing requests require the authenticated same-origin flow and SvelteKit/CSRF protections.
- User-authored campaign and roster text is length-limited, validated, and rendered as text rather than trusted HTML.
- Command and invitation endpoints receive conservative request throttling without weakening idempotent retries. The existing per-isolate in-memory limiter is defense in depth only; production enablement requires an edge-level Cloudflare rate-limit rule or equivalent shared control.

Projection tests treat any cross-role card identity leak as a release blocker.

The threat model protects player secrets from other users, including the GM, and detects accidental persisted-history corruption. It does not protect against a database/operator compromise, prove shuffle fairness, or treat an unsigned checksum as adversarial tamper evidence.

## 12. Table-first interface

The selected **Table First** layout keeps the shared deck interaction dominant and makes the current user's private hand continuously reachable without turning the application into a map/token VTT. This rationale and the Archival Frame choice were approved during the 2026-07-15 design review. The layout is:

- A compact phase/procedure rail on the left
- The shared tarot table as the dominant center surface
- A public event and procedure log on the right
- The current user's private hand anchored along the bottom

On narrow screens, the table remains primary. The phase rail and log collapse into drawers or tabs, and the private hand becomes a horizontally scrollable tray. Controls remain reachable by keyboard and touch. Motion respects reduced-motion preferences.

Major areas include:

- Session header with campaign, connection, participants, version-safe status, and GM start/end controls
- Public deck/discard stations showing backs, counts, and authorized top cards
- Procedure workspace for tests, Crawl, Challenge, and generic draws
- Public initiative/played/prepared areas
- Private hand tray rendered only from the current user's projection
- Phase rail with valid next steps and GM controls
- Chronological public log with actor, action, rule reference, and correction markers
- Roster/death notifications and replacement eligibility state

The table does not render a map, token canvas, combat tracker, health tracker, or fictional positioning system.

## 13. Tarot artwork and asset pipeline

The authorized source contains 78 Rider–Waite–Smith face scans and two card backs under `assets-src/tarot/rwsa/`. Source scans remain outside the production static tree and are not served directly.

A deterministic build script will:

1. Read an explicit source-to-card mapping rather than infer identity only from filenames.
2. Verify exactly one face image for every configured tarot card and exactly the configured back assets.
3. Preserve the entire scan and original printed border with no crop.
4. Normalize orientation and metadata without changing the artwork.
5. Generate responsive AVIF and WebP variants for hand/table/detail display.
6. Produce dimensions, hashes, variant paths, and credit/license metadata in a validated `tarot-art.json` manifest.
7. Fail when an image is missing, duplicated, unmapped, or unexpectedly changed.

The UI uses an **Archival Frame** treatment: the complete artwork sits inside a restrained frame, followed by a slim application label/value footer. The application frame does not imitate the HMTW rulebook's trade dress. Cards can open into a larger accessible detail view.

The art manifest records the source collection, artist attribution, acquisition/permission note, processing date, source hash, and public-facing credit. The licensing page and production credits identify the Rider–Waite–Smith artwork and the authorized scan source. The legal review assumption for this specification is that permission for this exact 80-image scan set has been obtained.

## 14. Error handling and recovery

The system uses explicit typed failure modes:

- **Duplicate command:** Return the recorded outcome metadata and current authorized projection without applying it again.
- **Internal version collision:** Re-read and re-reduce a non-structural intent up to four total attempts.
- **Structural stale version or repeated contention:** Return `409`, current version/cursor metadata, and no mutation.
- **Invalid or unauthorized command:** Return a typed `4xx` rejection and no mutation.
- **Transient database/network failure:** Return a retryable response; the client retries only with the same command ID.
- **Offline client:** Preserve the last authorized projection, show it as stale/read-only, and resume synchronization when online.
- **Invariant failure before commit:** Reject the command and persist nothing.
- **Invalid stored state or runtime-content snapshot:** Mark the session frozen, prevent further card commands and campaign archival, retain the last durable data, and provide the GM a safe end/export path while an operator repairs the issue.

The command service records structured non-secret diagnostics: campaign/session IDs, command type, actor ID, observed/internal/current versions, retry count, outcome class, and timing. It never logs raw invite tokens, hidden card IDs, private payloads, character JSON, or authorized projections.

An end-session operation must be retryable and idempotent. Secret purging, final projection creation, and public-history checksum storage happen atomically so a session cannot appear completed while private rows remain exposed to application queries.

## 15. Module decomposition

Expected pure engine modules:

- `src/lib/engine/session/types.ts`
- `src/lib/engine/session/commands.ts`
- `src/lib/engine/session/reducer.ts`
- `src/lib/engine/session/invariants.ts`
- `src/lib/engine/session/projection-types.ts`
- `src/lib/engine/session/test-of-fate.ts`
- `src/lib/engine/session/challenge.ts`
- `src/lib/engine/session/challenge-economy.ts`
- `src/lib/engine/session/modifiers.ts`
- `src/lib/engine/session/procedures.ts`
- `src/lib/engine/session/corrections.ts`

Expected server modules under `src/lib/server/campaigns/`:

- Campaign authorization/capabilities
- Invite hashing and join flow
- Membership and adventurer tenure services
- Guild Roster service
- Session lifecycle and state repository
- Atomic SQLite/D1 adapter
- Command service
- Projection and sync service
- Death/replacement service
- Correction and recovery service

Expected content-pipeline additions:

- `docs/rules/tarot-procedure-audit.md`
- `scripts/content-import/manifest/tarot-procedures-md.json`
- `scripts/content-import/md-procedures.mjs`
- `static/content-packs/hmtw/tarot-procedures.json`

Expected component groups under `src/lib/components/campaigns/`:

- Campaign dashboard, invite management, and Guild Roster
- Session shell and phase rail
- Shared table and deck/discard stations
- Private hand
- Public log
- Guided test and procedure panels
- Challenge workspace
- Reusable archival `TarotCard`

Route files remain thin. They validate transport input, call services, and return typed projections. Rule content stays in content-pack JSON. Business transitions stay in the pure engine or server services. UI components do not import database code or encode rule tables.

## 16. Migration and rollout

The work lands behind a server-enforced campaign feature flag. Omitting navigation is not the security boundary: the capability service rejects disabled campaign pages and APIs. Each increment has its own gate and may be exercised by explicitly allowlisted test campaigns before public navigation is enabled.

Recommended release increments are:

- **Increment 0 — Procedure audit and import:** Enumerate every in-session tarot rule, assign supported/deferred/not-applicable status, import Chapters 6–9 and targeted cross-chapter procedures through `md-procedures.mjs`, generate `tarot-procedures.json`, add `content:verify` drift coverage, and close the existing documented Challenge hand-size gap.
- **Increment 0.5 — Resolution engine:** Add favor/disfavor, pre-test Resolve, free push, Fool-on-push, aid, and group tests to the shared engine and existing `/deck` test UI before campaign code depends on them.
- **Increment 1 — Foundation:** Schema, character integer version + life migration, campaign membership, invite flow, Guild Roster, capability checks, server feature flag, runtime-content snapshots, and empty session lifecycle.
- **Increment 2 — Shared table core:** Authoritative decks, projection privacy, adaptive polling, server-side CAS retry, generic commands, tests of fate, and Crawl procedures. Privacy and atomic correctness gate an allowlisted real-table pilot here.
- **Increment 3 — Challenge:** State machine, private hands, GM doom economy, per-round hand formula, round flow, Challenge modifiers, pre-test Resolve confirmation, and death replacement boundary.
- **Increment 4 — Completion:** Camp/City/sorcery/cross-cutting procedures, history and secret purge, corrections, recovery, player active-session leave, archival, performance, and accessibility hardening.
- **Increment 5 — Enablement:** Clean/current database upgrade verification, remote-D1 constraint smoke test, Cloudflare build, full acceptance run, legal/art credit review, production capacity/cost review, and public navigation enablement.

The artwork pipeline runs in parallel with increments 0–3. It is not coupled to engine sequencing, but the authorized art and asset acceptance tests remain required for the public v1 described by this specification.

The planned visible-table polling cadence exceeds the current Workers Free request allowance for a long multi-player session. Production enablement therefore requires Workers Paid (currently a $5/month minimum) or a measured transport/cadence redesign that meets the same latency and privacy criteria. This operational dependency is checked again against current Cloudflare pricing at enablement time.

Database migration strategy:

- Add new campaign-prefixed tables and indexes in a forward-only Drizzle migration.
- Add `characters.version INTEGER NOT NULL DEFAULT 1` and the denormalized life column with an alive default and backfill.
- Add a version-claim record used by every whole-sheet and session resource writer; migrate the character PUT API to `expectedVersion` while accepting `expectedUpdatedAt` for one compatibility release.
- Upgrade character documents with an explicit v2→v3 life transform before the existing final normalization.
- Leave legacy unused guild tables untouched for a separate cleanup decision.
- Test both a clean database and an existing populated database on SQLite and local D1.
- Add CI enforcement that any content-pack change bumps `index.json.version` and that the compiled runtime snapshot remains within D1 row limits.

## 17. Verification strategy

### 17.1 Content and audit tests

The v1 procedure audit is reviewed as a finite checklist. Tests prove every `supported-v1` entry maps to one generated procedure or a named engine modifier, every generated entry has a source citation, and every `deferred-preparation`/`not-applicable-non-tarot` entry has a rationale. `content:verify` regenerates from Markdown and fails on drift. Referential tests include doom tiers, modifier IDs, lookup ranges, per-denizen variants, and the exact two-discard-pile source.

### 17.2 Pure engine tests

Engine coverage remains at least 90 percent for new session modules. Tests include:

- Seeded deterministic shuffle and draw results
- Major/player deck composition
- Card conservation after long randomized legal command sequences
- Rejection of duplicate, missing, cross-deck, wrong-owner, and illegal-phase moves
- Deck-exhaustion reshuffle eligibility plus Fool reshuffle, Challenge-play, and push behavior
- Tests, free push, pre-test Resolve/favor, favor/disfavor cancellation, aid, and group results
- Challenge setup, doom tiers/parity, play/discard budgets, GM hand recalculation, mulligan, every round transition, cleanup, replacement joins, and listed modifiers
- Every content-configured procedure definition
- Projection redaction by role
- Correction commands and invariants

### 17.3 Database and service tests

Service suites cover:

- Join links open/closed/rotated/authentication return/idempotency
- Membership and global character uniqueness under concurrent attachment
- Voluntary replacement restrictions, active-session death exception, and active-session player-leave cleanup/release
- Owner/GM death authorization and correction behavior
- Session uniqueness and runtime-content snapshot survival across a simulated content deployment
- Idempotent commands, canonical request hashing, independent-command server retry, structural staleness, repeated contention, and atomic rollback
- Integer character versioning, narrow Resolve mutation, legacy `expectedUpdatedAt` compatibility, and concurrent sheet/session writes
- GM removal cleanup without secret disclosure
- End-session finalization and secret purging
- Archived and former-member authorization
- Equivalent behavior on better-sqlite3 and local D1, plus a staging/remote-D1 smoke test of unique version claims and batch rollback

### 17.4 Privacy regression tests

For GM, player A, player B, unauthenticated user, removed member, and completed-history viewer, tests inspect:

- JSON response bodies
- SSR/page data and rendered HTML
- DOM attributes and accessible names
- Image and preload URLs
- Sync deltas and event logs
- Error messages and captured structured logs

The fixtures use recognizable canary card IDs. Any canary appearing outside its authorized projection fails the suite.

### 17.5 End-to-end and nonfunctional tests

Playwright runs separate browser contexts for a GM and multiple players through:

1. Campaign creation and link sharing.
2. Sign-in return, immediate join, and character attachment.
3. Session start and synchronized table load.
4. Exploration draw and test of fate.
5. Full Challenge round with private hands, initiative, play, correction, and Fool handling.
6. Player death, replacement attachment at a legal boundary, and continued play.
7. Two players submit independent commands from the same observed version without a user-visible conflict.
8. A player leaves during an active session, hidden cards are cleaned without disclosure, and the living adventurer becomes eligible elsewhere.
9. Refresh/disconnect/reconnect and duplicate/structural-stale command handling.
10. Session end, history visibility, and proof that unrevealed faces and shuffle reconstruction data are absent.

Accessibility checks cover keyboard operation, focus order, dialogs/drawers, card-back labels, contrast, touch target size, and reduced motion. Asset tests validate mapping completeness, dimensions, hashes, formats, credits, and absence of source PNGs from the production output.

Latency verification uses one GM plus eight polling players and requires accepted commands to appear within two seconds without lost or duplicate cards. Capacity verification separately increases the number of concurrent nine-client campaigns, measures Worker requests/CPU and D1 query duration/overload, and records the safe operating knee for the production plan. Hidden-tab pausing, dashboard backoff, no-change payload size, and the short-lived cursor cache are measured explicitly.

## 18. Acceptance criteria

Acceptance is incremental rather than all-or-nothing.

### Increment 0/0.5 — rules foundation

- Every `supported-v1` entry in the reviewed versioned procedure audit maps to generated content or a named engine modifier; deferred and non-tarot entries have explicit rationales.
- `tarot-procedures.json` regenerates from Markdown and passes drift, citation, schema, and reference checks.
- The standalone resolution engine passes the correct pre-test Resolve/favor, free push, Fool-on-push, favor/disfavor, aid, and group-test suite.

### Increment 1 — campaign foundation

- A GM can create a campaign, manage one Guild Roster, and share/close/reopen/rotate a join link.
- A signed-in player can join immediately while the link is open and may remain a member without an adventurer.
- Database constraints prevent two active adventurers for one membership and one adventurer in two campaigns; only eligible owned completed adventurers attach.
- Character life and integer-version migrations work on clean and populated databases without JSON/column drift.
- One active/frozen session is permitted per campaign, and its stored runtime content survives a newer application deployment.

### Increment 2 — shared table core

- Fresh correctly split decks, generic card commands, tests, and Crawl procedures survive refresh/reconnect and conserve every card.
- The GM cannot obtain a player's private card face through any supported application response or rendering path.
- Every accepted command is idempotent, invariant-safe, atomic, and auditable; independent same-version player commands normally succeed through server retry.
- Visible connected participants receive accepted commands within two seconds at the single-table baseline.

### Increment 3 — Challenge

- Challenge rounds cover private hands, Initiative, actions, interrupts, facedown cards, all Fool behavior, mulligan, end-of-round cleanup, and deck exhaustion.
- The GM hand formula recalculates each round, and lesser/greater doom, parity, play/discard, and denizen card predicates are enforced.
- Living adventurers cannot be swapped during play; death opens replacement at a legal boundary and preserves historical tenure.
- Resolve can be spent for pre-test favor only after explicit confirmation and is not charged for pushing fate.

### Increment 4 — completion

- Every remaining `supported-v1` Camp, City, sorcery, oracle, and cross-cutting audit entry has a passing engine/service test.
- The character owner and scoped campaign GM can mark an attached adventurer dead, with an audited correction path.
- A player can leave during an active session, releasing their character without leaking hidden cards; ordinary mid-session replacement remains prohibited.
- Everyone currently in the campaign can view completed public history, while unrevealed faces and shuffle reconstruction data have been purged.
- Frozen sessions block archival and provide a safe end/export path.

### Increment 5 — public enablement

- The authorized Rider–Waite–Smith art renders uncropped in an Archival Frame with responsive formats and recorded credits.
- Engine, content, service, privacy, Playwright, accessibility, migration, remote-D1 smoke, Cloudflare build, and concurrent-campaign capacity suites pass.
- The deployed Cloudflare plan and measured capacity support the polling target; the server feature flag is enabled before public navigation appears.

## 19. Deferred extensions

The architecture leaves explicit seams for later GM preparation tools, co-GMs, GM ownership transfer, richer roster collaboration, long-term campaign exports, WebSocket/Durable Object transport, and additional content packs. **Hold a Funeral** is also deferred: the death/tenure history retains the old and replacement character IDs needed for a later audited XP transfer, but v1 does not mutate XP or gold. None of those seams may weaken the first-release authorization, privacy, or card-conservation model.

## 20. Source references

Repository references used for this design:

- `AGENTS.md`
- `assets-src/HMTW_md/01 - Chapter 1 - The Basics.md`
- `assets-src/HMTW_md/02 - Chapter 2 - The Adventurer.md`
- `assets-src/HMTW_md/03 - Chapter 3 - The Guild.md`
- `assets-src/HMTW_md/04 - Chapter 4 - Kith and Kin.md`
- `assets-src/HMTW_md/05 - Chapter 5 - The Four Paths.md`
- `assets-src/HMTW_md/06 - Chapter 6 - The Crawl Phase.md`
- `assets-src/HMTW_md/07 - Chapter 7 - The Challenge Phase.md`
- `assets-src/HMTW_md/08 - Chapter 8 - The Camp Phase.md`
- `assets-src/HMTW_md/09 - Chapter 9 - The City Phase.md`
- `assets-src/HMTW_md/10 - Chapter 10 - The Worm Turns - Gamemastering.md`
- `assets-src/HMTW_md/11 - Appendix A - Sorcery.md`
- `assets-src/HMTW_md/12 - Appendix B - Alchemy.md`
- `assets-src/HMTW_md/13 - Appendix C - Dungeon Denizens.md`
- `assets-src/HMTW_md/14 - Appendix D - City Creation.md`
- `assets-src/HMTW_md/15 - Appendix E - Underworld Creation.md`
- `src/lib/engine/tarot-deck.ts`
- `src/lib/engine/tarot-resolution.ts`
- `src/lib/server/db/schema.ts`
- `src/lib/components/tarot/`
- `src/routes/deck/`
- `static/content-packs/hmtw/`
- `docs/superpowers/specs/2026-07-15-campaigns-shared-tarot-design-review.md`

Cloudflare references used for the transport and persistence design:

- D1 `batch()` transaction behavior: <https://developers.cloudflare.com/d1/worker-api/d1-database/#batch>
- D1 limits and single-threaded database behavior: <https://developers.cloudflare.com/d1/platform/limits/>
- D1 SQLite/trigger compatibility reference: <https://developers.cloudflare.com/d1/sql-api/sql-statements/>
- Workers pricing and request/CPU allowances: <https://developers.cloudflare.com/workers/platform/pricing/>

The Table First and Archival Frame choices, campaign/session naming, privacy boundary, and lifecycle decisions were approved in the interactive design review on 2026-07-15 and are recorded normatively in this specification.
