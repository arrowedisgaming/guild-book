/**
 * Cross-owner private card moves for the Challenge procedure (Increment 3
 * Task 4). Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * ## Why this can't just call `reduceSession({type: 'transfer', ...})`
 *
 * The shared engine's uniform zone-access rule (`card-commands.ts`'s file
 * header) is deliberately conservative: "a player-initiated `transfer` into a
 * different player's private zone is rejected — only the GM can do that,
 * since Task 2's generic engine has no procedure-specific authority chain
 * (Counsel/High Chant grants) yet; later increments' procedure modules can
 * layer additional permission on top." Counsel (`counselTransfer`, below) and
 * Guardian Angel's hand-off leg (`modifiers.ts`'s `applyGuardianAngel`) are
 * EXACTLY that later layer: both move a card from one player's private hand
 * into a DIFFERENT player's private zone, a move the generic actor-based
 * `actorMayAccessZone` check can never authorize because the acting player
 * owns neither the destination (Counsel) nor, after the cast leg, the
 * intermediate zone either (Guardian Angel).
 *
 * `performPrivateTransfer`/`movePrivateCard` therefore mutate
 * `state.privateZones` directly — bypassing `reduceSession` for this one
 * move only — but ONLY after the calling procedure function has independently
 * verified the move is legitimate under Challenge's OWN rules (ownership,
 * stage, per-round caps). Never call these for a move the caller hasn't
 * independently authorized; they perform no authorization of their own
 * beyond confirming the named zones/card actually exist.
 *
 * ## Privacy (O3 — the sharpest requirement in this task)
 *
 * The public event `performPrivateTransfer` builds carries sender tenure,
 * recipient tenure, count, and reason ONLY — never the card's identity.
 * Sender and recipient each get the minimum private payload needed to update
 * their own projection (the card id). The GM receives neither identity: this
 * helper only ever moves cards between `state.privateZones` entries, and
 * every entry there is owned by a PLAYER (`zones.ts`'s `listZoneDescriptors`
 * unconditionally tags them `{kind: 'player', ...}`), so a GM userId can
 * never be `senderUserId`/`recipientUserId` here — the GM-is-a-party
 * exception O3 describes literally cannot arise through this path.
 */

import { findZoneDescriptor } from '../../state';
import type { CardId, SessionEngineStateV1, SessionEvent } from '$lib/types/session';
import type { CounselTransferParams } from '$lib/types/content-pack';
import type { ChallengeStateV1 } from './types';
import {
	challengeHandZoneId,
	readChallengeState,
	reject,
	tenureIdForUser,
	writeChallengeState,
	type ChallengeReduceContext,
	type SessionReduceResult
} from './reducer';
import { assertSessionInvariants } from '../../invariants';

/** The content pack's `challenge-counsel` modifier id (`private-transfer`
 * behaviorId) — the only modifier `transfers.ts` implements end to end. */
export const CHALLENGE_COUNSEL_ID = 'challenge-counsel';

/** Moves `cardId` directly between two private zones, bypassing
 * `actorMayAccessZone` — see the file header for why this is safe ONLY when
 * the caller has already authorized the move itself. Both zones must already
 * exist and `sourceZoneId` must already hold `cardId`; callers confirm this
 * before calling (this function does not reject, only moves). */
export function movePrivateCard(
	state: SessionEngineStateV1,
	sourceZoneId: string,
	destinationZoneId: string,
	cardId: CardId
): SessionEngineStateV1 {
	const privateZones = state.privateZones.map((zone) => {
		if (zone.id === sourceZoneId) return { ...zone, cards: zone.cards.filter((id) => id !== cardId) };
		if (zone.id === destinationZoneId) return { ...zone, cards: zone.cards.concat(cardId) };
		return zone;
	});
	return { ...state, privateZones };
}

export interface PrivateTransferOptions {
	senderUserId: string;
	recipientUserId: string;
	senderZoneId: string;
	recipientZoneId: string;
	cardId: CardId;
	eventKind: string;
	reason: string;
	/** Merged onto the public payload alongside `count`/`reason` — tenure ids,
	 * never card identity (callers must not put a card id here). */
	publicExtra: Record<string, unknown>;
}

/**
 * Validates the named zones/card, performs the cross-owner move via
 * `movePrivateCard`, and builds the privacy-correct event (file header).
 * Does NOT touch `ChallengeStateV1` itself (per-round caps, modifier
 * instances) — that bookkeeping is caller-specific (`counselTransfer` below;
 * `modifiers.ts`'s `applyGuardianAngel`, which uses `movePrivateCard`
 * directly instead since its hand-off leg composes with an already-budgeted
 * `spendCard` leg rather than needing its own event).
 */
export function performPrivateTransfer(
	state: SessionEngineStateV1,
	options: PrivateTransferOptions,
	context: ChallengeReduceContext
): SessionReduceResult {
	const source = findZoneDescriptor(state, options.senderZoneId);
	if (!source) return reject('illegal-command', `sender zone not found: ${options.senderZoneId}`);
	if (!source.cards.includes(options.cardId)) {
		return reject('illegal-command', 'named card is not present in the sender\'s zone');
	}
	const destination = findZoneDescriptor(state, options.recipientZoneId);
	if (!destination) return reject('illegal-command', `recipient zone not found: ${options.recipientZoneId}`);
	if (!context.runtime.catalog[options.cardId]) {
		return reject('content-mismatch', 'unrecognized card referenced for a private transfer');
	}

	const nextState = movePrivateCard(state, options.senderZoneId, options.recipientZoneId, options.cardId);

	const event: SessionEvent = {
		kind: options.eventKind,
		publicPayload: { ...options.publicExtra, count: 1, reason: options.reason },
		privatePayloads: {
			[options.senderUserId]: { cardId: options.cardId, direction: 'sent' },
			[options.recipientUserId]: { cardId: options.cardId, direction: 'received' }
		}
	};
	return { ok: true, state: nextState, events: [event] };
}

/**
 * Counsel (Ch5 "Counsel", `paths-counsel`): "Any time during a Challenge, you
 * may yell advice to another adventurer and hand the player a card from your
 * hand." `recipientUserId` (a USER id, not a tenure) because the rule hands
 * the card to "the player," not to a specific character role — the sender is
 * always the ACTING player's own tenure (resolved via `tenureIdForUser`,
 * never passed explicitly — Counsel has no notion of acting "on behalf of"
 * someone else's tenure the way the GM does elsewhere).
 *
 * `suitMustMatchAction` and the Resolve-spend-for-interrupt clause
 * (`resolveCostForInterrupt`) describe fiction/character-sheet state this
 * engine does not adjudicate (which action was advised; a Resolve pool this
 * module never models) — carried as typed `params` for a caller to surface,
 * never enforced here (O6). `maxUsesPerRound` IS enforced (a real, stated
 * cap), counted by scanning this round's `resolved` Counsel instances rather
 * than a stored countdown, mirroring how `applyGmMulligan` counts by a flag
 * rather than a fabricated number.
 */
export function counselTransfer(
	state: SessionEngineStateV1,
	recipientUserId: string,
	cardId: CardId,
	params: CounselTransferParams,
	context: ChallengeReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'player') return reject('not-authorized', 'only a player may use Counsel');
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');

	const senderTenureId = tenureIdForUser(challenge, context.actor.userId);
	if (!senderTenureId) return reject('illegal-command', 'actor has no active Challenge tenure to Counsel from');

	const recipientTenureId = tenureIdForUser(challenge, recipientUserId);
	if (!recipientTenureId) return reject('illegal-command', `${recipientUserId} is not an active Challenge participant`);
	if (recipientTenureId === senderTenureId) return reject('illegal-command', 'cannot Counsel yourself');

	const senderZoneId = challengeHandZoneId(senderTenureId);
	const senderHand = findZoneDescriptor(state, senderZoneId);
	if (!senderHand || !senderHand.cards.includes(cardId)) {
		return reject('illegal-command', `${senderTenureId} does not hold the named card`);
	}

	const usesThisRound = challenge.modifiers.filter(
		(modifier) => modifier.modifierId === CHALLENGE_COUNSEL_ID && modifier.ownerTenureId === senderTenureId && modifier.status === 'resolved'
	).length;
	if (usesThisRound >= params.maxUsesPerRound) {
		return reject('illegal-command', `Counsel has already been used ${params.maxUsesPerRound} time(s) this round by ${senderTenureId}`);
	}

	const transferResult = performPrivateTransfer(
		state,
		{
			senderUserId: context.actor.userId,
			recipientUserId,
			senderZoneId,
			recipientZoneId: challengeHandZoneId(recipientTenureId),
			cardId,
			eventKind: 'challenge-counsel-transferred',
			reason: 'counsel',
			publicExtra: { senderTenureId, recipientTenureId }
		},
		context
	);
	if (!transferResult.ok) return transferResult;

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		modifiers: challenge.modifiers.concat({
			instanceId: `${CHALLENGE_COUNSEL_ID}:${senderTenureId}:${challenge.round}:${usesThisRound}`,
			modifierId: CHALLENGE_COUNSEL_ID,
			ownerTenureId: senderTenureId,
			targetTenureId: recipientTenureId,
			status: 'resolved'
		})
	};
	const nextState = writeChallengeState(transferResult.state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	return { ok: true, state: nextState, events: transferResult.events };
}
