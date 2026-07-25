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

/**
 * Re-exported from `$lib/engine/session/private-transfer.ts`, where Increment 4
 * Task 3 moved both helpers: Camp's High Chant ("Distribute the cards to other
 * players") is the second procedure to need a cross-owner private move, and a
 * Camp module importing this Challenge module for a shared primitive would
 * couple two unrelated procedures. Behavior is unchanged and every existing
 * import of `movePrivateCard`/`performPrivateTransfer`/`PrivateTransferOptions`
 * from this module keeps working.
 *
 * The one signature difference: `performPrivateTransfer` now takes a bare
 * `{ catalog }` instead of a full `ChallengeReduceContext` (it only ever read
 * `context.runtime.catalog`), so any procedure can call it without adopting
 * Challenge's context shape. `ChallengeReduceContext.runtime` satisfies that
 * structurally, so Challenge callers pass `context.runtime` unchanged.
 */
export { movePrivateCard, performPrivateTransfer, type PrivateTransferOptions } from '../../private-transfer';
// Also imported (not just re-exported) because `counselTransfer` below calls it:
// a re-export does not bind the name in this module's own scope.
import { performPrivateTransfer } from '../../private-transfer';

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
	// Ch5 "Counsel": "you may yell advice to ANOTHER adventurer" — the rule
	// text itself excludes yourself, unlike Guardian Angel (which the book
	// never restricts from self-targeting — see `modifiers.ts`'s
	// `applyGuardianAngel` doc comment, Increment 3 Task 4 review, Minor 7).
	if (recipientTenureId === senderTenureId) return reject('illegal-command', 'cannot Counsel yourself — the rule names "another adventurer"');

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
		context.runtime
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
