/**
 * The correction command service (Increment 4 Task 5), on the shared loop.
 * One command: a typed compensating correction, GM-only in the engine
 * (`$lib/engine/session/corrections.ts`), applied through the ordinary
 * reducer and appended to the journal — never an edit of it.
 */

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { campaignEvents } from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import type { AppDbContext } from '$lib/server/db/atomic';
import type { SessionProjection } from '$lib/engine/session/projection';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { applyCorrection, type CorrectionCommand } from '$lib/engine/session/corrections';
import type { ReduceContext } from '$lib/engine/session/reducer';
import { loadTableProjectionsForActor } from './table-projections';
import { executeProcedureCommand, type ProcedureCommandAdapter, type ProcedureCommandOutcome } from './procedure-command-loop';
import type { SessionCommandEnvelope, SessionProjectionEnvelope } from '$lib/types/session';

const id = z.string().trim().min(1).max(128);

/** `.strict()` — a correction names zones, a card, the original event, and a
 * reason; it can never smuggle a state edit. */
const correctionCommandSchema = z
	.object({
		kind: z.literal('move-card'),
		targetEventId: id,
		reason: z.string().trim().min(1).max(500),
		sourceZoneId: id,
		cardId: id,
		destinationZoneId: id
	})
	.strict();

export const correctionEnvelopeSchema = z
	.object({ commandId: id, observedSessionVersion: z.number().int().nonnegative(), command: correctionCommandSchema })
	.strict();

/** The loop hashes/persists `command.type`; corrections discriminate on
 * `kind`, so the adapter wraps them with a fixed type tag. */
type WrappedCorrection = CorrectionCommand & { type: 'apply-correction' };

const adapter: ProcedureCommandAdapter<WrappedCorrection, ReduceContext> = {
	label: 'correction',
	// `apply-correction` is STRUCTURAL in the frozen envelope contract: one
	// attempt, real structural precondition, and a stale board is re-authored
	// rather than silently re-applied.
	structural: true,
	parseEnvelope(raw) {
		const parsed = correctionEnvelopeSchema.safeParse(raw);
		if (!parsed.success) return { ok: false };
		const envelope = {
			...parsed.data,
			command: { ...parsed.data.command, type: 'apply-correction' as const }
		};
		return { ok: true, envelope: envelope as unknown as SessionCommandEnvelope<WrappedCorrection> };
	},
	async buildContext({ actor, loaded, rng }) {
		return { actor, runtime: toSessionEngineRuntime(loaded.runtimeContent), rng };
	},
	apply(state, command, context) {
		return applyCorrection(state, command, context);
	}
};

export interface ExecuteCorrectionInput {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	actorUserId: string;
	envelope: unknown;
}

export interface ExecuteCorrectionResult {
	outcome: ProcedureCommandOutcome;
	projection: SessionProjectionEnvelope<SessionProjection> | null;
}

export async function executeCorrectionCommand(input: ExecuteCorrectionInput): Promise<ExecuteCorrectionResult> {
	const db = input.dbContext.db as unknown as AppDb;

	// The audited link must point at a REAL event in THIS session — an audit
	// trail that can cite a nonexistent or foreign event is not an audit trail.
	// Checked before the loop so a bad reference never reaches the reducer.
	const parsed = correctionEnvelopeSchema.safeParse(input.envelope);
	if (parsed.success) {
		// Strictly canonical digits: `parseInt` would accept "42junk" and validate
		// event 42 while the journal recorded "42junk" — an audit link that does
		// not identify the event it was checked against (second-pass review).
		const raw = parsed.data.command.targetEventId;
		const targetId = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
		const target = Number.isNaN(targetId)
			? undefined
			: await db
					.select({ id: campaignEvents.id })
					.from(campaignEvents)
					.where(and(eq(campaignEvents.id, targetId), eq(campaignEvents.sessionId, input.sessionId)))
					.get();
		if (!target) {
			return {
				outcome: { ok: false, code: 'illegal-command', message: 'the corrected event does not belong to this session' },
				projection: null
			};
		}
	}

	const { actor, outcome, suppressProjections } = await executeProcedureCommand(input, adapter);
	if (!actor || suppressProjections) return { outcome, projection: null };
	const { projection } = await loadTableProjectionsForActor(db, input.sessionId, input.campaignId, actor);
	return { outcome, projection };
}
