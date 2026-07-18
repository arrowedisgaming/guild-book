/**
 * The generic pure card reducer for the shared tarot table. Dispatches every
 * `SessionCommand` variant to its handler in `card-commands.ts`, gates on
 * coarse role authorization first, and — on success — asserts whole-state
 * invariants before returning. Never touches `state.version`; the command
 * service (Task 5) owns versioning, idempotency, and staleness.
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { SessionActor, SessionCommand, SessionEngineStateV1, SessionEvent, SessionRejection, TarotCardCatalog } from '$lib/types/session';
import type { Rng } from '../rng';
import type { ReduceResult } from './result';
import { assertSessionInvariants } from './invariants';
import {
	handleAdvanceProcedure,
	handleApplyCorrection,
	handleBeginProcedure,
	handleCompleteProcedure,
	handleDeal,
	handleDraw,
	handleEndRound,
	handleGenericMove,
	handleMulligan,
	handleReorderTop,
	handleReveal,
	type CommandHandlerContext
} from './card-commands';

/** Alias per controller amendment 1/2. */
export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

/**
 * The minimal runtime configuration the reducer genuinely needs (controller
 * amendment 8). Task 4 later compiles the full `SessionRuntimeContentV1`
 * (procedures, modifiers, art); until then the reducer only requires the
 * card catalog for content-mismatch/deck checks and invariant checking.
 */
export interface SessionEngineRuntime {
	catalog: TarotCardCatalog;
}

export interface ReduceContext {
	actor: SessionActor;
	runtime: SessionEngineRuntime;
	rng: Rng;
}

const GM_ONLY_COMMAND_TYPES: ReadonlySet<SessionCommand['type']> = new Set([
	'deal',
	'begin-procedure',
	'advance-procedure',
	'complete-procedure',
	'end-round',
	'apply-correction'
]);

const ALL_COMMAND_TYPES: SessionCommand['type'][] = [
	'draw',
	'deal',
	'play',
	'place-facedown',
	'reveal',
	'discard',
	'transfer',
	'select-from-discard',
	'reorder-top',
	'mulligan',
	'begin-procedure',
	'advance-procedure',
	'complete-procedure',
	'end-round',
	'apply-correction'
];

/**
 * Command types `actor`'s role may attempt in principle, independent of any
 * specific command instance's zones/cards. This is the coarse authorization
 * gate `reduceSession` checks before dispatch (single source of truth, not a
 * client-side guess); fine-grained per-zone authorization still happens in
 * each handler via `actorMayAccessZone`. GM-only structural commands match
 * spec §8.6 ("The GM advances phases and rounds") and the `apply-correction`
 * doc comment.
 */
export function legalCommandsForActor(actor: SessionActor): SessionCommand['type'][] {
	if (actor.kind === 'gm') return ALL_COMMAND_TYPES.slice();
	return ALL_COMMAND_TYPES.filter((type) => !GM_ONLY_COMMAND_TYPES.has(type));
}

export function reduceSession(state: SessionEngineStateV1, command: SessionCommand, context: ReduceContext): SessionReduceResult {
	if (!legalCommandsForActor(context.actor).includes(command.type)) {
		return {
			ok: false,
			rejection: { code: 'not-authorized', message: `${context.actor.kind} may not issue ${command.type}` }
		};
	}

	const handlerContext: CommandHandlerContext = { actor: context.actor, catalog: context.runtime.catalog, rng: context.rng };
	const result = dispatch(command, state, handlerContext);
	if (!result.ok) return result;

	// A throw here means a handler produced an inconsistent state — a reducer
	// bug, not a rejectable user error — so it is deliberately left uncaught.
	assertSessionInvariants(result.state, context.runtime.catalog);
	return result;
}

function dispatch(command: SessionCommand, state: SessionEngineStateV1, ctx: CommandHandlerContext): SessionReduceResult {
	switch (command.type) {
		case 'draw':
			return handleDraw(command, state, ctx);
		case 'deal':
			return handleDeal(command, state, ctx);
		case 'play':
			return handleGenericMove('card-played', command, state, ctx);
		case 'place-facedown':
			return handleGenericMove('card-placed-facedown', command, state, ctx);
		case 'discard':
			return handleGenericMove('card-discarded', command, state, ctx);
		case 'transfer':
			return handleGenericMove('card-transferred', command, state, ctx);
		case 'select-from-discard':
			return handleGenericMove('card-selected-from-discard', command, state, ctx);
		case 'reveal':
			return handleReveal(command, state, ctx);
		case 'reorder-top':
			return handleReorderTop(command, state, ctx);
		case 'mulligan':
			return handleMulligan(command, state, ctx);
		case 'begin-procedure':
			return handleBeginProcedure(command, state, ctx);
		case 'advance-procedure':
			return handleAdvanceProcedure(command, state, ctx);
		case 'complete-procedure':
			return handleCompleteProcedure(command, state, ctx);
		case 'end-round':
			return handleEndRound(command, state, ctx);
		case 'apply-correction':
			return handleApplyCorrection(command, state, ctx);
	}
}
