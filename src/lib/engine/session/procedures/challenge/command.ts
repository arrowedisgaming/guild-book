/**
 * The full Challenge command surface (Increment 3 Task 6). Unifies every
 * base-flow procedure function built by Tasks 2/3 (`beginChallenge`,
 * `dealRound`, Initiative placement/reveal, the turn loop, the Fool, GM
 * plays/discards/mulligan, `cleanupRound`) and the seven typed modifiers
 * (`modifiers.ts`'s `ChallengeModifierCommand`) behind ONE discriminated
 * command type and ONE legality-then-dispatch entry point, mirroring
 * `modifiers.ts`'s own `applyChallengeModifierCommand` shape exactly.
 *
 * Deliberately NOT added to `SessionCommand` (`$lib/types/session.ts`) — that
 * union is the frozen Cross-Increment Contract and explicitly must not be
 * altered by later tasks (every Task 3/4 module says so already, and
 * `modifiers.ts`'s own file header anticipated exactly this: "Not wired into
 * `SessionCommand`/`command-service.ts`... These variants describe the
 * surface a later task's HTTP/command-service wiring dispatches onto"). This
 * is a parallel, additive command surface a NEW HTTP route
 * (`$lib/server/session/challenge-command-service.ts`) dispatches, never a
 * change to the frozen union or to the generic `reduceSession`/`dispatch`
 * switch in `../../reducer.ts`.
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { SuitId } from '$lib/types/common';
import type { SessionActor, SessionEngineStateV1 } from '$lib/types/session';
import { findZoneDescriptor } from '../../state';
import {
	activeTurnEntry,
	applyGmDiscard,
	applyGmMinorAction,
	applyGmMulligan,
	applyGmPlay,
	applyPlayerAction,
	applyPlayerMinorAction,
	beginTurns,
	endTurn
} from './turns';
import { dealRound } from './deal';
import { placeGmInitiative, placeInitiative, revealInitiative } from './initiative';
import { playFool } from './fool';
import {
	applyChallengeModifierCommand,
	legalChallengeModifierCommands,
	type ChallengeModifierCommand,
	type ChallengeModifierDerivationCaps,
	type ChallengeModifierMaterials
} from './modifiers';
import {
	beginChallenge,
	challengeHandZoneId,
	cleanupRound,
	isChallengeStateCorrupt,
	readChallengeState,
	reject,
	tenureIdForUser,
	type BeginChallengeCommand,
	type ChallengeReduceContext,
	type CleanupRoundOptions,
	type SessionReduceResult
} from './reducer';
import type { ChallengeConfig } from './types';
import { FOOL_CARD_ID } from '../../card-commands';
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
import { findModifierParams, CHALLENGE_AIM_ID, CHALLENGE_BLACK_HONEY_ID, CHALLENGE_BRAINFEVER_ID, CHALLENGE_GUARD_ID, CHALLENGE_GUARDIAN_ANGEL_ID, CHALLENGE_STUN_ID } from './modifiers';
import { CHALLENGE_COUNSEL_ID } from './transfers';

/**
 * Every base-flow (non-modifier) Challenge action, one variant per procedure
 * function. Card-moving/targeting variants name the acting tenure explicitly
 * rather than trusting `context.actor` alone — the GM may act on behalf of
 * any enemy but a player only ever their own tenure, exactly as each
 * delegated function already re-verifies via `tenureOwners` (never trust the
 * client's own claim beyond what the underlying function itself checks).
 */
export type ChallengeBaseCommand =
	| ({ type: 'begin-challenge' } & BeginChallengeCommand)
	| { type: 'deal-round' }
	| { type: 'place-initiative'; tenureId: string; cardId: string }
	| { type: 'place-gm-initiative'; enemyFactId: string; cardId: string }
	| { type: 'reveal-initiative' }
	| { type: 'begin-turns' }
	| { type: 'end-turn' }
	| { type: 'play-action'; tenureId: string; cardId: string }
	| { type: 'play-minor-action'; tenureId: string; cardId: string; actionSuit: SuitId }
	| { type: 'play-fool'; tenureId: string; pairedCardId: string }
	| { type: 'gm-play'; cardId: string }
	| { type: 'gm-minor-action'; cardId: string }
	| { type: 'gm-discard'; cardId: string }
	| { type: 'gm-mulligan' }
	| { type: 'cleanup-round'; options?: CleanupRoundOptions };

const CHALLENGE_BASE_COMMAND_TYPES: ReadonlySet<ChallengeBaseCommand['type']> = new Set([
	'begin-challenge',
	'deal-round',
	'place-initiative',
	'place-gm-initiative',
	'reveal-initiative',
	'begin-turns',
	'end-turn',
	'play-action',
	'play-minor-action',
	'play-fool',
	'gm-play',
	'gm-minor-action',
	'gm-discard',
	'gm-mulligan',
	'cleanup-round'
]);

export type ChallengeCommand = ChallengeBaseCommand | ChallengeModifierCommand;

/**
 * Derives the set of base-flow command TYPES currently offered to `actor` —
 * mirrors `modifiers.ts`'s `legalChallengeModifierCommands` (coarse, role +
 * stage + live-state derivation, not per-zone/per-card legality) for the rest
 * of the Challenge surface, which that function knows nothing about. `config`
 * supplies the two content-driven caps (`cardsPerInitiativeTurn`/
 * `gmPlayBudget`) so a card-spending action is never offered once its
 * budget is already exhausted — the same "don't offer a button guaranteed to
 * fail" discipline `legalChallengeModifierCommands` established for
 * equipment (O1/O4).
 */
export function legalChallengeBaseCommands(
	state: SessionEngineStateV1,
	actor: SessionActor,
	config: ChallengeConfig
): ChallengeBaseCommand['type'][] {
	const challenge = readChallengeState(state);

	if (!challenge) {
		// Nothing active — only the GM may begin one, and only when no OTHER
		// procedure is currently mid-flight (the same gate `beginChallenge`
		// itself enforces; duplicated here only at the coarse "is it worth
		// offering the button at all" level).
		return actor.kind === 'gm' && state.procedure === null ? ['begin-challenge'] : [];
	}

	if (actor.kind === 'gm') {
		const legal: ChallengeBaseCommand['type'][] = [];
		if (challenge.stage === 'deal') legal.push('deal-round');

		if (challenge.stage === 'initiative-placement') {
			const anyEnemyUnplaced = challenge.enemyFacts.some(
				(enemy) => !challenge.initiativeOrder.some((entry) => entry.tenureId === enemy.id)
			);
			if (anyEnemyUnplaced) legal.push('place-gm-initiative');

			const requiredKeys = [...challenge.participantTenureIds, ...challenge.enemyFacts.map((enemy) => enemy.id)];
			const allPlaced = requiredKeys.every((key) => challenge.initiativeOrder.some((entry) => entry.tenureId === key));
			if (allPlaced) legal.push('reveal-initiative');
		}

		if (challenge.stage === 'initiative-reveal') legal.push('begin-turns');

		if (challenge.stage === 'turns') {
			if (challenge.activeTurnIndex !== null) legal.push('end-turn');
			const active = activeTurnEntry(challenge);
			if (active && !challenge.participantTenureIds.includes(active.tenureId)) {
				const gmBudget = challenge.budgets['gm'];
				if (gmBudget && !gmBudget.actionTaken && gmBudget.cardsThisTurn < config.gmPlayBudget) legal.push('gm-play');
				if (gmBudget && gmBudget.cardsThisTurn < config.gmPlayBudget) legal.push('gm-minor-action');
			}
			if (state.gmHand.length > 0) legal.push('gm-discard');
			if (!challenge.mulliganUsedThisRound) legal.push('gm-mulligan');
		}

		if (challenge.stage === 'initiative-reveal' || challenge.stage === 'turns' || challenge.stage === 'round-cleanup') {
			legal.push('cleanup-round');
		}
		return legal;
	}

	// Player.
	const tenureId = tenureIdForUser(challenge, actor.userId);
	if (!tenureId) return [];
	const legal: ChallengeBaseCommand['type'][] = [];

	if (challenge.stage === 'initiative-placement' && !challenge.initiativeOrder.some((entry) => entry.tenureId === tenureId)) {
		legal.push('place-initiative');
	}

	if (challenge.stage === 'turns') {
		const active = activeTurnEntry(challenge);
		if (active?.tenureId === tenureId) {
			legal.push('end-turn');
			const budget = challenge.budgets[tenureId];
			const budgetAvailable = budget !== undefined && budget.cardsThisTurn < config.cardsPerInitiativeTurn;
			if (budgetAvailable && !budget!.actionTaken) legal.push('play-action');
			if (budgetAvailable) legal.push('play-minor-action');

			if (!budget?.actionTaken) {
				const hand = findZoneDescriptor(state, challengeHandZoneId(tenureId));
				const holdsFool = hand?.cards.includes(FOOL_CARD_ID) ?? false;
				const hasPairableCard = (hand?.cards.length ?? 0) >= 2;
				if (holdsFool && hasPairableCard) legal.push('play-fool');
			}
		}
	}

	return legal;
}

/** The combined base + modifier legal set (O1's `projection.controls`). */
export function legalChallengeCommands(
	state: SessionEngineStateV1,
	actor: SessionActor,
	config: ChallengeConfig,
	modifierCaps: ChallengeModifierDerivationCaps
): ChallengeCommand['type'][] {
	return [...legalChallengeBaseCommands(state, actor, config), ...legalChallengeModifierCommands(state, actor, modifierCaps)];
}

function applyChallengeBaseCommand(
	state: SessionEngineStateV1,
	command: ChallengeBaseCommand,
	context: ChallengeReduceContext
): SessionReduceResult {
	switch (command.type) {
		case 'begin-challenge':
			return beginChallenge(
				state,
				{ participantTenureIds: command.participantTenureIds, enemyFacts: command.enemyFacts, tenureOwners: command.tenureOwners },
				context
			);
		case 'deal-round':
			return dealRound(state, context);
		case 'place-initiative':
			return placeInitiative(state, command.tenureId, command.cardId, context);
		case 'place-gm-initiative':
			return placeGmInitiative(state, command.enemyFactId, command.cardId, context);
		case 'reveal-initiative':
			return revealInitiative(state, context);
		case 'begin-turns':
			return beginTurns(state, context);
		case 'end-turn':
			return endTurn(state, context);
		case 'play-action':
			return applyPlayerAction(state, command.tenureId, command.cardId, context);
		case 'play-minor-action':
			return applyPlayerMinorAction(state, command.tenureId, command.cardId, command.actionSuit, context);
		case 'play-fool':
			return playFool(state, command.tenureId, command.pairedCardId, context);
		case 'gm-play':
			return applyGmPlay(state, command.cardId, context);
		case 'gm-minor-action':
			return applyGmMinorAction(state, command.cardId, context);
		case 'gm-discard':
			return applyGmDiscard(state, command.cardId, context);
		case 'gm-mulligan':
			return applyGmMulligan(state, context);
		case 'cleanup-round':
			return cleanupRound(state, context, command.options);
	}
}

/**
 * The single entry point a command-issuing layer (a test, or
 * `challenge-command-service.ts`'s HTTP wiring) calls: derives the full legal
 * set (base + modifier) via `legalChallengeCommands` and rejects `command`
 * OUTRIGHT — `illegal-command`, before ever reaching the underlying
 * mechanism — if its `type` is absent from that set. Mirrors
 * `modifiers.ts`'s `applyChallengeModifierCommand` exactly, extended to cover
 * the base flow too. Modifier commands are still independently re-checked by
 * `applyChallengeModifierCommand` itself (defense in depth, exactly as that
 * function already does relative to its own callers).
 */
export function applyChallengeCommand(
	state: SessionEngineStateV1,
	command: ChallengeCommand,
	materials: ChallengeModifierMaterials,
	context: ChallengeReduceContext
): SessionReduceResult {
	// Branch-fix ("also fix"): a CORRUPT Challenge state parses as "no active
	// round" everywhere, so every command below would reject with a misleading
	// "not currently offered" message. Surface a distinct rejection instead, so
	// a corrupt `gmPrivate` blob is diagnosable rather than presenting as an
	// empty legal set.
	if (isChallengeStateCorrupt(state)) {
		return reject('illegal-command', 'the active Challenge state is corrupt and cannot be read — contact the GM');
	}

	const modifierCaps: ChallengeModifierDerivationCaps = {
		counselMaxUsesPerRound: materials.counsel.maxUsesPerRound,
		guardianAngelMaxInstances: materials.guardianAngel.maxInstances,
		hasBow: materials.hasBow,
		hasShield: materials.hasShield
	};
	const legal = legalChallengeCommands(state, context.actor, context.config, modifierCaps);
	if (!legal.includes(command.type)) {
		return reject('illegal-command', `${command.type} is not currently offered to this actor`);
	}

	if (CHALLENGE_BASE_COMMAND_TYPES.has(command.type as ChallengeBaseCommand['type'])) {
		return applyChallengeBaseCommand(state, command as ChallengeBaseCommand, context);
	}
	return applyChallengeModifierCommand(state, command as ChallengeModifierCommand, materials, context);
}

/**
 * Assembles the full `ChallengeModifierMaterials` bag from the content pack's
 * `modifiers` catalog plus the two equipment booleans the engine cannot
 * verify itself (O2) — the single place a caller (a test, or
 * `challenge-command-service.ts`) builds this once per session/content-load,
 * mirroring `tests/unit/session/challenge/modifiers.test.ts`'s own inline
 * assembly exactly (kept in lockstep with that test rather than diverging).
 */
export function buildChallengeModifierMaterials(
	modifiers: readonly SessionModifierDefinition[],
	equipment: { hasBow: boolean; hasShield: boolean }
): ChallengeModifierMaterials {
	return {
		blackHoney: findModifierParams<OptionalHandSizeParams>(modifiers, CHALLENGE_BLACK_HONEY_ID, 'optional-hand-size'),
		stun: findModifierParams<ForcedHandDiscardParams>(modifiers, CHALLENGE_STUN_ID, 'forced-hand-discard'),
		brainfever: findModifierParams<ForcedInitiativeSelectionParams>(modifiers, CHALLENGE_BRAINFEVER_ID, 'forced-initiative-selection'),
		counsel: findModifierParams<CounselTransferParams>(modifiers, CHALLENGE_COUNSEL_ID, 'private-transfer'),
		guardianAngel: findModifierParams<GuardianAngelParams>(modifiers, CHALLENGE_GUARDIAN_ANGEL_ID, 'guardian-angel-defense'),
		aim: findModifierParams<PreparedFacedownBonusParams>(modifiers, CHALLENGE_AIM_ID, 'prepared-facedown-bonus'),
		guard: findModifierParams<ReplaceInitiativeParams>(modifiers, CHALLENGE_GUARD_ID, 'replace-initiative'),
		hasBow: equipment.hasBow,
		hasShield: equipment.hasShield
	};
}
