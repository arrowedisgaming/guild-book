/**
 * The finite-runner command service (Increment 4 Task 4), on the shared loop —
 * this module supplies only the envelope schema, the reduce context, and the
 * dispatcher. No runner command spends a character resource, so `spendsResolve`
 * is omitted and the loop refuses any envelope carrying the reconfirmation
 * pair. Never imports `@sveltejs/kit`.
 */

import type { AppDb } from '$lib/server/db';
import type { AppDbContext } from '$lib/server/db/atomic';
import type { SessionProjection } from '$lib/engine/session/projection';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import {
	advanceFiniteProcedure,
	beginFiniteProcedure,
	completeFiniteProcedure,
	type FiniteReduceContext
} from '$lib/engine/session/procedures/finite-procedure';
import type { FiniteControl, FiniteProjection } from '$lib/engine/session/procedures/finite-projection';
import { finiteCommandEnvelopeSchema, type FiniteCommandInput } from '$lib/schemas/finite-command.schema';
import { loadCampMaterials } from './guided-test-materials';
import { loadTableProjectionsForActor } from './table-projections';
import { executeProcedureCommand, type ProcedureCommandAdapter, type ProcedureCommandOutcome } from './procedure-command-loop';
import type { SessionActor, SessionCommandEnvelope, SessionProjectionEnvelope } from '$lib/types/session';

export type FiniteCommandOutcome = ProcedureCommandOutcome;

export interface ExecuteFiniteCommandInput {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	actorUserId: string;
	envelope: unknown;
}

export interface ExecuteFiniteCommandResult {
	outcome: FiniteCommandOutcome;
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	finiteProjection: FiniteProjection | null;
	finiteLegalCommands: FiniteControl[];
}

const NO_PROJECTIONS = { projection: null, finiteProjection: null, finiteLegalCommands: [] as FiniteControl[] };

const adapter: ProcedureCommandAdapter<FiniteCommandInput, FiniteReduceContext> = {
	label: 'finite',
	parseEnvelope(raw) {
		const parsed = finiteCommandEnvelopeSchema.safeParse(raw);
		if (!parsed.success) return { ok: false };
		return { ok: true, envelope: parsed.data as unknown as SessionCommandEnvelope<FiniteCommandInput> };
	},
	async buildContext({ db, campaignId, actor, loaded, rng }) {
		return {
			actor,
			runtime: toSessionEngineRuntime(loaded.runtimeContent),
			rng,
			// Pinned content — a mid-campaign pack update never changes a live
			// session's tables or steps.
			procedures: loaded.runtimeContent.procedures,
			lookupTables: loaded.runtimeContent.lookupTables,
			materials: await loadCampMaterials(db, campaignId)
		};
	},
	apply(state, command, context) {
		switch (command.type) {
			case 'begin-finite-procedure':
				return beginFiniteProcedure(
					state,
					{ procedureId: command.procedureId, actorTenureId: command.actorTenureId, mode: command.mode, realmTableId: command.realmTableId },
					context
				);
			case 'advance-finite-procedure':
				return advanceFiniteProcedure(
					state,
					{ stepId: command.stepId, confirm: command.confirm, chosenCardId: command.chosenCardId, orderedCardIds: command.orderedCardIds },
					context
				);
			case 'complete-finite-procedure':
				return completeFiniteProcedure(state, context);
		}
	}
};

/** Thin delegation to the single combined projection loader. */
export async function loadFiniteProjectionsForActor(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	actor: SessionActor
): Promise<{
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	finiteProjection: FiniteProjection | null;
	finiteLegalCommands: FiniteControl[];
	loadFailure: 'not-found' | 'unloadable' | null;
}> {
	const { projection, finiteProjection, finiteLegalCommands, loadFailure } = await loadTableProjectionsForActor(
		db,
		sessionId,
		campaignId,
		actor
	);
	return { projection, finiteProjection, finiteLegalCommands, loadFailure };
}

export async function executeFiniteCommand(input: ExecuteFiniteCommandInput): Promise<ExecuteFiniteCommandResult> {
	const db = input.dbContext.db as unknown as AppDb;
	const { actor, outcome, suppressProjections } = await executeProcedureCommand(input, adapter);
	if (!actor || suppressProjections) return { outcome, ...NO_PROJECTIONS };
	const { projection, finiteProjection, finiteLegalCommands } = await loadFiniteProjectionsForActor(db, input.sessionId, input.campaignId, actor);
	return { outcome, projection, finiteProjection, finiteLegalCommands };
}
