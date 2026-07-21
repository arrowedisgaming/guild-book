/**
 * The Challenge procedure's OWN actor-scoped projection (Increment 3 Task 6).
 * A parallel, additive slice alongside the generic `SessionPlayerProjection`/
 * `SessionGmProjection` (`../../projection.ts`) — this module changes NOTHING
 * about those types. `ChallengeStateV1` lives entirely inside
 * `state.procedure.gmPrivate`, opaque to the generic engine by design (see
 * `types.ts`'s file header: "the shared session engine's ... public
 * projection carry only what each viewer is allowed to see"), so nothing
 * about it reaches any actor without a projector of its own — this is that
 * projector.
 *
 * Same allowlist-copy discipline as `../../projection.ts`: builds a
 * brand-new object and copies only approved fields, never clones-then-
 * deletes. Two things are withheld from every actor regardless of role:
 *
 * - `ChallengeModifierState.cardId` — the identity of a specific facedown
 *   card (Guardian Angel's ward, Aim's prepared shot). The owning actor
 *   already sees that card for real via their own
 *   `privateHandsByZoneId`/`privateFacedown`/`privatePrepared` — this
 *   bookkeeping view exists to show *that* a modifier is active/pending, not
 *   to duplicate a card identity through a second, easier-to-miss channel.
 * - `enemyFacts` — GM-only. Nothing in the brief requires broadcasting the
 *   GM's monster roster to players; the GM narrates that in fiction, same as
 *   `manual-consequence-required` (O6).
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { CardSlot, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';
import { hydrateVisible } from '../../projection';
import { legalChallengeCommands, type ChallengeCommand } from './command';
import { readChallengeState, tenureIdForUser } from './reducer';
import type { ChallengeModifierDerivationCaps } from './modifiers';
import type {
	ChallengeConfig,
	ChallengeEnemyFact,
	ChallengeModifierState,
	ChallengeParticipantBudget,
	ChallengeStage,
	ChallengeStateV1,
	ChallengeTurnKind
} from './types';

/**
 * One rendered Initiative turn slot. `index` (position in
 * `ChallengeStateV1.initiativeOrder`) is the ONLY safe per-render key —
 * binding override O4: the Fool's extra turn is inserted as a shallow clone
 * of the entry it follows and shares that entry's `cardZoneId` (and, once
 * revealed, its `cardId` and `tenureId` too — see `fool.ts:114`), so keying a
 * rendered turn slot on any of those fields collides two DIFFERENT turns
 * into one rendered row. A component consuming this MUST key its `{#each}`
 * on `index`, never `cardZoneId`/`tenureId`/`cardId`.
 */
export interface ChallengeInitiativeSlotView {
	index: number;
	tenureId: string;
	revealed: boolean;
	turnKind: ChallengeTurnKind;
	/** True when this seat's revealed value is part of a recorded tie
	 * (`ChallengeStateV1.tiedGroups`) the table must adjudicate itself (O3,
	 * Ch7 "Tied Initiative") — never auto-resolved or hidden here. */
	tied: boolean;
	/** Hydrated once revealed; `null` before — the real (still-concealed)
	 * card lives in a facedown/pending zone this projection never reaches
	 * into (that zone's own card-back projection already tells every actor
	 * *that* a card is placed there, via the generic projection). */
	card: CardSlot | null;
}

/** `ChallengeModifierState` minus `cardId` (see file header) — otherwise a
 * verbatim allowlist copy. */
export interface ChallengeModifierView {
	instanceId: string;
	modifierId: string;
	ownerTenureId: string;
	targetTenureId?: string;
	status: ChallengeModifierState['status'];
	usesRemaining?: number;
}

interface ChallengeSharedView {
	stage: ChallengeStage;
	round: number;
	participantTenureIds: string[];
	/** `tenureId -> owning userId` — not secret; needed to label seats
	 * ("whose turn is this") and to resolve the viewer's own tenure. */
	tenureOwners: Record<string, string>;
	pendingJoinTenureIds: string[];
	initiativeOrder: ChallengeInitiativeSlotView[];
	tiedGroups: string[][];
	activeTurnIndex: number | null;
	turnKind: ChallengeTurnKind | null;
	budgets: Record<string, ChallengeParticipantBudget>;
	mulliganUsedThisRound: boolean;
	modifiers: ChallengeModifierView[];
	/** O1's `projection.controls` — render buttons ONLY from this list, never
	 * from a client-side legality guess. */
	legalCommands: ChallengeCommand['type'][];
}

export interface ChallengePlayerProjection extends ChallengeSharedView {
	/** The viewer's own participant tenure this round, or `null` if they hold
	 * none (not yet admitted, already dead, or a pure spectator). */
	actingTenureId: string | null;
}

export interface ChallengeGmProjection extends ChallengeSharedView {
	enemyFacts: ChallengeEnemyFact[];
}

export type ChallengeProjection = ChallengePlayerProjection | ChallengeGmProjection;

function stripModifier(modifier: ChallengeModifierState): ChallengeModifierView {
	return {
		instanceId: modifier.instanceId,
		modifierId: modifier.modifierId,
		ownerTenureId: modifier.ownerTenureId,
		...(modifier.targetTenureId !== undefined ? { targetTenureId: modifier.targetTenureId } : {}),
		status: modifier.status,
		...(modifier.usesRemaining !== undefined ? { usesRemaining: modifier.usesRemaining } : {})
	};
}

function buildInitiativeOrderView(challenge: ChallengeStateV1, catalog: TarotCardCatalog): ChallengeInitiativeSlotView[] {
	const tiedTenureIds = new Set(challenge.tiedGroups.flat());
	return challenge.initiativeOrder.map((entry, index) => ({
		index,
		tenureId: entry.tenureId,
		revealed: entry.revealed,
		turnKind: entry.turnKind ?? 'normal',
		tied: tiedTenureIds.has(entry.tenureId),
		card: entry.revealed && entry.cardId !== undefined ? hydrateVisible(entry.cardId, catalog) : null
	}));
}

/**
 * Builds the Challenge projection `actor` is authorized to see, or `null`
 * when no Challenge round is active. `config`/`modifierCaps` are the same
 * content-hydrated materials `applyChallengeCommand` itself reduces against
 * — `legalCommands` here is computed by that SAME derivation
 * (`legalChallengeCommands`), never a client-side guess or a second,
 * possibly-drifting copy of the rule.
 */
export function projectChallengeForActor(
	state: SessionEngineStateV1,
	actor: SessionActor,
	catalog: TarotCardCatalog,
	config: ChallengeConfig,
	modifierCaps: ChallengeModifierDerivationCaps
): ChallengeProjection | null {
	const challenge = readChallengeState(state);
	if (!challenge) return null;

	const shared: ChallengeSharedView = {
		stage: challenge.stage,
		round: challenge.round,
		participantTenureIds: challenge.participantTenureIds,
		tenureOwners: challenge.tenureOwners,
		pendingJoinTenureIds: challenge.pendingJoinTenureIds,
		initiativeOrder: buildInitiativeOrderView(challenge, catalog),
		tiedGroups: challenge.tiedGroups,
		activeTurnIndex: challenge.activeTurnIndex,
		turnKind: challenge.turnKind,
		budgets: challenge.budgets,
		mulliganUsedThisRound: challenge.mulliganUsedThisRound,
		modifiers: challenge.modifiers.map(stripModifier),
		legalCommands: legalChallengeCommands(state, actor, config, modifierCaps)
	};

	if (actor.kind === 'gm') {
		const gmView: ChallengeGmProjection = { ...shared, enemyFacts: challenge.enemyFacts };
		return gmView;
	}

	const playerView: ChallengePlayerProjection = { ...shared, actingTenureId: tenureIdForUser(challenge, actor.userId) ?? null };
	return playerView;
}
