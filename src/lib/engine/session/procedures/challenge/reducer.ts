/**
 * Setup and round-boundary orchestration for the Challenge procedure (Ch7,
 * "The Flow of the Challenge Phase"). Composes the shared session engine's
 * public `reduceSession` API — every card movement here is an ordinary
 * `SessionCommand` run through the same authorization/invariant pipeline
 * every other procedure uses — plus a Challenge-only state slice
 * (`ChallengeStateV1`) stored in `SessionEngineStateV1.procedure.gmPrivate`,
 * exactly as `types.ts` documents. This module never reaches into
 * `card-commands.ts` directly and the shared `reducer.ts`/`card-commands.ts`
 * needed no changes to support it (see the Increment 3 Task 2 report for
 * why). Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * Dealing (`dealRound`/`calculateGmHandSize`) lives in `deal.ts`; Initiative
 * placement/reveal lives in `initiative.ts`. Both import the zone-id
 * conventions and `ChallengeStateV1` read/write helpers defined here.
 */

import type {
	CardId,
	SessionEngineStateV1,
	SessionEvent,
	SessionRejection,
	TarotCardCatalog
} from '$lib/types/session';
import { z } from 'zod';
import { assertSessionInvariants } from '../../invariants';
import { findZoneDescriptor } from '../../state';
import { FIXED_ZONE_IDS } from '../../zones';
import { reduceSession, type ReduceContext } from '../../reducer';
import type { ReduceResult } from '../../result';
import {
	challengeEnemyFactSchema,
	challengeStateV1Schema,
	challengeTenureIdSchema,
	challengeTenureOwnersSchema
} from './schema';
import type { ChallengeConfig, ChallengeEnemyFact, ChallengeParticipantBudget, ChallengeStateV1 } from './types';

/** Alias matching the shared `reducer.ts`'s own `SessionReduceResult` —
 * every Challenge procedure function returns this same shape so callers can
 * treat `reduceSession` and Challenge functions interchangeably. */
export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

/** The content pack's `challenge-round` procedure id — the only
 * `ProcedureState.procedureId` this module ever begins/reads/completes. */
export const CHALLENGE_PROCEDURE_ID = 'challenge-round';

/** Sentinel budget/initiative key for the GM's collective turn resources —
 * matches the convention already fixed by Task 1's schema test fixture
 * (`tests/unit/session/challenge/content.test.ts`'s `budgets: {..., gm: ...}`).
 * Not a tenure id (the GM has none); a stable engine-level key, same spirit
 * as `card-commands.ts`'s `FOOL_CARD_ID`. */
export const CHALLENGE_GM_TENURE_ID = 'gm';

/** The content pack's `challenge-stun` modifier id. Defined HERE (not in
 * `modifiers.ts`, which owns the other six modifier id constants) because
 * `cleanupRound` (below) needs to name it when expiring an unresolved
 * pending Stun at the round boundary (Increment 3 Task 4 review, round 5) —
 * `modifiers.ts` imports FROM this module, so the reverse dependency would
 * be circular. `modifiers.ts` re-exports this constant so its own public
 * surface (and every existing import of `CHALLENGE_STUN_ID` from there) is
 * unchanged. */
export const CHALLENGE_STUN_ID = 'challenge-stun';

/** The one shared public zone Initiative cards are revealed into. Persists
 * across rounds (cleared, not recreated, at round cleanup). */
export const CHALLENGE_INITIATIVE_ZONE_ID = 'challenge-initiative';

/** A participant's private hand zone id — keyed by TENURE id, matching the
 * convention already established by `tests/fixtures/session.ts`'s
 * `fixtureWithHands` (`hand:<id>`). The zone's `ownerUserId` is NOT this id —
 * a tenure is not a user id (see `types.ts`'s `ChallengeStateV1.tenureOwners`
 * doc comment) — it is resolved through `tenureOwners` by
 * `ensureParticipantZones`, below. Zone ids stay tenure-keyed deliberately:
 * on death the same user attaches a new tenure, and keeping zone identity
 * tied to the tenure (not the user) is what lets Task 5 address a dead
 * adventurer's private zones separately from their replacement's. */
export function challengeHandZoneId(tenureId: string): string {
	return `hand:${tenureId}`;
}

/** A participant's pre-reveal facedown Initiative zone. Deliberately a
 * distinct zone id from any later "sustained facedown action" zone a future
 * task might add for the same owner (Ch7 "Facedown Cards": "Your Initiative
 * card does not count towards this limit!" — two different game concepts,
 * so two different zones, both legitimately `kind: 'player-facedown'`). */
export function challengeInitiativeFacedownZoneId(tenureId: string): string {
	return `challenge-initiative-facedown:${tenureId}`;
}

/**
 * A GM-controlled enemy fact's pre-reveal facedown Initiative zone (Ch7
 * `challenge-play-initiative`: "The GM will play one Initiative card for
 * each significant character or group of characters they control" —
 * `enemyFacts` is exactly that roster of groups, per the coordinator's
 * concern-2 guidance). Unlike a player's facedown zone this can't live in
 * `state.privateZones` — every entry there is unconditionally tagged
 * `owner: {kind: 'player', ...}` by `zones.ts`'s `listZoneDescriptors`, and
 * the GM is not a player. `state.pendingZones` is the correct generic
 * primitive instead: `visibility: 'hidden'`, GM-only access
 * (`actorMayAccessZone`), and — like every pending zone — the public
 * projection's `pendingZoneCounts` already surfaces an occupied-but-hidden
 * count for it with zero projection-layer changes, the pending-zone analog
 * of a player's facedown "card back."
 */
export function challengeGmInitiativeZoneId(enemyFactId: string): string {
	return `challenge-gm-initiative-facedown:${enemyFactId}`;
}

/**
 * A tenure's prepared/facedown Aim zone (`modifiers.ts`'s `prepareAim`/
 * `resolveAim` — content pack `challenge-aim`, "Aim is a Swords action ...
 * play your card facedown. When you next Attack with your bow, you may
 * reveal the card" — Ch9 "Bow"). Deliberately distinct from
 * `challengeInitiativeFacedownZoneId` (a different game concept — Ch7
 * "Facedown Cards": "Your Initiative card does not count towards this
 * limit!") and never swept at round cleanup: `challenge-end-the-round` is
 * explicit that "Facedown actions are left facedown," and `revealOn:
 * 'next-bow-attack'` can legitimately span a round boundary.
 */
export function challengeAimZoneId(tenureId: string): string {
	return `challenge-aim-facedown:${tenureId}`;
}

/**
 * The TARGET's facedown Guardian Angel zone (`modifiers.ts`'s
 * `applyGuardianAngel` — content pack `challenge-guardian-angel`, Appendix A
 * Sorcery: "the sorcerer hands the target the card used for Speak
 * Incantation. This card is placed facedown in front of the target
 * player"). Owned by the TARGET, not the caster — the caster's card leaves
 * their hand and becomes the target's held defense. Multiple different
 * casters may each place a card here for the same target ("cumulative"); a
 * single caster may not maintain more than one active instance at a time
 * ("you cannot have multiple instances of this spell at the same time" —
 * enforced by `applyGuardianAngel` reading `ChallengeStateV1.modifiers`, not
 * by this zone, which has no notion of who placed which card). Never swept
 * at round cleanup — `duration: 'until-used'` can span a round boundary,
 * same reasoning as `challengeAimZoneId`.
 */
export function challengeGuardianAngelZoneId(targetTenureId: string): string {
	return `challenge-guardian-angel-facedown:${targetTenureId}`;
}

/**
 * A CASTER-owned, purely transient staging zone `applyGuardianAngel` moves
 * the Speak Incantation card into via the ordinary budgeted `spendCard`
 * choke point (a same-owner move the generic engine's authorization already
 * permits), immediately before handing it off to the target's
 * `challengeGuardianAngelZoneId` zone (a cross-owner move the generic
 * engine's actor-based zone authorization cannot express — see
 * `transfers.ts`'s file header). Always empty again by the time
 * `applyGuardianAngel` returns; kept as its own zone id (rather than reusing
 * `challengeInitiativeFacedownZoneId`) so it can never collide with a
 * genuinely-held Initiative placement.
 */
export function challengeGuardianAngelStagingZoneId(casterTenureId: string): string {
	return `challenge-guardian-angel-staging:${casterTenureId}`;
}

/**
 * Resolves the ACTIVE participant tenure owned by `userId`, or `undefined`
 * if `userId` owns none (not a current participant, or a GM/spectator).
 * Several Increment 3 Task 4 modifiers (Counsel, Guardian Angel) act on
 * behalf of "the caster's own tenure" without the caller having to pass it
 * explicitly — this is the single reverse-lookup helper through
 * `tenureOwners`, matching every other Challenge authorization check's rule
 * that a tenure is resolved through the map, never compared against
 * `actor.userId` directly (O7).
 */
export function tenureIdForUser(challenge: ChallengeStateV1, userId: string): string | undefined {
	return challenge.participantTenureIds.find((tenureId) => challenge.tenureOwners[tenureId] === userId);
}

export function reject(code: SessionRejection['code'], message: string): SessionReduceResult {
	return { ok: false, rejection: { code, message } };
}

/**
 * Validates a GM-supplied `enemyFacts` array structurally (against
 * `challengeEnemyFactSchema`) AND against two Challenge-specific invariants
 * Zod alone can't express: no two entries may share an `id`, and no entry's
 * `id` may collide with a `participantTenureId` (Increment 3 Task 2 review,
 * Important 3). Both defects silently collapse two Initiative entries into
 * one at `revealInitiative` time — `ensureEnemyInitiativeZones` creates only
 * one zone for a duplicated id, so the second `placeGmInitiative` is rejected
 * as "already placed" while `revealInitiative`'s missing-key check is
 * satisfied for both by the single surviving entry, and a reveal silently
 * proceeds representing two enemy groups (or an enemy and a player) with one
 * card. Called at the top of both `beginChallenge` and `cleanupRound`,
 * before either performs any state mutation, so a rejection here never
 * leaves a half-applied intent (Important 2 — the same reasoning that
 * requires `safeParse` over `parse`).
 *
 * Returns a human-readable rejection message, or `null` if `enemyFacts` is
 * valid.
 */
function validateEnemyFacts(enemyFacts: unknown, participantTenureIds: readonly string[]): string | null {
	const parsed = z.array(challengeEnemyFactSchema).safeParse(enemyFacts);
	if (!parsed.success) {
		return `invalid enemyFacts: ${parsed.error.message}`;
	}

	const seenIds = new Set<string>();
	for (const enemy of parsed.data) {
		if (seenIds.has(enemy.id)) {
			return `duplicate enemyFacts id: ${enemy.id}`;
		}
		seenIds.add(enemy.id);
		if (participantTenureIds.includes(enemy.id)) {
			return `enemyFacts id collides with a participant tenure id: ${enemy.id}`;
		}
	}
	return null;
}

/**
 * Validates a `tenureId -> userId` mapping structurally (against
 * `challengeTenureOwnersSchema`) AND covers every id in `tenureIds`. The
 * Challenge module previously conflated tenure id with user id: zone
 * ownership (`ensureParticipantZones`) set `ownerUserId` to the tenure id
 * itself, and `placeInitiative`'s authorization compared `actor.userId`
 * directly against the tenure id. Both only worked because every test
 * happened to pass the same string as both ids. A tenure (Increment 1) is an
 * adventurer's attachment to a campaign membership, never a user id — Task 5
 * hands real tenure ids that are NOT user ids, and death reattaches the same
 * user to a brand-new tenure. Called at the top of both `beginChallenge` and
 * `cleanupRound`, before either performs any state mutation (same reasoning
 * as `validateEnemyFacts`).
 *
 * Returns a human-readable rejection message, or `null` if `tenureOwners` is
 * valid and covers every id in `tenureIds`.
 */
function validateTenureOwners(tenureIds: readonly string[], tenureOwners: unknown): string | null {
	const parsed = challengeTenureOwnersSchema.safeParse(tenureOwners);
	if (!parsed.success) {
		return `invalid tenureOwners: ${parsed.error.message}`;
	}
	for (const tenureId of tenureIds) {
		if (!(tenureId in parsed.data)) {
			return `no owner registered for tenure ${tenureId}`;
		}
	}
	return null;
}

/**
 * Validates a raw, caller-supplied `participantTenureIds` array structurally
 * (non-empty trimmed strings). Without this, a blank/whitespace-only id could
 * pass `validateTenureOwners`' coverage check (as long as the same blank
 * string was also registered as a `tenureOwners` key) and reach
 * `writeChallengeState`'s throwing `.parse` instead of a clean rejection —
 * the same defect class as `validateEnemyFacts`/`validateTenureOwners`, on
 * the roster itself (Increment 3 Task 2 review, Minor). `cleanupRound` needs
 * no equivalent call: its roster is always built from `challenge.
 * participantTenureIds`/`challenge.pendingJoinTenureIds`, both of which were
 * already validated when the state that produced `challenge` was written.
 *
 * Returns a human-readable rejection message, or `null` if valid.
 */
function validateParticipantTenureIds(participantTenureIds: unknown): string | null {
	const parsed = z.array(challengeTenureIdSchema).safeParse(participantTenureIds);
	if (!parsed.success) {
		return `invalid participantTenureIds: ${parsed.error.message}`;
	}
	return null;
}

/**
 * Rejects an `options.tenureOwners` remap (`cleanupRound`) that tries to
 * re-point a tenure ALREADY in `activeTenureIds` (the current round's
 * `participantTenureIds`, before admitting any pending join) to a different
 * owner than it currently has. `CleanupRoundOptions.tenureOwners` exists to
 * register a newly-admitted `pendingJoinTenureIds` entry's owner — not to
 * re-own an already-live tenure. `ensureParticipantZones` only ever CREATES
 * missing zones; it never re-owns an existing one, so a silently-accepted
 * conflicting remap would desync `placeInitiative`'s authorization (which
 * reads `tenureOwners`, so it would authorize the NEW user) from the hand
 * zone's actual, unchanged `ownerUserId` (still the OLD user, so only they
 * can see it in `privateHand`) — both outcomes wrong at once. Re-pointing a
 * live tenure to a different user mid-Challenge isn't a real operation
 * (Increment 3 Task 2 coordinator decision, option (a): reject rather than
 * re-own).
 *
 * Returns a human-readable rejection message, or `null` if there is no
 * conflict (including when `remap` is `undefined` or doesn't mention any
 * already-active tenure).
 */
function validateNoTenureOwnerRemap(
	activeTenureIds: readonly string[],
	currentOwners: Record<string, string>,
	remap: Record<string, string> | undefined
): string | null {
	if (!remap) return null;
	for (const tenureId of activeTenureIds) {
		if (!(tenureId in remap)) continue;
		if (remap[tenureId] !== currentOwners[tenureId]) {
			return `cannot re-point already-active tenure ${tenureId} to a different owner mid-Challenge`;
		}
	}
	return null;
}

/** The context every Challenge procedure function takes: the generic
 * session `ReduceContext` (actor/runtime/rng) plus the content-hydrated
 * `ChallengeConfig` (`buildChallengeConfig` in `schema.ts`). Structurally a
 * `ReduceContext`, so it can be passed anywhere `reduceSession` expects one
 * without conversion. */
export interface ChallengeReduceContext extends ReduceContext {
	config: ChallengeConfig;
}

/** Reads and validates the active Challenge state from `state.procedure.gmPrivate`.
 * Returns `undefined` if no `challenge-round` procedure is active or its
 * `gmPrivate` doesn't parse — never throws, so callers can turn this into a
 * proper `SessionRejection` rather than an uncaught error. */
export function readChallengeState(state: SessionEngineStateV1): ChallengeStateV1 | undefined {
	if (!state.procedure || state.procedure.procedureId !== CHALLENGE_PROCEDURE_ID) return undefined;
	const result = challengeStateV1Schema.safeParse(state.procedure.gmPrivate);
	return result.success ? result.data : undefined;
}

/** Validates `challenge` and writes it back as `state.procedure.gmPrivate`.
 * Throws (a reducer bug, not a rejectable user error) if no procedure is
 * active — every caller here only reaches this after confirming one is. */
export function writeChallengeState(state: SessionEngineStateV1, challenge: ChallengeStateV1): SessionEngineStateV1 {
	if (!state.procedure) throw new Error('writeChallengeState: no active procedure');
	const validated = challengeStateV1Schema.parse(challenge);
	return { ...state, procedure: { ...state.procedure, gmPrivate: validated } };
}

/** Fresh per-round budgets: one `{cardsThisTurn:0, actionTaken:false,
 * discards:null}` per participant tenure (O5 — players track no discard
 * budget of their own) plus one `discards:0` entry for the GM (O5/O3 —
 * `gmDiscardsLimitedByHand`). */
export function initialBudgets(tenureIds: readonly string[]): Record<string, ChallengeParticipantBudget> {
	const budgets: Record<string, ChallengeParticipantBudget> = {};
	for (const tenureId of tenureIds) {
		budgets[tenureId] = { cardsThisTurn: 0, actionTaken: false, discards: null };
	}
	budgets[CHALLENGE_GM_TENURE_ID] = { cardsThisTurn: 0, actionTaken: false, discards: 0 };
	return budgets;
}

/** Creates any missing hand/Initiative-facedown zones for `tenureIds`,
 * idempotently (a no-op for already-provisioned participants — used both at
 * setup and again at round cleanup when pending joins are admitted). Each
 * zone's `ownerUserId` is resolved through `tenureOwners` — NEVER the tenure
 * id itself (see `challengeHandZoneId`'s doc comment). Callers
 * (`beginChallenge`/`cleanupRound`) always run `validateTenureOwners` first,
 * so a missing entry here means a reducer bug, not a rejectable user error —
 * it throws rather than silently falling back to the tenure id, which would
 * quietly reintroduce the exact conflation this function exists to prevent. */
function ensureParticipantZones(
	state: SessionEngineStateV1,
	tenureIds: readonly string[],
	tenureOwners: Record<string, string>
): SessionEngineStateV1 {
	let privateZones = state.privateZones;
	for (const tenureId of tenureIds) {
		const ownerUserId = tenureOwners[tenureId];
		if (ownerUserId === undefined) {
			throw new Error(`ensureParticipantZones: no owner registered for tenure ${tenureId} (should have been validated upstream)`);
		}
		const handId = challengeHandZoneId(tenureId);
		const initiativeId = challengeInitiativeFacedownZoneId(tenureId);
		if (!privateZones.some((zone) => zone.id === handId)) {
			privateZones = privateZones.concat({ id: handId, kind: 'player-hand', ownerUserId, cards: [] });
		}
		if (!privateZones.some((zone) => zone.id === initiativeId)) {
			privateZones = privateZones.concat({
				id: initiativeId,
				kind: 'player-facedown',
				ownerUserId,
				cards: []
			});
		}
	}
	return privateZones === state.privateZones ? state : { ...state, privateZones };
}

function ensureInitiativeZone(state: SessionEngineStateV1): SessionEngineStateV1 {
	if (state.publicZones.some((zone) => zone.id === CHALLENGE_INITIATIVE_ZONE_ID)) return state;
	return {
		...state,
		publicZones: state.publicZones.concat({ id: CHALLENGE_INITIATIVE_ZONE_ID, kind: 'initiative', cards: [] })
	};
}

/** Creates any missing GM-private enemy-Initiative pending zones for
 * `enemyFactIds`, idempotently — mirrors `ensureParticipantZones`, called
 * both at setup and again at round cleanup once the next round's
 * `enemyFacts` are known (a shrinking/growing enemy roster changes which
 * zones are needed; a stale zone for a no-longer-present enemy is simply
 * never placed into or read again). */
function ensureEnemyInitiativeZones(state: SessionEngineStateV1, enemyFactIds: readonly string[]): SessionEngineStateV1 {
	let pendingZones = state.pendingZones;
	for (const enemyFactId of enemyFactIds) {
		const zoneId = challengeGmInitiativeZoneId(enemyFactId);
		if (!pendingZones.some((zone) => zone.id === zoneId)) {
			pendingZones = pendingZones.concat({ id: zoneId, deck: 'major', cards: [] });
		}
	}
	return pendingZones === state.pendingZones ? state : { ...state, pendingZones };
}

/** The GM-supplied inputs that start a Challenge round (Ch7 step 0, "Set the
 * scene" — the GM has already framed the scene and knows who's fighting).
 * Not a `SessionCommand` variant: these values have no home in the generic
 * command vocabulary, which is exactly why they're threaded through this
 * procedure-specific function instead. */
export interface BeginChallengeCommand {
	participantTenureIds: string[];
	enemyFacts: ChallengeEnemyFact[];
	/** `tenureId -> owning userId` for every entry in `participantTenureIds` —
	 * see `types.ts`'s `ChallengeStateV1.tenureOwners` doc comment for why
	 * this can't be inferred from the tenure id itself. May carry extra
	 * entries beyond the current roster (e.g. a future joiner's owner,
	 * already known ahead of admission). */
	tenureOwners: Record<string, string>;
}

/**
 * Starts a Challenge round: begins the `challenge-round` procedure, creates
 * each participant's hand/Initiative zones and the shared public Initiative
 * zone, and seeds `ChallengeStateV1` at `stage: 'deal', round: 1` — ready for
 * `dealRound` (`deal.ts`). GM-only (Global Constraint: "GM advances Challenge
 * phases and rounds").
 */
export function beginChallenge(
	state: SessionEngineStateV1,
	command: BeginChallengeCommand,
	context: ChallengeReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may begin a Challenge round');
	}
	if (state.procedure !== null) {
		return reject('illegal-command', 'a procedure is already active');
	}

	const participantTenureIds = [...new Set(command.participantTenureIds)];
	if (participantTenureIds.length === 0) {
		return reject('illegal-command', 'a Challenge round needs at least one participant');
	}

	// Validate BEFORE any state mutation (including `begin-procedure` below) —
	// a `ZodError` throw here would crash the engine with `begin-procedure`
	// already applied, leaving a half-applied intent (Important 2); a
	// duplicate/colliding id here would otherwise silently collapse two
	// Initiative entries into one at reveal time (Important 3); a tenure with
	// no registered owner would otherwise make its own zones misowned
	// (tenureId-vs-userId fix); a blank/whitespace-only tenure id would
	// otherwise reach `writeChallengeState`'s throwing `.parse` (Minor).
	const participantTenureIdsError = validateParticipantTenureIds(participantTenureIds);
	if (participantTenureIdsError) {
		return reject('illegal-command', participantTenureIdsError);
	}
	const tenureOwnersError = validateTenureOwners(participantTenureIds, command.tenureOwners);
	if (tenureOwnersError) {
		return reject('illegal-command', tenureOwnersError);
	}
	const enemyFactsError = validateEnemyFacts(command.enemyFacts, participantTenureIds);
	if (enemyFactsError) {
		return reject('illegal-command', enemyFactsError);
	}

	const beginResult = reduceSession(state, { type: 'begin-procedure', procedureId: CHALLENGE_PROCEDURE_ID }, context);
	if (!beginResult.ok) return beginResult;

	let nextState = ensureParticipantZones(beginResult.state, participantTenureIds, command.tenureOwners);
	nextState = ensureInitiativeZone(nextState);
	nextState = ensureEnemyInitiativeZones(nextState, command.enemyFacts.map((enemy) => enemy.id));

	const challenge: ChallengeStateV1 = {
		schemaVersion: 1,
		stage: 'deal',
		round: 1,
		participantTenureIds,
		tenureOwners: command.tenureOwners,
		pendingJoinTenureIds: [],
		enemyFacts: command.enemyFacts,
		initiativeOrder: [],
		tiedGroups: [],
		activeTurnIndex: null,
		turnKind: null,
		budgets: initialBudgets(participantTenureIds),
		mulliganUsedThisRound: false,
		modifiers: []
	};
	nextState = writeChallengeState(nextState, challenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const event: SessionEvent = {
		kind: 'challenge-begun',
		publicPayload: {
			participantTenureIds,
			round: 1,
			enemyTypeCount: new Set(command.enemyFacts.flatMap((enemy) => enemy.typeIds)).size
		}
	};
	return { ok: true, state: nextState, events: [...beginResult.events, event] };
}

/** Which public zone kinds round cleanup sweeps to discard piles. `played`
 * doesn't exist yet in Task 2 (Task 3 owns plays) — swept generically, by
 * kind, so cleanup keeps working once Task 3 starts populating it, with no
 * change needed here. `revealed`/`inspiration` are deliberately absent (O6:
 * "leaves ... inspiration zones untouched").
 *
 * Sustained `player-facedown`/`player-prepared` zones (a future task's
 * "held" defensive/prepared actions — e.g. Dodge, Aim) are absent from this
 * sweep too, and deliberately never swept by kind at all: rule
 * `challenge-end-the-round` is explicit — "Facedown actions are left
 * facedown" — only hands and the played/Initiative public zones clear at the
 * round boundary. Task 2 never creates a sustained facedown/prepared zone of
 * its own, so there is nothing here for this task to leave alone beyond not
 * reaching for it; this note exists so a later task adding one doesn't need
 * to re-derive the rule. The per-tenure Initiative *placement* zone
 * (`challengeInitiativeFacedownZoneId`, `player-facedown`-kind) and the
 * per-enemy one (`challengeGmInitiativeZoneId`, a GM-only pending zone) are
 * already empty by the time cleanup runs — `revealInitiative` transfers
 * their one card out at reveal — so neither needs an explicit sweep entry
 * either. */
const CLEANUP_SWEPT_PUBLIC_ZONE_KINDS = new Set(['played', 'initiative']);

export interface CleanupRoundOptions {
	/** GM-supplied refreshed enemy facts for the next round (Ch7:
	 * "if the number of enemies decreases, you will draw fewer major arcana
	 * cards" — the GM updates the scene between rounds; recording that update
	 * is this option, not a fabricated automatic mechanic). Carries the
	 * current round's `enemyFacts` forward unchanged when omitted. */
	enemyFacts?: ChallengeEnemyFact[];
	/** Additional `tenureId -> userId` entries, merged onto the current
	 * round's `tenureOwners`. Exists ONLY to register a newly-admitted
	 * `pendingJoinTenureIds` entry's owner — one not already registered — at
	 * the same moment it's admitted into `participantTenureIds`. An entry
	 * here for a tenure that is ALREADY in the current round's
	 * `participantTenureIds` is rejected if it names a different owner than
	 * that tenure already has (`validateNoTenureOwnerRemap`): re-pointing a
	 * live tenure to a different user mid-Challenge isn't a real operation,
	 * and `ensureParticipantZones` only ever creates missing zones — it never
	 * re-owns an existing one, so a silently-accepted remap would desync
	 * `placeInitiative`'s authorization (reads this map) from the hand zone's
	 * actual, unchanged `ownerUserId` (Increment 3 Task 2 coordinator
	 * decision, option (a)). Carries the current map forward unchanged when
	 * omitted. */
	tenureOwners?: Record<string, string>;
}

/**
 * Ends the current round: discards every card in the played/Initiative
 * public zones and every hand (player hands + the GM hand) to its deck's
 * discard pile, resolves any Fool-scheduled reshuffles (`end-round`), clears
 * per-round budgets/modifiers/mulligan-used, admits pending replacement
 * tenures, increments `round`, and leaves `stage: 'deal'` ready for the next
 * `dealRound` call — which recalculates both hand-size targets fresh from
 * whatever `enemyFacts`/`participantTenureIds` now read (O6). GM-only.
 *
 * Deliberately does NOT itself call `dealRound` — round 1 requires a
 * separate explicit `dealRound` call after `beginChallenge`, and every later
 * round follows the identical two-call shape for consistency.
 *
 * Callable once the round has reached `initiative-reveal` or later (`turns`,
 * or an already-in-progress `round-cleanup`) — Task 2 has no turn machinery
 * of its own to require passing through a specific `turns` sub-state first.
 */
export function cleanupRound(
	state: SessionEngineStateV1,
	context: ChallengeReduceContext,
	options: CleanupRoundOptions = {}
): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may end a Challenge round');
	}
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (!['initiative-reveal', 'turns', 'round-cleanup'].includes(challenge.stage)) {
		return reject('illegal-command', `cannot clean up during stage ${challenge.stage}`);
	}

	// Computed and validated BEFORE any state mutation (the discard sweep
	// below) so an invalid `options.enemyFacts`/`options.tenureOwners` is
	// rejected with the state untouched, not after `begin-procedure`-
	// equivalent work has already run (Important 2/3 — same reasoning as
	// `beginChallenge`; tenureOwners coverage is the same fix, extended to
	// cleanup's admitted-pending-join roster).
	//
	// De-duplicated with `[...new Set(...)]`, matching `beginChallenge`
	// (Important 1 — re-review): a pending join naming an already-active
	// tenure would otherwise duplicate the id here, so a single
	// `initiativeOrder` entry would satisfy `revealInitiative`'s missing-key
	// check for both listed seats — the same collapse `validateEnemyFacts`
	// exists to prevent, on the player side.
	const nextParticipantTenureIds = [...new Set([...challenge.participantTenureIds, ...challenge.pendingJoinTenureIds])];

	// Reject a conflicting remap of an ALREADY-ACTIVE tenure before merging —
	// see `validateNoTenureOwnerRemap`'s doc comment and this interface's
	// `tenureOwners` field doc comment (Important 2 — re-review, option (a)).
	const tenureOwnerRemapError = validateNoTenureOwnerRemap(challenge.participantTenureIds, challenge.tenureOwners, options.tenureOwners);
	if (tenureOwnerRemapError) {
		return reject('illegal-command', tenureOwnerRemapError);
	}
	const nextTenureOwners = { ...challenge.tenureOwners, ...(options.tenureOwners ?? {}) };
	const tenureOwnersError = validateTenureOwners(nextParticipantTenureIds, nextTenureOwners);
	if (tenureOwnersError) {
		return reject('illegal-command', tenureOwnersError);
	}
	const nextEnemyFacts = options.enemyFacts ?? challenge.enemyFacts;
	const enemyFactsError = validateEnemyFacts(nextEnemyFacts, nextParticipantTenureIds);
	if (enemyFactsError) {
		return reject('illegal-command', enemyFactsError);
	}

	let nextState: SessionEngineStateV1 = state;
	const events: SessionEvent[] = [];

	const sweepZoneIds = [
		...nextState.publicZones.filter((zone) => CLEANUP_SWEPT_PUBLIC_ZONE_KINDS.has(zone.kind)).map((zone) => zone.id),
		...challenge.participantTenureIds.map(challengeHandZoneId),
		FIXED_ZONE_IDS.gmHand
	];

	for (const zoneId of sweepZoneIds) {
		const zone = findZoneDescriptor(nextState, zoneId);
		if (!zone) continue;
		for (const cardId of zone.cards.slice()) {
			const discardResult = discardOneCard(nextState, zoneId, cardId, context);
			if (!discardResult.ok) return discardResult;
			nextState = discardResult.state;
			events.push(...discardResult.events);
		}
	}

	const endRoundResult = reduceSession(nextState, { type: 'end-round' }, context);
	if (!endRoundResult.ok) return endRoundResult;
	nextState = endRoundResult.state;
	events.push(...endRoundResult.events);

	nextState = ensureParticipantZones(nextState, nextParticipantTenureIds, nextTenureOwners);
	nextState = ensureEnemyInitiativeZones(nextState, nextEnemyFacts.map((enemy) => enemy.id));

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		stage: 'deal',
		round: challenge.round + 1,
		participantTenureIds: nextParticipantTenureIds,
		tenureOwners: nextTenureOwners,
		pendingJoinTenureIds: [],
		enemyFacts: nextEnemyFacts,
		initiativeOrder: [],
		tiedGroups: [],
		activeTurnIndex: null,
		turnKind: null,
		budgets: initialBudgets(nextParticipantTenureIds),
		mulliganUsedThisRound: false,
		// Round-scoped modifier instances (Counsel's once-per-round cap,
		// Black Honey's already-eaten-this-round gate — both recorded
		// `status: 'resolved'` the instant they resolve, Increment 3 Task 4)
		// are cleared here so next round's caps start fresh. A modifier whose
		// OWN duration outlives the round boundary (Guardian Angel's
		// `duration: 'until-used'`, tracked `status: 'active'` until actually
		// triggered) is deliberately carried forward — its physical card
		// already survives cleanup untouched (facedown/prepared zones are
		// never swept here, `challenge-end-the-round`: "Facedown actions are
		// left facedown"), so silently dropping its bookkeeping entry would
		// desync the two and let a caster re-cast past `maxInstances: 1`.
		//
		// Stun is the one exception (review round 5): content says
		// `immediate: true` and the rule states "It is an instantaneous
		// effect," so a `'pending'` Stun (the GM recorded it but the target
		// never chose a card — `modifiers.ts`'s `applyStun`/`resolveStun`)
		// must NOT bank across a round boundary the way Guardian Angel's
		// genuinely round-spanning `'active'` wards do. Expired to
		// `'expired'` here, SCOPED TO `CHALLENGE_STUN_ID` only, before the
		// existing keep-filter runs — every other modifier's carry-forward
		// rule (including any future one that legitimately uses `'pending'`
		// for something that SHOULD span rounds) is unaffected.
		//
		// Every existing fixture's `modifiers` array is empty before
		// Increment 3 Task 4, so both this expiry and the filter below are a
		// no-op for every pre-Task-4 test.
		modifiers: challenge.modifiers
			.map((modifier) =>
				modifier.modifierId === CHALLENGE_STUN_ID && modifier.status === 'pending'
					? { ...modifier, status: 'expired' as const }
					: modifier
			)
			.filter((modifier) => modifier.status === 'active' || modifier.status === 'pending')
	};
	nextState = writeChallengeState(nextState, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	events.push({
		kind: 'challenge-round-ended',
		publicPayload: { completedRound: challenge.round, nextRound: nextChallenge.round }
	});

	return { ok: true, state: nextState, events };
}

/** Discards one named card from `zoneId`, routing it to the discard pile of
 * *its own* deck (not the source zone's — `played`/`initiative` zones are
 * `deck: 'both'`, so a card's catalog entry is the only reliable source). */
function discardOneCard(
	state: SessionEngineStateV1,
	zoneId: string,
	cardId: CardId,
	context: ChallengeReduceContext
): SessionReduceResult {
	const entry = context.runtime.catalog[cardId];
	const destinationZoneId = entry?.deck === 'player' ? FIXED_ZONE_IDS.playerDiscard : FIXED_ZONE_IDS.majorDiscard;
	return reduceSession(state, { type: 'discard', sourceZoneId: zoneId, cardId, destinationZoneId }, context);
}

// ---------------------------------------------------------------------------
// Death and legal replacement joins (Increment 3 Task 5)
// ---------------------------------------------------------------------------

/**
 * Every Challenge-owned PRIVATE zone id a dying tenure might currently hold,
 * computed fresh from `tenureId` itself — deliberately NOT found by scanning
 * `state.privateZones` for a matching `ownerUserId`. `tenureOwners` keys
 * private-zone ownership by USER, and the same user may simultaneously own
 * another (replacement) tenure's zones (O2's whole reason tenure-keyed zone
 * ids exist — see `challengeHandZoneId`'s doc comment); scanning by owner
 * would wrongly sweep a still-live tenure's zones too. Computing the exact
 * ids for exactly this `tenureId` is what keeps the two separable. Includes
 * every private zone kind a Challenge participant can hold across Tasks 2-4:
 * the hand, the pre-reveal Initiative facedown, the prepared Aim, this
 * tenure's own Guardian Angel ward (as TARGET), and its (always-transient,
 * normally already-empty) Guardian Angel casting staging zone.
 */
function deathOwnedZoneIds(tenureId: string): string[] {
	return [
		challengeHandZoneId(tenureId),
		challengeInitiativeFacedownZoneId(tenureId),
		challengeAimZoneId(tenureId),
		challengeGuardianAngelZoneId(tenureId),
		challengeGuardianAngelStagingZoneId(tenureId)
	];
}

/**
 * Marks a participating adventurer's tenure dead within an active Challenge
 * round: discards every card in the dying tenure's owned private zones to
 * its own deck's discard pile (card conservation — O5), removes those now-
 * empty zone descriptors, discards their revealed Initiative card (if any)
 * from the shared public Initiative zone, and removes the tenure from
 * `participantTenureIds`/`budgets`/`initiativeOrder`/`tiedGroups`/any
 * modifier instance that names it as owner or target. This is the
 * session-engine HALF of "mark a participating adventurer dead" (brief O4) —
 * the character-life/tenure-ended/membership-eligibility half is the
 * server's job (`$lib/server/campaign/tenure.ts` /
 * `$lib/server/session/command-service.ts`), committed in the SAME atomic
 * write as this function's resulting state so neither half can land without
 * the other.
 *
 * Deliberately does NOT model health, wounds, damage, or *why* the tenure
 * died — that is fiction outside this engine's scope (O5/O7); this function
 * is bookkeeping only, exactly as the brief specifies: "tenure ended, zones
 * redacted, eligibility freed," never the story.
 *
 * Authorization mirrors every other per-tenure Challenge action
 * (`requirePlayerTurn`, `placeInitiative`): the GM may always act, and a
 * player may only mark their OWN tenure dead — resolved through
 * `tenureOwners`, never by comparing `actor.userId` to `tenureId` directly
 * (O1/O7).
 *
 * Rejects marking the tenure whose turn is CURRENTLY active dead outright —
 * an engine-bookkeeping convenience (not a rulebook citation; the book is
 * silent on mid-turn death), so the caller ends that turn first
 * (`turns.ts`'s `endTurn`) before removing its seat, keeping
 * `activeTurnIndex` bookkeeping unambiguous: no other seat's turn can ever be
 * "currently active" at the removed index, so a plain index shift (decrement
 * once for every removed seat before it, otherwise unchanged) is always
 * correct — no branch is needed for "the active seat just got removed."
 */
export function markTenureDead(
	state: SessionEngineStateV1,
	tenureId: string,
	context: ChallengeReduceContext
): SessionReduceResult {
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (!challenge.participantTenureIds.includes(tenureId)) {
		return reject('illegal-command', `${tenureId} is not an active Challenge participant`);
	}
	const owner = challenge.tenureOwners[tenureId];
	if (context.actor.kind === 'player' && context.actor.userId !== owner) {
		return reject('not-authorized', 'a player may only mark their own tenure dead');
	}
	const activeEntry =
		challenge.activeTurnIndex !== null ? challenge.initiativeOrder[challenge.activeTurnIndex] : undefined;
	if (activeEntry?.tenureId === tenureId) {
		return reject(
			'illegal-command',
			`cannot mark ${tenureId} dead while its turn is active — end the turn first`
		);
	}

	let nextState = state;
	const events: SessionEvent[] = [];

	for (const zoneId of deathOwnedZoneIds(tenureId)) {
		const zone = findZoneDescriptor(nextState, zoneId);
		if (!zone) continue;
		for (const cardId of zone.cards.slice()) {
			const discardResult = discardOneCard(nextState, zoneId, cardId, context);
			if (!discardResult.ok) return discardResult;
			nextState = discardResult.state;
			events.push(...discardResult.events);
		}
		nextState = { ...nextState, privateZones: nextState.privateZones.filter((existing) => existing.id !== zoneId) };
	}

	// A REVEALED Initiative card lives in the one shared public Initiative
	// zone alongside every other tenure's/enemy's revealed card — discard it
	// there BY CARD ID, never by sweeping the whole zone. An unrevealed entry
	// needs no separate handling here: its card sits in
	// `challengeInitiativeFacedownZoneId(tenureId)`, already swept above.
	const initiativeEntry = challenge.initiativeOrder.find((entry) => entry.tenureId === tenureId);
	if (initiativeEntry?.revealed && initiativeEntry.cardId !== undefined) {
		const discardResult = discardOneCard(nextState, initiativeEntry.cardZoneId, initiativeEntry.cardId, context);
		if (!discardResult.ok) return discardResult;
		nextState = discardResult.state;
		events.push(...discardResult.events);
	}

	const removedIndex = challenge.initiativeOrder.findIndex((entry) => entry.tenureId === tenureId);
	const nextInitiativeOrder = challenge.initiativeOrder.filter((entry) => entry.tenureId !== tenureId);
	// The active seat can never BE the removed one (rejected above), so this
	// is always a plain "did a seat before the active one disappear" shift.
	const nextActiveTurnIndex =
		challenge.activeTurnIndex === null || removedIndex === -1 || removedIndex >= challenge.activeTurnIndex
			? challenge.activeTurnIndex
			: challenge.activeTurnIndex - 1;

	const nextTiedGroups = challenge.tiedGroups
		.map((group) => group.filter((id) => id !== tenureId))
		.filter((group) => group.length > 1);

	const nextBudgets = Object.fromEntries(
		Object.entries(challenge.budgets).filter(([budgetKey]) => budgetKey !== tenureId)
	);
	const nextModifiers = challenge.modifiers.filter(
		(modifier) => modifier.ownerTenureId !== tenureId && modifier.targetTenureId !== tenureId
	);

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		participantTenureIds: challenge.participantTenureIds.filter((id) => id !== tenureId),
		initiativeOrder: nextInitiativeOrder,
		activeTurnIndex: nextActiveTurnIndex,
		tiedGroups: nextTiedGroups,
		budgets: nextBudgets,
		modifiers: nextModifiers
	};
	nextState = writeChallengeState(nextState, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	events.push({ kind: 'challenge-participant-died', publicPayload: { tenureId, round: challenge.round } });

	return { ok: true, state: nextState, events };
}

/**
 * Registers `tenureId` as a pending Challenge joiner (brief Step 2 / O3): a
 * newly attached/replaced tenure created WHILE a Challenge round is active
 * does not participate immediately — no hand is dealt and no private zone is
 * created for it — until `cleanupRound` (Task 2) admits
 * `pendingJoinTenureIds` into `participantTenureIds` at the next round
 * boundary. This function performs ONLY the "get it into the pending list"
 * half; `cleanupRound` already owns admission (composed with, not
 * reimplemented — O3).
 *
 * A no-op (returns `state` UNCHANGED, `ok: true`) rather than a rejection
 * when there is no active Challenge round at all — outside Challenge a
 * replacement participates immediately by the active procedure's own rules
 * (brief Step 2's first sentence), which is simply "nothing for this
 * Challenge-specific function to do," never an error. Likewise idempotent
 * when `tenureId` is already known (an active participant OR already
 * pending) — calling this twice for the same tenure is not a conflict.
 *
 * Takes a bare `catalog` (not a full `ChallengeReduceContext`) because this
 * is system-triggered bookkeeping alongside a campaign-level tenure
 * attach/replace action, not an actor-authorized `SessionCommand` — there is
 * no player/GM authorization gate here, matching the plan's own framing that
 * this is the "session cleanup port" doing its job, not a table participant
 * issuing a command.
 */
export function admitPendingJoinTenure(
	state: SessionEngineStateV1,
	tenureId: string,
	catalog: TarotCardCatalog
): SessionReduceResult {
	const challenge = readChallengeState(state);
	if (!challenge) return { ok: true, state, events: [] };
	if (challenge.participantTenureIds.includes(tenureId) || challenge.pendingJoinTenureIds.includes(tenureId)) {
		return { ok: true, state, events: [] };
	}

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		pendingJoinTenureIds: [...challenge.pendingJoinTenureIds, tenureId]
	};
	const nextState = writeChallengeState(state, nextChallenge);
	assertSessionInvariants(nextState, catalog);
	return { ok: true, state: nextState, events: [] };
}
