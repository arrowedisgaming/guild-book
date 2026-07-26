/**
 * The guided test-of-fate command service (Increment 4 Task 2, rebuilt on the
 * shared loop in Task 3).
 *
 * The execution loop itself — authorize, strict-parse, commandId+hash
 * idempotency, load-reduce-commit under a version claim, retry a lost race,
 * persist a rejection, splice a resource write into the same atomic batch —
 * lives in `procedure-command-loop.ts`. This module supplies only what is
 * specific to this surface: the envelope schema, which command spends Resolve,
 * the reduce context, and the dispatcher.
 *
 * ## The one thing this surface does that Camp does not
 *
 * `purchase-test-favor` causes a CHARACTER write. The loop evaluates the spend
 * before the reduce and splices its statements into the same atomic batch, so
 * the Resolve decrement and the recorded purchase commit together or not at all
 * — never a charge without the favor recorded, never a double charge.
 * `spendsResolve` below is how the loop knows which command to do it for.
 *
 * It does NOT make the spend and the later draw one transaction (corrected after
 * review): Ch1 makes buying favor a *prior* election, so the draw is its own
 * command. A player who buys and then abandons the test has spent the point,
 * which is what electing to spend before a test you never take means at the
 * table.
 *
 * Never imports `@sveltejs/kit` — no HTTP status codes in this layer.
 */

import type { AppDb } from '$lib/server/db';
import type { AppDbContext } from '$lib/server/db/atomic';
import type { SessionProjection } from '$lib/engine/session/projection';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { applyGuidedTestCommand, spendsResolve, type GuidedTestCommand } from '$lib/engine/session/procedures/guided-test-command';
import type { GuidedTestControl, GuidedTestProjection } from '$lib/engine/session/procedures/guided-test-projection';
import { TEST_OF_FATE_PROCEDURE_ID, type GuidedTestReduceContext } from '$lib/engine/session/procedures/test-of-fate';
import { guidedTestCommandEnvelopeSchema } from '$lib/schemas/guided-test-command.schema';
import { loadGuidedTestMaterials } from './guided-test-materials';
import { loadTableProjectionsForActor } from './table-projections';
import { SessionLoadIntegrityError } from './repository';
import {
	executeProcedureCommand,
	type ProcedureCommandAdapter,
	type ProcedureCommandOutcome
} from './procedure-command-loop';
import type { SessionActor, SessionCommandEnvelope, SessionProjectionEnvelope } from '$lib/types/session';
import type { TarotProcedureDefinition } from '$lib/types/content-pack';

export type GuidedTestCommandOutcome = ProcedureCommandOutcome;

export interface ExecuteGuidedTestCommandInput {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	/** Already authenticated by the caller (the HTTP route). */
	actorUserId: string;
	/** Not yet parsed or trusted. */
	envelope: unknown;
}

export interface ExecuteGuidedTestCommandResult {
	outcome: GuidedTestCommandOutcome;
	/** The actor's fresh GENERIC session projection, alongside the guided-test
	 * slice, so a client never reconciles two load paths for one session. */
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	guidedTestProjection: GuidedTestProjection | null;
	/** Present even when no test is in flight, so the GM's "call for a test"
	 * control has a server-computed answer to render from. */
	guidedTestLegalCommands: GuidedTestControl[];
}

const NO_PROJECTIONS = {
	projection: null,
	guidedTestProjection: null,
	guidedTestLegalCommands: [] as GuidedTestControl[]
};

/** The pinned `test-of-fate` definition. Read from the session's OWN pinned
 * runtime content, never the live bundle: a mid-campaign content update must not
 * change a live session's reshuffle boundary. */
function pinnedTestProcedure(procedures: readonly TarotProcedureDefinition[]): TarotProcedureDefinition {
	const found = procedures.find((procedure) => procedure.id === TEST_OF_FATE_PROCEDURE_ID);
	if (!found) {
		throw new SessionLoadIntegrityError(`pinned runtime content is missing the ${TEST_OF_FATE_PROCEDURE_ID} procedure`);
	}
	return found;
}

const adapter: ProcedureCommandAdapter<GuidedTestCommand, GuidedTestReduceContext> = {
	label: 'guided-test',
	parseEnvelope(raw) {
		const parsed = guidedTestCommandEnvelopeSchema.safeParse(raw);
		if (!parsed.success) return { ok: false };
		return { ok: true, envelope: parsed.data as unknown as SessionCommandEnvelope<GuidedTestCommand> };
	},
	spendsResolve,
	spendMismatchMessage: 'only the pre-draw favor purchase may spend Resolve, and it must carry the reconfirmation pair',
	async buildContext({ db, campaignId, actor, loaded, rng }) {
		return {
			actor,
			runtime: toSessionEngineRuntime(loaded.runtimeContent),
			rng,
			config: loaded.runtimeContent.tarot,
			materials: await loadGuidedTestMaterials(db, campaignId),
			procedure: pinnedTestProcedure(loaded.runtimeContent.procedures)
		};
	},
	apply: applyGuidedTestCommand
};

/**
 * Thin delegation to `table-projections.ts`'s single combined loader — see that
 * module's header for why one load builds every procedure's slice. Kept as a
 * named export so this service and its route never build a divergent projection.
 */
export async function loadGuidedTestProjectionsForActor(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	actor: SessionActor
): Promise<{
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	guidedTestProjection: GuidedTestProjection | null;
	guidedTestLegalCommands: GuidedTestControl[];
	loadFailure: 'not-found' | 'unloadable' | null;
}> {
	const { projection, guidedTestProjection, guidedTestLegalCommands, loadFailure } = await loadTableProjectionsForActor(
		db,
		sessionId,
		campaignId,
		actor
	);
	return { projection, guidedTestProjection, guidedTestLegalCommands, loadFailure };
}

export async function executeGuidedTestCommand(input: ExecuteGuidedTestCommandInput): Promise<ExecuteGuidedTestCommandResult> {
	const db = input.dbContext.db as unknown as AppDb;
	const { actor, outcome, suppressProjections } = await executeProcedureCommand(input, adapter);

	if (!actor || suppressProjections) return { outcome, ...NO_PROJECTIONS };

	const { projection, guidedTestProjection, guidedTestLegalCommands } = await loadGuidedTestProjectionsForActor(
		db,
		input.sessionId,
		input.campaignId,
		actor
	);
	return { outcome, projection, guidedTestProjection, guidedTestLegalCommands };
}
