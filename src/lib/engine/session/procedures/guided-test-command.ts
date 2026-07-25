/**
 * The single guided-test dispatch entry point (Increment 4 Task 2). Unifies the
 * individual transitions (`./test-of-fate.ts`) and the group sequencer
 * (`./group-test.ts`) behind ONE discriminated command type and ONE
 * legality-then-dispatch function, mirroring `challenge/command.ts`'s
 * `applyChallengeCommand` exactly.
 *
 * Deliberately NOT added to `SessionCommand` (`$lib/types/session.ts`) — that
 * union is the frozen Cross-Increment Contract. This is a parallel, additive
 * command surface that `$lib/server/session/guided-test-command-service.ts`
 * dispatches, never a change to the frozen union or to the generic
 * `reduceSession`/`dispatch` switch in `../reducer.ts`.
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { SuitId } from '$lib/types/common';
import type { SessionEngineStateV1, SessionEvent, SessionRejection } from '$lib/types/session';
import type { ReduceResult } from '../result';
import {
	completeGuidedTest,
	declareTestOfFate,
	declineTestPush,
	drawTestCard,
	purchaseTestFavorWithResolve,
	pushTestFate,
	setTestFavor,
	type GuidedTestReduceContext
} from './test-of-fate';
import { advanceGroupTest, declareGroupTest, overrideGroupTestActors } from './group-test';
import { legalGuidedTestCommands, type GuidedTestControl } from './guided-test-projection';

export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

export type GuidedTestCommand =
	| { type: 'declare-test-of-fate'; actorTenureId: string; testedSuit: SuitId }
	| { type: 'set-test-favor'; favor: boolean; disfavor: boolean }
	| { type: 'purchase-test-favor' }
	| { type: 'draw-test-card' }
	| { type: 'push-test-fate' }
	| { type: 'decline-test-push' }
	| { type: 'complete-guided-test' }
	| { type: 'declare-group-test'; testedSuit: SuitId; candidateTenureIds: string[] }
	| { type: 'advance-group-test' }
	| { type: 'override-group-test-actors'; mostQualifiedTenureId: string; leastQualifiedTenureId: string };

/**
 * The one command that causes a CHARACTER write. The service reads this rather
 * than string-matching the command type itself, so the set of resource-spending
 * commands lives next to the surface that defines them — if a later procedure
 * adds a second Resolve purchase, the service needs no change.
 */
export const RESOLVE_SPENDING_COMMAND_TYPES: ReadonlySet<GuidedTestCommand['type']> = new Set(['purchase-test-favor']);

export function spendsResolve(command: GuidedTestCommand): boolean {
	return RESOLVE_SPENDING_COMMAND_TYPES.has(command.type);
}

/**
 * Derives the legal set via `legalGuidedTestCommands` and rejects `command`
 * OUTRIGHT if its type is absent from it — before the underlying transition
 * runs. Each transition still re-checks its own preconditions, so this is
 * defence in depth over "never dispatch what the projection did not offer",
 * not the only guard.
 */
export function applyGuidedTestCommand(
	state: SessionEngineStateV1,
	command: GuidedTestCommand,
	context: GuidedTestReduceContext
): SessionReduceResult {
	const legal: GuidedTestControl[] = legalGuidedTestCommands(state, context.actor, context.materials);
	if (!legal.includes(command.type)) {
		return { ok: false, rejection: { code: 'illegal-command', message: `${command.type} is not currently offered to this actor` } };
	}
	return dispatch(state, command, context);
}

function dispatch(
	state: SessionEngineStateV1,
	command: GuidedTestCommand,
	context: GuidedTestReduceContext
): SessionReduceResult {
	switch (command.type) {
		case 'declare-test-of-fate':
			return declareTestOfFate(state, { actorTenureId: command.actorTenureId, testedSuit: command.testedSuit }, context);
		case 'set-test-favor':
			return setTestFavor(state, { favor: command.favor, disfavor: command.disfavor }, context);
		case 'purchase-test-favor':
			return purchaseTestFavorWithResolve(state, context);
		case 'draw-test-card':
			return drawTestCard(state, context);
		case 'push-test-fate':
			return pushTestFate(state, context);
		case 'decline-test-push':
			return declineTestPush(state, context);
		case 'complete-guided-test':
			return completeGuidedTest(state, context);
		case 'declare-group-test':
			return declareGroupTest(state, { testedSuit: command.testedSuit, candidateTenureIds: command.candidateTenureIds }, context);
		case 'advance-group-test':
			return advanceGroupTest(state, context);
		case 'override-group-test-actors':
			return overrideGroupTestActors(
				state,
				{ mostQualifiedTenureId: command.mostQualifiedTenureId, leastQualifiedTenureId: command.leastQualifiedTenureId },
				context
			);
	}
}
