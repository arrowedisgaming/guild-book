/**
 * Typed behavior for the seven Challenge modifiers (Increment 3 Task 4:
 * Black Honey, Stun, Brainfever, Counsel, Guardian Angel, Aim, Guard). Pure —
 * no UI/DB/network imports (see `tests/unit/session/import-boundaries.test.ts`).
 *
 * ## Binding override O1 — all seven are already content
 *
 * Every modifier ships in `static/content-packs/hmtw/tarot-procedures.json`'s
 * `modifiers` catalog (filter on `phase === 'challenge'`), each with a
 * `behaviorId` and a `params` block. This module implements the typed engine
 * behavior BEHIND each `behaviorId`, reading every number/flag from `params`
 * — nothing here is a rule this module invented. `findModifierParams` below
 * is the one lookup+narrow helper every apply* function's caller (a test, or
 * later glue code) uses to pull a modifier's own `params` out of the content
 * pack's `modifiers` array with full type safety (the content-pack schema
 * already validates each entry's `params` against its own `behaviorId` at
 * load time — `content-pack.schema.ts`'s `sessionModifierDefinitionSchema`
 * discriminated union — so this only needs a runtime identity check, never a
 * second Zod pass).
 *
 * ## Scope (O6)
 *
 * Denizen abilities are typed predicates; wounds, monster health, status
 * application, and fictional consequences remain manually logged — every
 * function below that implies unmodeled state emits a `manual-consequence-
 * required` event (a plain `publicPayload`, not a named type — see
 * `applyBlackHoney`/`resolveAim`) instead of mutating anything.
 * `requiresEmotion`/`duration: 'concentration'` (Brainfever) and
 * `teethLostFrom`/`teethLostTo` (Black Honey) are carried as typed data on
 * events, never adjudicated. Equipment the engine cannot verify (a shield for
 * Guard, a bow for Aim) is a caller-attested boolean parameter, not
 * fabricated — see each function's doc comment.
 *
 * ## Card-spend routing (O5/O7)
 *
 * Every modifier that consumes the acting tenure's one-card turn budget
 * (Guard's miscellaneous action, Aim's Swords action, Guardian Angel's
 * casting leg) routes through `turns.ts`'s `spendCard` — the SAME
 * `{cardsThisTurn, actionTaken, discards}` choke point Task 3 built, never a
 * parallel counter. `spendCard`'s `destinationZoneId` (Increment 3 Task 4
 * addition) is what lets Guard land its card in the Initiative zone and Aim/
 * Guardian Angel land theirs in a facedown zone through that same path.
 */

import { reduceSession } from '../../reducer';
import { findZoneDescriptor } from '../../state';
import { FIXED_ZONE_IDS } from '../../zones';
import { assertSessionInvariants } from '../../invariants';
import type { CardId, SessionActor, SessionEngineStateV1, SessionEvent } from '$lib/types/session';
import type {
	CounselTransferParams,
	ForcedHandDiscardParams,
	ForcedInitiativeSelectionParams,
	GuardianAngelParams,
	OptionalHandSizeParams,
	PreparedFacedownBonusParams,
	ReplaceInitiativeParams,
	SessionModifierDefinition
} from '$lib/types/content-pack';
import type { ChallengeModifierState, ChallengeStateV1 } from './types';
import { placeInitiative } from './initiative';
import { activeTurnEntry, isRejection, requirePlayerTurn, spendCard } from './turns';
import {
	challengeAimZoneId,
	challengeGuardianAngelStagingZoneId,
	challengeGuardianAngelZoneId,
	challengeHandZoneId,
	readChallengeState,
	reject,
	tenureIdForUser,
	writeChallengeState,
	CHALLENGE_INITIATIVE_ZONE_ID,
	type ChallengeReduceContext,
	type SessionReduceResult
} from './reducer';
import { counselTransfer, movePrivateCard, CHALLENGE_COUNSEL_ID } from './transfers';

// ---------------------------------------------------------------------------
// Content modifier ids (the content pack's `SessionModifierDefinition.id`s)
// ---------------------------------------------------------------------------

export const CHALLENGE_BLACK_HONEY_ID = 'challenge-black-honey';
export const CHALLENGE_STUN_ID = 'challenge-stun';
export const CHALLENGE_BRAINFEVER_ID = 'challenge-brainfever';
export const CHALLENGE_GUARDIAN_ANGEL_ID = 'challenge-guardian-angel';
export const CHALLENGE_AIM_ID = 'challenge-aim';
export const CHALLENGE_GUARD_ID = 'challenge-guard';

/** Looks up `id` in the content pack's `modifiers` catalog and throws if
 * missing or if its `behaviorId` doesn't match `expectedBehaviorId` — a
 * content-integrity bug (the pack shipped without this modifier, or under a
 * different id/behavior than this module was written against), not a
 * rejectable user error, so it throws like `schema.ts`'s
 * `buildChallengeConfig` does for a missing procedure/formula. */
export function findModifierParams<T>(
	modifiers: readonly SessionModifierDefinition[],
	id: string,
	expectedBehaviorId: SessionModifierDefinition['behaviorId']
): T {
	const found = modifiers.find((modifier) => modifier.id === id);
	if (!found) throw new Error(`content pack is missing Challenge modifier ${id}`);
	if (found.behaviorId !== expectedBehaviorId) {
		throw new Error(`Challenge modifier ${id} has unexpected behaviorId ${found.behaviorId}`);
	}
	return found.params as T;
}

/**
 * Relabels only the FIRST event whose `kind` is `originalKind`, leaving every
 * other event untouched — never a blind `.map()` over the whole array
 * (Increment 3 Task 4 review, Minor 8: every delegated call below currently
 * happens to return exactly one event, but a blind relabel would silently
 * mis-attribute a SECOND event — e.g. a future reshuffle notice — to this
 * modifier's own label if that ever changed). Merges `extraPublicPayload`
 * onto the located event's existing `publicPayload`, preserving whatever
 * privacy-correct shape (`privatePayloads` included) the delegated call
 * already built.
 */
function relabelEvent(
	events: readonly SessionEvent[],
	originalKind: string,
	newKind: string,
	extraPublicPayload: Record<string, unknown>
): SessionEvent[] {
	let relabeled = false;
	return events.map((event) => {
		if (!relabeled && event.kind === originalKind) {
			relabeled = true;
			return {
				...event,
				kind: newKind,
				publicPayload: { ...(event.publicPayload as Record<string, unknown>), ...extraPublicPayload }
			};
		}
		return event;
	});
}

function ensureOwnedPrivateZone(
	state: SessionEngineStateV1,
	zoneId: string,
	kind: 'player-facedown' | 'player-prepared',
	ownerUserId: string
): SessionEngineStateV1 {
	if (state.privateZones.some((zone) => zone.id === zoneId)) return state;
	return { ...state, privateZones: state.privateZones.concat({ id: zoneId, kind, ownerUserId, cards: [] }) };
}

// ---------------------------------------------------------------------------
// Black Honey — optional-hand-size
// ---------------------------------------------------------------------------

/**
 * Black Honey (Ch6 "Black honey", `crawl-black-honey`): eating it grants an
 * optional, larger Challenge hand this round. GM-only — like `dealRound`, the
 * actual mechanism is dealing fresh cards from the shared player deck, a
 * deck-drawing operation `legalCommandsForActor` reserves to the GM
 * (`'deal'` is in `GM_ONLY_COMMAND_TYPES`); the GM applies it once a player
 * declares they're eating the item. Deals exactly the difference
 * (`optionalCards - normalCards`) on top of whatever `dealRound` already
 * dealt, in EITHER order — additive, so it works whether Black Honey is
 * applied before or after this round's `dealRound` call. Rejects a second
 * application for the same tenure the same round (this is a single
 * consumable item, not a repeatable top-up).
 *
 * `teethLostFrom`/`teethLostTo` describe a fictional cost (Appendix-style
 * body-horror flavor) this engine does not adjudicate or roll for (O6) — they
 * are carried verbatim on the `manual-consequence-required` event for the GM
 * to narrate/resolve at the table.
 *
 * Gated to `stage === 'deal'` — traced to rule text, not invented (Increment
 * 3 Task 4 review, Minor 6): Ch6 "Black honey" states the choice as "you may
 * choose to draw 5 cards during an encounter instead of 4," tying the
 * decision to the moment of drawing itself, which in this engine is the
 * `'deal'` stage.
 */
export function applyBlackHoney(
	state: SessionEngineStateV1,
	targetTenureId: string,
	params: OptionalHandSizeParams,
	context: ChallengeReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may apply Black Honey (a dealt-hand-size effect)');
	}
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'deal') {
		return reject('illegal-command', `cannot apply Black Honey during stage ${challenge.stage}`);
	}
	if (!challenge.participantTenureIds.includes(targetTenureId)) {
		return reject('illegal-command', `${targetTenureId} is not an active Challenge participant`);
	}
	const alreadyEaten = challenge.modifiers.some(
		(modifier) => modifier.modifierId === CHALLENGE_BLACK_HONEY_ID && modifier.targetTenureId === targetTenureId && modifier.status === 'resolved'
	);
	if (alreadyEaten) {
		return reject('illegal-command', `${targetTenureId} has already eaten Black Honey this round`);
	}

	const extraCards = Math.max(0, params.optionalCards - params.normalCards);
	let nextState = state;
	let dealEvents: SessionEvent[] = [];
	if (extraCards > 0) {
		const dealResult = reduceSession(
			state,
			{ type: 'deal', deck: 'player', destinationZoneIds: [challengeHandZoneId(targetTenureId)], countPerDestination: extraCards },
			context
		);
		if (!dealResult.ok) return dealResult;
		nextState = dealResult.state;
		dealEvents = relabelEvent(dealResult.events, 'cards-dealt', 'challenge-black-honey-applied', { targetTenureId, extraCards });
	}

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		modifiers: challenge.modifiers.concat({
			instanceId: `${CHALLENGE_BLACK_HONEY_ID}:${targetTenureId}:${challenge.round}`,
			modifierId: CHALLENGE_BLACK_HONEY_ID,
			ownerTenureId: targetTenureId,
			targetTenureId,
			status: 'resolved'
		})
	};
	nextState = writeChallengeState(nextState, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const consequenceEvent: SessionEvent = {
		kind: 'manual-consequence-required',
		publicPayload: {
			modifierId: CHALLENGE_BLACK_HONEY_ID,
			targetTenureId,
			consequence: 'teeth-lost',
			teethLostFrom: params.teethLostFrom,
			teethLostTo: params.teethLostTo
		}
	};

	return { ok: true, state: nextState, events: [...dealEvents, consequenceEvent] };
}

// ---------------------------------------------------------------------------
// Stun — forced-hand-discard
// ---------------------------------------------------------------------------

/**
 * Stun (Ch1 "Effects", `effects`): "When Stunned, immediately choose and
 * discard a Challenge card from your hand ... It is an instantaneous
 * effect." GM-only (an effect inflicted BY the GM's enemy ON a participant,
 * mirroring `applyGmPlay`'s Doom-tier framing). No stage gate — the rule
 * text's own "immediately"/"instantaneous" language argues AGAINST inventing
 * one, and content's `immediate: true` agrees (Increment 3 Task 4 review,
 * Minor 6: an earlier version wrongly required `stage === 'turns'`, an
 * engine-asserted restriction with no source). Deliberately does NOT reuse
 * the generic `discard` command's own per-card event (each of which would
 * publicly disclose that card's identity, since the destination discard pile
 * is `'public-top'` visibility — `card-commands.ts`'s `buildMoveEvent`
 * discloses whenever a destination is public) — the underlying discards
 * still run (conservation holds, invariants still checked), but only a
 * single hand-crafted summary event with a COUNT is returned, per O3: "the
 * same discipline applies to stun: it emits a public count, never the
 * identities of cards that were not already public."
 *
 * That guarantee is about the EVENT stream only (Increment 3 Task 4 review,
 * Minor 4) — it does not and cannot suppress the shared engine's own
 * pre-existing `'public-top'` zone model: once the discards land, the LAST
 * card discarded genuinely becomes the discard pile's visible top card in
 * every projection (`projection.ts`'s `playerDiscardTop`), exactly as it
 * would for any other discard. That state-level exposure is accepted,
 * inherited from the generic discard primitive, not something this modifier
 * introduces or could suppress without redesigning the shared zone-visibility
 * model — see `modifiers.test.ts`'s explicit projection assertion.
 */
export function applyStun(
	state: SessionEngineStateV1,
	targetTenureId: string,
	params: ForcedHandDiscardParams,
	context: ChallengeReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may inflict Stun');
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (!challenge.participantTenureIds.includes(targetTenureId)) {
		return reject('illegal-command', `${targetTenureId} is not an active Challenge participant`);
	}

	const handZoneId = challengeHandZoneId(targetTenureId);
	const hand = findZoneDescriptor(state, handZoneId);
	const cardsToDiscard = hand?.cards.slice() ?? [];

	let nextState = state;
	for (const cardId of cardsToDiscard) {
		const discardResult = reduceSession(
			nextState,
			{ type: 'discard', sourceZoneId: handZoneId, cardId, destinationZoneId: FIXED_ZONE_IDS.playerDiscard },
			context
		);
		if (!discardResult.ok) return discardResult;
		nextState = discardResult.state;
	}
	assertSessionInvariants(nextState, context.runtime.catalog);

	const event: SessionEvent = {
		kind: 'challenge-stun-applied',
		publicPayload: { targetTenureId, count: cardsToDiscard.length, immediate: params.immediate, discard: params.discard }
	};
	return { ok: true, state: nextState, events: [event] };
}

// ---------------------------------------------------------------------------
// Brainfever — forced-initiative-selection
// ---------------------------------------------------------------------------

/**
 * Brainfever (Appendix A Sorcery, `sorcery-brainfever`): forces the target to
 * place their LOWEST-VALUE hand card as Initiative — the choice is the
 * engine's, not the player's. GM-only (the caster is a hostile sorcerer). Ties
 * for lowest value are broken by a STABLE rule — ascending card-id sort, NOT
 * chance — and the fact that a tie was broken is recorded on the event,
 * mirroring `initiative.ts`'s `tiedGroups` philosophy: never silently resolve
 * a tie without saying so. Delegates the actual placement to
 * `initiative.ts`'s `placeInitiative` (GM has full authority there already)
 * rather than duplicating its transfer/state-update logic.
 *
 * `attacksHaveFavor`/`requiresEmotion`/`duration: 'concentration'` describe
 * fiction/combat-math this engine does not adjudicate (favor isn't modeled;
 * concentration isn't tracked) — carried on the event as typed data only
 * (O6). Re-invoking this function each round the GM judges concentration
 * still holds is the caller's job, not an auto-reapplying system this module
 * builds.
 */
export function applyBrainfever(
	state: SessionEngineStateV1,
	targetTenureId: string,
	params: ForcedInitiativeSelectionParams,
	context: ChallengeReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may inflict Brainfever');
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'initiative-placement') {
		return reject('illegal-command', `cannot force Initiative selection during stage ${challenge.stage}`);
	}
	if (!challenge.participantTenureIds.includes(targetTenureId)) {
		return reject('illegal-command', `${targetTenureId} is not an active Challenge participant`);
	}
	if (challenge.initiativeOrder.some((entry) => entry.tenureId === targetTenureId)) {
		return reject('illegal-command', `${targetTenureId} has already placed Initiative this round`);
	}

	const hand = findZoneDescriptor(state, challengeHandZoneId(targetTenureId));
	if (!hand || hand.cards.length === 0) {
		return reject('illegal-command', `${targetTenureId} has no Challenge cards to place as Initiative`);
	}

	const withValues = hand.cards.map((cardId) => ({ cardId, value: context.runtime.catalog[cardId]?.value ?? 0 }));
	const minValue = Math.min(...withValues.map((entry) => entry.value));
	const candidates = withValues
		.filter((entry) => entry.value === minValue)
		.map((entry) => entry.cardId)
		.sort();
	const chosenCardId = candidates[0];
	const tieBroken = candidates.length > 1;

	const placement = placeInitiative(state, targetTenureId, chosenCardId, context);
	if (!placement.ok) return placement;

	const events = relabelEvent(placement.events, 'card-transferred', 'challenge-brainfever-forced-initiative', {
		targetTenureId,
		tieBroken,
		initiativeSelection: params.initiativeSelection,
		attacksHaveFavor: params.attacksHaveFavor
	});

	return { ok: true, state: placement.state, events };
}

// ---------------------------------------------------------------------------
// Guardian Angel — guardian-angel-defense
// ---------------------------------------------------------------------------

/**
 * Guardian Angel (Appendix A Sorcery, `sorcery-guardian-angel`): the caster
 * spends the Speak Incantation card used to cast it as their turn's full
 * action, then that SAME card is handed facedown to the target (not kept by
 * the caster) — "the sorcerer hands the target the card ... placed facedown
 * in front of the target player." Two legs, both card-conserving:
 *
 * 1. The cast — routed through `spendCard` (budgeted, own-turn, own-owned
 *    staging zone: a same-owner move the generic engine already permits).
 * 2. The hand-off — the staged card moves from the caster's staging zone
 *    into the TARGET's facedown zone, a cross-owner move `transfers.ts`'s
 *    `movePrivateCard` performs directly (see that module's file header for
 *    why the generic engine can't do this itself). NOT separately budgeted —
 *    it's a continuation of the same action, mirroring `applyGuard`'s
 *    unbudgeted old-card discard after its own budgeted swap.
 *
 * `params.maxInstances` (currently `1` in content — never hardcoded here) is
 * enforced per CASTER (`ownerTenureId`), not per target — "you cannot have
 * multiple instances of this spell at the same time" reads
 * as the caster's own limit; `cumulative` (Ch11) is exactly why the SAME
 * target's zone may still hold several different casters' cards at once.
 * `allowedActions`/`duration: 'until-used'` describe how/when the target may
 * later flip the card (Dodge or Riposte) — not adjudicated here (attack/
 * defense math is out of scope, O6), but "used" IS a real state transition
 * this module tracks — see `resolveGuardianAngel`, below.
 *
 * Self-targeting (`targetTenureId === casterTenureId`) is deliberately
 * PERMITTED: unlike Counsel ("yell advice to ANOTHER adventurer" —
 * `transfers.ts`), the Guardian Angel rule text never restricts who the
 * target may be, and this module does not add a restriction the book doesn't
 * state (Increment 3 Task 4 review, Minor 7).
 *
 * The `ChallengeModifierState` instance this writes stays `status: 'active'`
 * with `cardId` recorded (so `resolveGuardianAngel` can identify which of
 * possibly SEVERAL active instances a given target's card belongs to,
 * "cumulative") and — unlike Counsel/Black Honey's immediately-`'resolved'`
 * instances — is deliberately carried forward across round cleanup
 * (`reducer.ts`'s `cleanupRound`) since "until-used" can span a round
 * boundary. Without a consuming counterpart this would be a one-way door —
 * see `resolveGuardianAngel`'s doc comment (Increment 3 Task 4 review,
 * Important 2).
 */
export function applyGuardianAngel(
	state: SessionEngineStateV1,
	casterTenureId: string,
	targetTenureId: string,
	cardId: CardId,
	params: GuardianAngelParams,
	context: ChallengeReduceContext
): SessionReduceResult {
	const guard = requirePlayerTurn(state, casterTenureId, context);
	if (isRejection(guard)) return { ok: false, rejection: guard };
	const challenge = guard;

	if (!challenge.participantTenureIds.includes(targetTenureId)) {
		return reject('illegal-command', `${targetTenureId} is not an active Challenge participant`);
	}

	const activeInstanceCount = challenge.modifiers.filter(
		(modifier) => modifier.modifierId === CHALLENGE_GUARDIAN_ANGEL_ID && modifier.ownerTenureId === casterTenureId && modifier.status === 'active'
	).length;
	if (activeInstanceCount >= params.maxInstances) {
		return reject('illegal-command', `${casterTenureId} already has ${activeInstanceCount} active Guardian Angel(s) (maxInstances: ${params.maxInstances})`);
	}

	const casterUserId = challenge.tenureOwners[casterTenureId];
	const targetUserId = challenge.tenureOwners[targetTenureId];
	if (!casterUserId || !targetUserId) {
		return reject('illegal-command', 'Guardian Angel requires both caster and target to have a registered owner');
	}

	const stagingZoneId = challengeGuardianAngelStagingZoneId(casterTenureId);
	const stagedState = ensureOwnedPrivateZone(state, stagingZoneId, 'player-facedown', casterUserId);

	const spendResult = spendCard(
		stagedState,
		challenge,
		{
			budgetKey: casterTenureId,
			handZoneId: challengeHandZoneId(casterTenureId),
			cardId,
			actionKind: 'action',
			cap: context.config.cardsPerInitiativeTurn,
			destinationZoneId: stagingZoneId,
			eventKind: 'challenge-guardian-angel-cast',
			extraPublicPayload: { casterTenureId, targetTenureId }
		},
		context
	);
	if (!spendResult.ok) return spendResult;

	const targetZoneId = challengeGuardianAngelZoneId(targetTenureId);
	const withTargetZone = ensureOwnedPrivateZone(spendResult.state, targetZoneId, 'player-facedown', targetUserId);
	const handoffResult = movePrivateCard(withTargetZone, stagingZoneId, targetZoneId, cardId);
	if (!handoffResult.ok) return handoffResult;

	const challengeAfterSpend = readChallengeState(handoffResult.state);
	if (!challengeAfterSpend) throw new Error('applyGuardianAngel: Challenge state missing after the cast leg');

	const instanceId = `${CHALLENGE_GUARDIAN_ANGEL_ID}:${casterTenureId}:${challengeAfterSpend.round}:${challengeAfterSpend.modifiers.length}`;
	const nextModifierInstance: ChallengeModifierState = {
		instanceId,
		modifierId: CHALLENGE_GUARDIAN_ANGEL_ID,
		ownerTenureId: casterTenureId,
		targetTenureId,
		status: 'active',
		cardId
	};
	const nextChallenge: ChallengeStateV1 = {
		...challengeAfterSpend,
		modifiers: challengeAfterSpend.modifiers.concat(nextModifierInstance)
	};
	const finalState = writeChallengeState(handoffResult.state, nextChallenge);
	assertSessionInvariants(finalState, context.runtime.catalog);

	const handoffEvent: SessionEvent = {
		kind: 'challenge-guardian-angel-warded',
		publicPayload: {
			casterTenureId,
			targetTenureId,
			count: 1,
			reason: 'guardian-angel',
			allowedActions: params.allowedActions,
			cumulative: params.cumulative,
			exemptFromFacedownLimit: params.exemptFromFacedownLimit
		},
		privatePayloads: { [targetUserId]: { cardId } }
	};

	return { ok: true, state: finalState, events: [...spendResult.events, handoffEvent] };
}

/**
 * Consumes an active Guardian Angel ward: "At their discretion, they can
 * flip the card up and use its value to either Dodge or Riposte" (Appendix A
 * Sorcery, "Guardian Angel"). Flipping it up is a reveal — same mechanic as
 * every other discard-into-a-public-top-pile reveal in this module — and per
 * Ch7 "Dodge"/"Riposte" ("Once your Dodge card is resolved, discard the
 * card" / "Once your Riposte card is resolved, discard the card"), the card
 * this bonus attaches to is discarded once that defensive action resolves —
 * the SAME rule, since the Guardian Angel card only ever contributes its
 * value to one of those two actions, never stands alone. Flips the
 * `ChallengeModifierState` instance to `'resolved'` (ending its `maxInstances`
 * lockout and letting the target's zone stop holding it) — added per
 * Increment 3 Task 4 review, Important 2: without a consuming counterpart,
 * `cleanupRound` carrying the `'active'` instance forward across every
 * subsequent round would have made the caster's `maxInstances` cap and the
 * warded card itself permanently unusable. The book is silent on whether the
 * card must be discarded to the SAME pile as any other Challenge card (no
 * special disposition is stated for a spent Guardian Angel card) — this
 * follows the general Dodge/Riposte discard rule since that is the action it
 * augments, not an invented special case.
 *
 * `chosenAction` records which of the two allowed actions it was used for
 * (`allowedActions: 'dodge-or-riposte'`) for audit/typed-data purposes only —
 * the actual Dodge/Riposte value comparison against an attacker's action is
 * never computed here (O6); `manual-consequence-required` carries the bonus
 * for the GM/table to apply.
 */
export function resolveGuardianAngel(
	state: SessionEngineStateV1,
	targetTenureId: string,
	cardId: CardId,
	chosenAction: 'dodge' | 'riposte',
	context: ChallengeReduceContext
): SessionReduceResult {
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	const owner = challenge.tenureOwners[targetTenureId];
	if (!owner) return reject('illegal-command', `${targetTenureId} is not an active Challenge participant`);
	if (context.actor.kind === 'player' && context.actor.userId !== owner) {
		return reject('not-authorized', 'a player may only resolve their own Guardian Angel ward');
	}

	const zoneId = challengeGuardianAngelZoneId(targetTenureId);
	const zone = findZoneDescriptor(state, zoneId);
	if (!zone || !zone.cards.includes(cardId)) {
		return reject('illegal-command', `${targetTenureId} has no Guardian Angel card ${cardId} to reveal`);
	}
	const instanceIndex = challenge.modifiers.findIndex(
		(modifier) =>
			modifier.modifierId === CHALLENGE_GUARDIAN_ANGEL_ID &&
			modifier.targetTenureId === targetTenureId &&
			modifier.cardId === cardId &&
			modifier.status === 'active'
	);
	if (instanceIndex === -1) {
		return reject('illegal-command', `${targetTenureId} has no active Guardian Angel instance for card ${cardId}`);
	}

	const discardResult = reduceSession(
		state,
		{ type: 'discard', sourceZoneId: zoneId, cardId, destinationZoneId: FIXED_ZONE_IDS.playerDiscard },
		context
	);
	if (!discardResult.ok) return discardResult;

	const nextModifiers = challenge.modifiers.map((modifier, index) =>
		index === instanceIndex ? { ...modifier, status: 'resolved' as const } : modifier
	);
	const nextChallenge: ChallengeStateV1 = { ...challenge, modifiers: nextModifiers };
	const nextState = writeChallengeState(discardResult.state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const bonusValue = context.runtime.catalog[cardId]?.value ?? 0;
	const events: SessionEvent[] = [
		...relabelEvent(discardResult.events, 'card-discarded', 'challenge-guardian-angel-resolved', { targetTenureId, chosenAction, bonusValue }),
		{
			kind: 'manual-consequence-required',
			publicPayload: {
				modifierId: CHALLENGE_GUARDIAN_ANGEL_ID,
				targetTenureId,
				consequence: `apply-guardian-angel-bonus-to-${chosenAction}`,
				bonusValue
			}
		}
	];
	return { ok: true, state: nextState, events };
}

// ---------------------------------------------------------------------------
// Aim — prepared-facedown-bonus
// ---------------------------------------------------------------------------

/**
 * Aim (Ch9 "Bow": "Aim is a Swords action. Declare who you're targeting and
 * play your card facedown. When you next Attack with your bow, you may
 * reveal the card and add its value to your total Attack."). A full action
 * (own turn, budgeted via `spendCard`) that MUST be a Swords card — content's
 * `suit` param, a genuine stated exception to "any card for any action" (see
 * `turns.ts`'s `SpendCardOptions.actionSuit` doc comment) — landing facedown
 * in the tenure's own Aim zone rather than the shared played zone.
 *
 * `requiresBow` is equipment the engine cannot verify — a caller-attested
 * `hasBow` boolean, never fabricated (same pattern as `applyGuard`'s
 * `hasShield`). `targetRequired` (who you're aiming at) is fictional
 * targeting this command surface has no field for and does not model — the
 * table declares it out of band, same as `requiresEmotion` elsewhere (O6).
 */
export function prepareAim(
	state: SessionEngineStateV1,
	tenureId: string,
	cardId: CardId,
	hasBow: boolean,
	params: PreparedFacedownBonusParams,
	context: ChallengeReduceContext
): SessionReduceResult {
	if (params.requiresBow && !hasBow) {
		return reject('illegal-command', 'Aim requires a bow — the engine cannot verify equipment; the caller must attest to it');
	}
	const guard = requirePlayerTurn(state, tenureId, context);
	if (isRejection(guard)) return { ok: false, rejection: guard };
	const challenge = guard;

	const ownerUserId = challenge.tenureOwners[tenureId];
	if (!ownerUserId) return reject('illegal-command', `no owner registered for ${tenureId}`);

	const zoneId = challengeAimZoneId(tenureId);
	const ensuredState = ensureOwnedPrivateZone(state, zoneId, 'player-prepared', ownerUserId);

	return spendCard(
		ensuredState,
		challenge,
		{
			budgetKey: tenureId,
			handZoneId: challengeHandZoneId(tenureId),
			cardId,
			actionKind: 'action',
			actionSuit: params.suit,
			cap: context.config.cardsPerInitiativeTurn,
			destinationZoneId: zoneId,
			eventKind: 'challenge-aim-prepared',
			extraPublicPayload: { tenureId }
		},
		context
	);
}

/**
 * Resolves ("consumes") a previously-prepared Aim card: reveals it (a
 * discard into the public-top player discard pile IS the reveal — the same
 * disclosure-on-public-destination mechanic every other discard already
 * uses) and reports its value as the Attack bonus content says to add
 * (`addsCardValue`). The actual Attack-total math is never modeled here
 * (O6) — `manual-consequence-required` carries the bonus for the GM/table to
 * apply. Not gated to the tenure's OWN active turn (the book only says "when
 * you next Attack," which the engine has no independent way to time-box more
 * tightly than ownership) — just ownership.
 */
export function resolveAim(
	state: SessionEngineStateV1,
	tenureId: string,
	cardId: CardId,
	params: PreparedFacedownBonusParams,
	context: ChallengeReduceContext
): SessionReduceResult {
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	const owner = challenge.tenureOwners[tenureId];
	if (!owner) return reject('illegal-command', `${tenureId} is not an active Challenge participant`);
	if (context.actor.kind === 'player' && context.actor.userId !== owner) {
		return reject('not-authorized', 'a player may only resolve their own prepared Aim');
	}

	const zoneId = challengeAimZoneId(tenureId);
	const zone = findZoneDescriptor(state, zoneId);
	if (!zone || !zone.cards.includes(cardId)) {
		return reject('illegal-command', `${tenureId} has no prepared Aim card ${cardId} to reveal`);
	}

	const discardResult = reduceSession(
		state,
		{ type: 'discard', sourceZoneId: zoneId, cardId, destinationZoneId: FIXED_ZONE_IDS.playerDiscard },
		context
	);
	if (!discardResult.ok) return discardResult;
	assertSessionInvariants(discardResult.state, context.runtime.catalog);

	const bonusValue = context.runtime.catalog[cardId]?.value ?? 0;
	const events: SessionEvent[] = [
		...relabelEvent(discardResult.events, 'card-discarded', 'challenge-aim-resolved', { tenureId, bonusValue }),
		{
			kind: 'manual-consequence-required',
			publicPayload: {
				modifierId: CHALLENGE_AIM_ID,
				tenureId,
				consequence: 'apply-aim-bonus-to-next-bow-attack',
				addsCardValue: params.addsCardValue,
				bonusValue
			}
		}
	];
	return { ok: true, state: discardResult.state, events };
}

// ---------------------------------------------------------------------------
// Guard — replace-initiative
// ---------------------------------------------------------------------------

/**
 * Guard (Ch7:552-554 — O2, restored after being wrongly deleted from an
 * earlier amendment): "If you have a shield, you may replace your Initiative
 * with any card from your hand as a miscellaneous action. Your old Initiative
 * is discarded." Two conserving moves:
 *
 * 1. The swap-in — routed through `spendCard` (`actionKind: 'action'`,
 *    since a miscellaneous action IS a full action per Ch7's own action
 *    table, just suit-exempt like every full action already is — O5/O7),
 *    landing the NEW card in the shared `CHALLENGE_INITIATIVE_ZONE_ID`
 *    (a public zone any actor may act on, so no cross-owner concern here).
 * 2. The old-Initiative discard — a second, unbudgeted move (Ch7 states the
 *    discard as automatic, not a second card spend), identifying the exact
 *    old card via `ChallengeInitiativeEntry.cardId` (Increment 3 Task 4
 *    addition — see `types.ts`'s doc comment for why a flat shared zone can't
 *    answer "which card is this tenure's" without it).
 *
 * `anySuit: true` needs no separate check (full actions are already suit-free
 * — `spendCard` is called with no `actionSuit`). `requiresShield` is
 * equipment the engine cannot verify — a caller-attested `hasShield` boolean,
 * never fabricated (O2: "Equipment state that the engine cannot verify is a
 * projection input, not something to fabricate").
 */
export function applyGuard(
	state: SessionEngineStateV1,
	tenureId: string,
	newCardId: CardId,
	hasShield: boolean,
	params: ReplaceInitiativeParams,
	context: ChallengeReduceContext
): SessionReduceResult {
	if (params.requiresShield && !hasShield) {
		return reject('illegal-command', 'Guard requires a shield — the engine cannot verify equipment; the caller must attest to it');
	}
	const guard = requirePlayerTurn(state, tenureId, context);
	if (isRejection(guard)) return { ok: false, rejection: guard };
	const challenge = guard;

	const entry = challenge.initiativeOrder.find((candidate) => candidate.tenureId === tenureId);
	if (!entry || !entry.revealed || entry.cardId === undefined) {
		return reject('illegal-command', `${tenureId} has no revealed Initiative card to replace with Guard`);
	}
	const oldCardId = entry.cardId;
	if (oldCardId === newCardId) {
		return reject('illegal-command', 'Guard must replace Initiative with a different card');
	}

	const spendResult = spendCard(
		state,
		challenge,
		{
			budgetKey: tenureId,
			handZoneId: challengeHandZoneId(tenureId),
			cardId: newCardId,
			actionKind: 'action',
			cap: context.config.cardsPerInitiativeTurn,
			destinationZoneId: CHALLENGE_INITIATIVE_ZONE_ID,
			eventKind: 'challenge-guard-played',
			extraPublicPayload: { tenureId, actionBudget: params.actionBudget }
		},
		context
	);
	if (!spendResult.ok) return spendResult;

	const challengeAfterSpend = readChallengeState(spendResult.state);
	if (!challengeAfterSpend) throw new Error('applyGuard: Challenge state missing after the swap-in leg');
	const nextInitiativeOrder = challengeAfterSpend.initiativeOrder.map((candidate) =>
		candidate.tenureId === tenureId ? { ...candidate, cardId: newCardId } : candidate
	);
	const swappedState = writeChallengeState(spendResult.state, { ...challengeAfterSpend, initiativeOrder: nextInitiativeOrder });

	const discardResult = reduceSession(
		swappedState,
		{ type: 'discard', sourceZoneId: CHALLENGE_INITIATIVE_ZONE_ID, cardId: oldCardId, destinationZoneId: FIXED_ZONE_IDS.playerDiscard },
		context
	);
	if (!discardResult.ok) return discardResult;
	assertSessionInvariants(discardResult.state, context.runtime.catalog);

	const discardEvents = relabelEvent(discardResult.events, 'card-discarded', 'challenge-guard-old-initiative-discarded', {
		tenureId,
		discardsOldInitiative: params.discardsOldInitiative
	});

	return { ok: true, state: discardResult.state, events: [...spendResult.events, ...discardEvents] };
}

// ---------------------------------------------------------------------------
// Step 2 — the visible modifier command surface (O4)
// ---------------------------------------------------------------------------

/**
 * The typed Challenge modifier commands (binding Step 2 shape). Not wired
 * into `SessionCommand`/`command-service.ts` — that union is the frozen
 * Cross-Increment Contract and explicitly must not be altered by later tasks
 * (`session.ts`'s file header). These variants describe the surface
 * `applyChallengeModifierCommand` (below) dispatches onto the `apply*`/
 * `prepareAim`/`resolveAim`/`counselTransfer` functions above.
 */
export type ChallengeModifierCommand =
	| { type: 'apply-black-honey'; targetTenureId: string }
	| { type: 'apply-stun'; targetTenureId: string }
	| { type: 'apply-brainfever'; targetTenureId: string }
	| { type: 'counsel-transfer'; recipientUserId: string; cardId: string }
	| { type: 'guardian-angel'; targetTenureId: string; cardId: string }
	| { type: 'aim-prepare'; cardId: string }
	| { type: 'replace-initiative-with-shield'; cardId: string };

/** The two content-driven caps `legalChallengeModifierCommands` needs to
 * know whether a player has already exhausted for THIS round/Challenge —
 * "active content modifiers" (O4's third derivation input) means checking
 * `challenge.modifiers`, not just role+stage. */
export interface ChallengeModifierDerivationCaps {
	counselMaxUsesPerRound: CounselTransferParams['maxUsesPerRound'];
	guardianAngelMaxInstances: GuardianAngelParams['maxInstances'];
}

/**
 * Derives the set of modifier command TYPES currently offered to `actor` —
 * mirrors `reducer.ts`'s `legalCommandsForActor` (coarse, role-based command
 * TYPES, not per-zone/per-card legality) but for the Challenge modifier
 * surface, which that function knows nothing about (Increment 3 Task 4
 * review, Important 1: `legalCommandsForActor` takes only an actor and is
 * blind to Challenge stage and modifier state entirely).
 *
 * Three derivation inputs, per O4:
 * - **actor ownership** — a player only ever sees commands for THEIR OWN
 *   tenure (resolved via `tenureIdForUser`); the GM-only three are never
 *   offered to a player at all, and vice versa.
 * - **current Challenge stage** — Black Honey only during `'deal'`,
 *   Brainfever only during `'initiative-placement'`, the three own-turn
 *   player actions (Guardian Angel/Aim/Guard) only when it is genuinely that
 *   tenure's active turn during `'turns'`.
 * - **active content modifiers** — Counsel's `maxUsesPerRound` and Guardian
 *   Angel's `maxInstances`, both counted from `challenge.modifiers` exactly
 *   as `counselTransfer`/`applyGuardianAngel` themselves do, so this can
 *   never drift from what those functions actually enforce.
 *
 * Returns `[]` if no Challenge round is active. Stun carries no stage/cap
 * restriction (see `applyStun`'s doc comment — the rule's own "immediately"
 * argues against inventing one), so it is offered to the GM whenever a round
 * exists.
 */
export function legalChallengeModifierCommands(
	state: SessionEngineStateV1,
	actor: SessionActor,
	caps: ChallengeModifierDerivationCaps
): ChallengeModifierCommand['type'][] {
	const challenge = readChallengeState(state);
	if (!challenge) return [];

	if (actor.kind === 'gm') {
		const legal: ChallengeModifierCommand['type'][] = ['apply-stun'];
		if (challenge.stage === 'deal') legal.push('apply-black-honey');
		if (challenge.stage === 'initiative-placement') legal.push('apply-brainfever');
		return legal;
	}

	const tenureId = tenureIdForUser(challenge, actor.userId);
	if (!tenureId) return [];

	const legal: ChallengeModifierCommand['type'][] = [];

	const counselUsesThisRound = challenge.modifiers.filter(
		(modifier) => modifier.modifierId === CHALLENGE_COUNSEL_ID && modifier.ownerTenureId === tenureId && modifier.status === 'resolved'
	).length;
	if (counselUsesThisRound < caps.counselMaxUsesPerRound) legal.push('counsel-transfer');

	const isOwnActiveTurn = challenge.stage === 'turns' && activeTurnEntry(challenge)?.tenureId === tenureId;
	if (isOwnActiveTurn) {
		const activeGuardianAngels = challenge.modifiers.filter(
			(modifier) => modifier.modifierId === CHALLENGE_GUARDIAN_ANGEL_ID && modifier.ownerTenureId === tenureId && modifier.status === 'active'
		).length;
		if (activeGuardianAngels < caps.guardianAngelMaxInstances) legal.push('guardian-angel');
		legal.push('aim-prepare');
		legal.push('replace-initiative-with-shield');
	}

	return legal;
}

/** Every content `params` block a `ChallengeModifierCommand` might need, plus
 * the two equipment booleans the engine cannot verify itself (O2) — a
 * caller assembles this once per session/content-load, the same way
 * `ChallengeConfig` is assembled once by `buildChallengeConfig`. */
export interface ChallengeModifierMaterials {
	blackHoney: OptionalHandSizeParams;
	stun: ForcedHandDiscardParams;
	brainfever: ForcedInitiativeSelectionParams;
	counsel: CounselTransferParams;
	guardianAngel: GuardianAngelParams;
	aim: PreparedFacedownBonusParams;
	guard: ReplaceInitiativeParams;
	hasShield?: boolean;
	hasBow?: boolean;
}

/**
 * The single entry point a command-issuing layer (a test, or a later task's
 * HTTP/command-service wiring) calls: derives the legal set via
 * `legalChallengeModifierCommands` and rejects `command` OUTRIGHT —
 * `illegal-command`, before ever reaching the underlying mechanism — if its
 * `type` is absent from that set. This is what "a syntactically valid but
 * unprojected command" (O4) actually means: a command shape that type-checks
 * and could plausibly succeed in some OTHER stage/for some OTHER actor, but
 * was never offered to THIS actor right now. Mirrors `reduceSession`'s own
 * `legalCommandsForActor`-gate-then-`dispatch` shape exactly.
 *
 * Resolves a self-directed command's acting tenure via `tenureIdForUser`
 * (Guardian Angel/Aim/Guard all act on the caller's OWN tenure and carry no
 * tenure id of their own in `ChallengeModifierCommand` — see that type's
 * doc comment) rather than trusting any client-supplied one.
 */
export function applyChallengeModifierCommand(
	state: SessionEngineStateV1,
	command: ChallengeModifierCommand,
	materials: ChallengeModifierMaterials,
	context: ChallengeReduceContext
): SessionReduceResult {
	const caps: ChallengeModifierDerivationCaps = {
		counselMaxUsesPerRound: materials.counsel.maxUsesPerRound,
		guardianAngelMaxInstances: materials.guardianAngel.maxInstances
	};
	const legal = legalChallengeModifierCommands(state, context.actor, caps);
	if (!legal.includes(command.type)) {
		return reject('illegal-command', `${command.type} is not currently offered to this actor`);
	}

	const challenge = readChallengeState(state);
	/* v8 ignore start -- unreachable: `legal` is only ever non-empty when
	 * `readChallengeState` already succeeded above, so a non-empty `legal`
	 * list here always means `challenge` is defined too. Kept only so this
	 * function never dereferences `challenge` as possibly `undefined`. */
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	/* v8 ignore stop */

	switch (command.type) {
		case 'apply-black-honey':
			return applyBlackHoney(state, command.targetTenureId, materials.blackHoney, context);
		case 'apply-stun':
			return applyStun(state, command.targetTenureId, materials.stun, context);
		case 'apply-brainfever':
			return applyBrainfever(state, command.targetTenureId, materials.brainfever, context);
		case 'counsel-transfer':
			return counselTransfer(state, command.recipientUserId, command.cardId, materials.counsel, context);
		case 'guardian-angel': {
			const casterTenureId = tenureIdForUser(challenge, context.actor.userId);
			if (!casterTenureId) return reject('illegal-command', 'actor has no active Challenge tenure');
			return applyGuardianAngel(state, casterTenureId, command.targetTenureId, command.cardId, materials.guardianAngel, context);
		}
		case 'aim-prepare': {
			const tenureId = tenureIdForUser(challenge, context.actor.userId);
			if (!tenureId) return reject('illegal-command', 'actor has no active Challenge tenure');
			return prepareAim(state, tenureId, command.cardId, materials.hasBow ?? false, materials.aim, context);
		}
		case 'replace-initiative-with-shield': {
			const tenureId = tenureIdForUser(challenge, context.actor.userId);
			if (!tenureId) return reject('illegal-command', 'actor has no active Challenge tenure');
			return applyGuard(state, tenureId, command.cardId, materials.hasShield ?? false, materials.guard, context);
		}
	}
}
