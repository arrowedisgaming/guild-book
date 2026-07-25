/**
 * The Camp command service (Increment 4 Task 3).
 *
 * The whole execution loop lives in `procedure-command-loop.ts`; this module
 * supplies only what is specific to Camp — the envelope schema, the reduce
 * context, and the dispatcher. That is the entire reason the shared loop exists:
 * a fourth hand-written copy of the authorize/parse/idempotency/commit/retry
 * sequence would have been ~280 lines of code identical to the guided test's.
 *
 * No Camp command spends a character resource, so `spendsResolve` is omitted
 * from the adapter — which makes the loop refuse ANY Camp envelope carrying a
 * reconfirmation pair. Leeches' cured affliction is reported as a public outcome
 * and applied by the table, never by the app.
 *
 * Never imports `@sveltejs/kit` — no HTTP status codes in this layer.
 */

import type { AppDb } from '$lib/server/db';
import type { AppDbContext } from '$lib/server/db/atomic';
import type { SessionProjection } from '$lib/engine/session/projection';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { applyCampCommand, type CampProcedureCommand } from '$lib/engine/session/procedures/camp-command';
import { buildCampConfig, type CampReduceContext } from '$lib/engine/session/procedures/camp';
import type { CampControl, CampProjection } from '$lib/engine/session/procedures/camp-projection';
import { campCommandEnvelopeSchema } from '$lib/schemas/camp-command.schema';
import { loadCampMaterials } from './guided-test-materials';
import { loadTableProjectionsForActor } from './table-projections';
import { executeProcedureCommand, type ProcedureCommandAdapter, type ProcedureCommandOutcome } from './procedure-command-loop';
import type { SessionActor, SessionCommandEnvelope, SessionProjectionEnvelope } from '$lib/types/session';

export type CampCommandOutcome = ProcedureCommandOutcome;

export interface ExecuteCampCommandInput {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	/** Already authenticated by the caller (the HTTP route). */
	actorUserId: string;
	/** Not yet parsed or trusted. */
	envelope: unknown;
}

export interface ExecuteCampCommandResult {
	outcome: CampCommandOutcome;
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	campProjection: CampProjection | null;
	campLegalCommands: CampControl[];
}

const NO_PROJECTIONS = { projection: null, campProjection: null, campLegalCommands: [] as CampControl[] };

const adapter: ProcedureCommandAdapter<CampProcedureCommand, CampReduceContext> = {
	label: 'camp',
	parseEnvelope(raw) {
		const parsed = campCommandEnvelopeSchema.safeParse(raw);
		if (!parsed.success) return { ok: false };
		return { ok: true, envelope: parsed.data as unknown as SessionCommandEnvelope<CampProcedureCommand> };
	},
	async buildContext({ db, campaignId, actor, loaded, rng }) {
		return {
			actor,
			runtime: toSessionEngineRuntime(loaded.runtimeContent),
			rng,
			// Built from the session's PINNED content, so a mid-campaign pack update
			// cannot change a live session's inspiration allowance or leech suits.
			config: buildCampConfig(loaded.runtimeContent.procedures, loaded.runtimeContent.formulas, loaded.runtimeContent.modifiers),
			materials: await loadCampMaterials(db, campaignId)
		};
	},
	apply: applyCampCommand
};

/** Thin delegation to the single combined projection loader — see
 * `table-projections.ts`'s header for why one session load builds every
 * procedure's slice. */
export async function loadCampProjectionsForActor(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	actor: SessionActor
): Promise<{
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	campProjection: CampProjection | null;
	campLegalCommands: CampControl[];
	loadFailure: 'not-found' | 'unloadable' | null;
}> {
	const { projection, campProjection, campLegalCommands, loadFailure } = await loadTableProjectionsForActor(
		db,
		sessionId,
		campaignId,
		actor
	);
	return { projection, campProjection, campLegalCommands, loadFailure };
}

export async function executeCampCommand(input: ExecuteCampCommandInput): Promise<ExecuteCampCommandResult> {
	const db = input.dbContext.db as unknown as AppDb;
	const { actor, outcome, suppressProjections } = await executeProcedureCommand(input, adapter);

	if (!actor || suppressProjections) return { outcome, ...NO_PROJECTIONS };

	const { projection, campProjection, campLegalCommands } = await loadCampProjectionsForActor(
		db,
		input.sessionId,
		input.campaignId,
		actor
	);
	return { outcome, projection, campProjection, campLegalCommands };
}
