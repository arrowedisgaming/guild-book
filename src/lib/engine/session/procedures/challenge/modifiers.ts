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
import type { CardId, SessionEngineStateV1, SessionEvent } from '$lib/types/session';
import type {
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
import { isRejection, requirePlayerTurn, spendCard } from './turns';
import {
	challengeAimZoneId,
	challengeGuardianAngelStagingZoneId,
	challengeGuardianAngelZoneId,
	challengeHandZoneId,
	readChallengeState,
	reject,
	writeChallengeState,
	CHALLENGE_INITIATIVE_ZONE_ID,
	type ChallengeReduceContext,
	type SessionReduceResult
} from './reducer';
import { movePrivateCard } from './transfers';

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
		dealEvents = dealResult.events.map((event) => ({
			...event,
			kind: 'challenge-black-honey-applied',
			publicPayload: { ...(event.publicPayload as Record<string, unknown>), targetTenureId, extraCards }
		}));
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
 * Stun (Ch1 "Effects", `effects`): immediately discards the target's entire
 * hand. GM-only (an effect inflicted BY the GM's enemy ON a participant,
 * mirroring `applyGmPlay`'s Doom-tier framing). Deliberately does NOT reuse
 * the generic `discard` command's own per-card event (each of which would
 * publicly disclose that card's identity, since the destination discard pile
 * is `'public-top'` visibility — `card-commands.ts`'s `buildMoveEvent`
 * discloses whenever a destination is public) — the underlying discards
 * still run (conservation holds, invariants still checked), but only a
 * single hand-crafted summary event with a COUNT is returned, per O3: "the
 * same discipline applies to stun: it emits a public count, never the
 * identities of cards that were not already public." The target already
 * knows their own former hand; nobody else needs those identities restated
 * here (`SessionGmProjection` never surfaces a player's hand contents either
 * — `projection.ts`).
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
	if (challenge.stage !== 'turns') return reject('illegal-command', `cannot apply Stun during stage ${challenge.stage}`);
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

	const events = placement.events.map((event) => ({
		...event,
		kind: 'challenge-brainfever-forced-initiative',
		publicPayload: {
			...(event.publicPayload as Record<string, unknown>),
			targetTenureId,
			tieBroken,
			initiativeSelection: params.initiativeSelection,
			attacksHaveFavor: params.attacksHaveFavor
		}
	}));

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
 * later flip the card (Dodge or Riposte) — not adjudicated here, carried on
 * the event as typed data (O6); the `ChallengeModifierState` instance this
 * writes stays `status: 'active'` and — unlike Counsel/Black Honey's
 * immediately-`'resolved'` instances — is deliberately carried forward across
 * round cleanup (`reducer.ts`'s `cleanupRound`) since "until-used" can span a
 * round boundary.
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
	const handedOff = movePrivateCard(withTargetZone, stagingZoneId, targetZoneId, cardId);

	const challengeAfterSpend = readChallengeState(handedOff);
	if (!challengeAfterSpend) throw new Error('applyGuardianAngel: Challenge state missing after the cast leg');

	const instanceId = `${CHALLENGE_GUARDIAN_ANGEL_ID}:${casterTenureId}:${challengeAfterSpend.round}:${challengeAfterSpend.modifiers.length}`;
	const nextModifierInstance: ChallengeModifierState = {
		instanceId,
		modifierId: CHALLENGE_GUARDIAN_ANGEL_ID,
		ownerTenureId: casterTenureId,
		targetTenureId,
		status: 'active'
	};
	const nextChallenge: ChallengeStateV1 = {
		...challengeAfterSpend,
		modifiers: challengeAfterSpend.modifiers.concat(nextModifierInstance)
	};
	const finalState = writeChallengeState(handedOff, nextChallenge);
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
		...discardResult.events.map((event) => ({
			...event,
			kind: 'challenge-aim-resolved',
			publicPayload: { ...(event.publicPayload as Record<string, unknown>), tenureId, bonusValue }
		})),
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

	const discardEvents = discardResult.events.map((event) => ({
		...event,
		kind: 'challenge-guard-old-initiative-discarded',
		publicPayload: { ...(event.publicPayload as Record<string, unknown>), tenureId, discardsOldInitiative: params.discardsOldInitiative }
	}));

	return { ok: true, state: discardResult.state, events: [...spendResult.events, ...discardEvents] };
}

// ---------------------------------------------------------------------------
// Step 2 — the visible modifier command surface (O4)
// ---------------------------------------------------------------------------

/**
 * The typed Challenge modifier commands (binding Step 2 shape). Not wired
 * into `SessionCommand`/`command-service.ts` — that union is the frozen
 * Cross-Increment Contract and explicitly must not be altered by later tasks
 * (`session.ts`'s file header). These variants describe the surface a LATER
 * orchestration layer maps onto the `apply*`/`prepareAim`/`resolveAim`/
 * `counselTransfer` functions above, resolving a self-directed command's
 * acting tenure via `tenureIdForUser` (`reducer.ts`) rather than trusting a
 * client-supplied one — O4: "the visible command set is derived from actor
 * ownership, current Challenge stage, and active content modifiers." Every
 * function above already independently enforces exactly that derivation
 * (ownership via `requirePlayerTurn`/`tenureOwners`, stage via
 * `readChallengeState`, the `maxUsesPerRound`/`maxInstances` caps via
 * `challenge.modifiers`) — a syntactically valid command naming a tenure or
 * timing it wasn't authorized for is rejected by the SAME checks
 * `modifiers.test.ts`/`transfers.test.ts` exercise directly, not a separate
 * client-trust boundary.
 */
export type ChallengeModifierCommand =
	| { type: 'apply-black-honey'; targetTenureId: string }
	| { type: 'apply-stun'; targetTenureId: string }
	| { type: 'apply-brainfever'; targetTenureId: string }
	| { type: 'counsel-transfer'; recipientUserId: string; cardId: string }
	| { type: 'guardian-angel'; targetTenureId: string; cardId: string }
	| { type: 'aim-prepare'; cardId: string }
	| { type: 'replace-initiative-with-shield'; cardId: string };
