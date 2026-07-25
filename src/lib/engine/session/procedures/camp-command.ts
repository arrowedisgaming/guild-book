/**
 * The single Camp dispatch entry point (Increment 4 Task 3), mirroring
 * `guided-test-command.ts` and `challenge/command.ts`: derive the legal set,
 * reject a command whose type is absent from it OUTRIGHT, then dispatch.
 *
 * Deliberately NOT added to `SessionCommand` — that union is the frozen
 * Cross-Increment Contract. This is a parallel, additive surface.
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { SessionEngineStateV1, SessionEvent, SessionRejection } from '$lib/types/session';
import type { ReduceResult } from '../result';
import {
	advanceLeeches,
	beginHighChant,
	beginLeeches,
	completeCampProcedure,
	completeHighChantTransfer,
	readCampProcedure,
	selectInspiration,
	type CampReduceContext
} from './camp';
import { legalCampCommands, type CampControl } from './camp-projection';

export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

/**
 * Every Camp action.
 *
 * The plan sketched `begin-high-chant` as carrying a `recipientTenureId` and
 * `complete-high-chant-transfer` as carrying only a `cardId`. That pairing
 * cannot express the rule: Ch5 has the performer select N cards from the discard
 * FIRST (N = their Cups) and only then distribute them, and a distribution step
 * that names a card without a recipient has nowhere to put it. The commands
 * below follow the content pack's own two steps — `select-inspiration` then
 * `distribute-inspiration` — with the plan's names kept where they still fit.
 */
export type CampProcedureCommand =
	| { type: 'begin-high-chant' }
	| { type: 'select-inspiration'; cardIds: string[] }
	| { type: 'complete-high-chant-transfer'; cardId: string; recipientTenureId: string }
	| { type: 'begin-leeches'; targetTenureId: string }
	| { type: 'advance-leeches' }
	| { type: 'complete-camp-procedure' };

export function applyCampCommand(
	state: SessionEngineStateV1,
	command: CampProcedureCommand,
	context: CampReduceContext
): SessionReduceResult {
	const legal: CampControl[] = legalCampCommands(state, context.actor, context.materials, context.config);
	if (!legal.includes(command.type)) {
		return {
			ok: false,
			rejection: { code: 'illegal-command', message: `${command.type} is not currently offered to this actor` }
		};
	}
	return dispatch(state, command, context);
}

function dispatch(
	state: SessionEngineStateV1,
	command: CampProcedureCommand,
	context: CampReduceContext
): SessionReduceResult {
	switch (command.type) {
		case 'begin-high-chant':
			return beginHighChant(state, context);
		case 'select-inspiration':
			return selectInspiration(state, { cardIds: command.cardIds }, context);
		case 'complete-high-chant-transfer':
			return completeHighChantTransfer(state, { cardId: command.cardId, recipientTenureId: command.recipientTenureId }, context);
		case 'begin-leeches':
			return beginLeeches(state, { targetTenureId: command.targetTenureId }, context);
		case 'advance-leeches':
			return advanceLeeches(state, context);
		case 'complete-camp-procedure':
			return completeCampProcedure(state, context);
	}
}

/** True when any Camp procedure currently occupies the procedure slot — used by
 * a caller that needs to know whether to route a command here at all. */
export function hasActiveCampProcedure(state: SessionEngineStateV1): boolean {
	return readCampProcedure(state) !== undefined;
}
