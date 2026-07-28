/**
 * The ONE actor-scoped projection loader for the shared tarot table (Increment 4
 * Task 2). Loads a session's fragments exactly ONCE and builds every slice a
 * viewer is entitled to from that single read: the generic session projection,
 * the Challenge procedure's slice, and the guided test of fate's slice.
 *
 * This exists because there is now more than one procedure with its own
 * projection. Increment 3's `loadChallengeProjectionsForActor` already made the
 * right call — "one combined loader so this route never diverges" — and the
 * wrong way to extend that to a second procedure is a second loader called
 * beside the first: `GET /sync` polls on a ~1s cadence, so every additional
 * loader would re-read and re-parse every fragment of the same session on every
 * poll, for every viewer. One load, N slices.
 *
 * Each slice is built inside its OWN try/catch. A fault in one procedure's
 * content or projector must never null the generic projection (which would blank
 * the whole table) nor another procedure's slice — the separation Increment 3's
 * branch-fix I5 established, now applied per-slice rather than per-loader.
 *
 * Never imports `@sveltejs/kit` — no HTTP status codes in this layer.
 */

import type { AppDb } from '$lib/server/db';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { projectForActor, type SessionProjection } from '$lib/engine/session/projection';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import { readChallengeState, tenureIdForUser } from '$lib/engine/session/procedures/challenge/reducer';
import { buildChallengeModifierMaterials, legalChallengeCommands, type ChallengeCommand } from '$lib/engine/session/procedures/challenge/command';
import { projectChallengeForActor, type ChallengeProjection } from '$lib/engine/session/procedures/challenge/projection';
import type { ChallengeModifierDerivationCaps } from '$lib/engine/session/procedures/challenge/modifiers';
import { NO_EQUIPMENT, resolveChallengeEquipmentCaps } from '$lib/server/campaign/challenge-equipment';
import {
	legalGuidedTestCommands,
	projectGuidedTestForActor,
	type GuidedTestControl,
	type GuidedTestProjection
} from '$lib/engine/session/procedures/guided-test-projection';
import { legalCampCommands, projectCampForActor, type CampControl, type CampProjection } from '$lib/engine/session/procedures/camp-projection';
import { buildCampConfig } from '$lib/engine/session/procedures/camp';
import { legalFiniteCommands, projectFiniteForActor, type FiniteControl, type FiniteProjection } from '$lib/engine/session/procedures/finite-projection';
import { loadCampMaterials, loadGuidedTestMaterials } from './guided-test-materials';
import {
	campaignCursor,
	loadSessionForReduce,
	loadSessionSummary,
	SessionLoadIntegrityError,
	SessionNotFoundError,
	type LoadedSession
} from './repository';
import type { SessionActor, SessionEngineStateV1, SessionProjectionEnvelope } from '$lib/types/session';

export interface TableProjections {
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	challengeProjection: ChallengeProjection | null;
	/** Computed independent of whether a round is active —
	 * `challengeProjection` is `null` before one exists, but the GM still needs a
	 * server-computed answer to "may I begin one?" */
	challengeLegalCommands: ChallengeCommand['type'][];
	guidedTestProjection: GuidedTestProjection | null;
	/** Likewise present before any test exists, so the GM's "call for a test"
	 * control renders from the server's answer rather than a client guess. */
	guidedTestLegalCommands: GuidedTestControl[];
	campProjection: CampProjection | null;
	/** Likewise present before any Camp procedure exists, so an adventurer's
	 * "Perform the High Chant" / "Apply leeches" controls render from the
	 * server's answer. */
	campLegalCommands: CampControl[];
	finiteProjection: FiniteProjection | null;
	/** The finite runner's legal set — present before any procedure exists. */
	finiteLegalCommands: FiniteControl[];
	/**
	 * Why `projection` is null, when it is. `'not-found'` means there is no such
	 * session *for this caller* — genuinely absent, or belonging to another
	 * campaign (deliberately conflated, so this never confirms the existence of a
	 * session outside the requested campaign). `'unloadable'` means the session
	 * EXISTS and is open but cannot be projected: pinned content that no longer
	 * satisfies today's schema, a fragment at the wrong version, a corrupt
	 * payload.
	 *
	 * The distinction is not cosmetic. Callers that see one indistinguishable
	 * `projection: null` for both render "no session is open" over a session that
	 * is very much open — leaving the GM a "Start session" button whose action can
	 * only ever refuse, since the unloadable session still holds the campaign's
	 * one open-session slot.
	 */
	loadFailure: 'not-found' | 'unloadable' | null;
}

const EMPTY: Omit<TableProjections, 'loadFailure'> = {
	projection: null,
	challengeProjection: null,
	challengeLegalCommands: [],
	guidedTestProjection: null,
	guidedTestLegalCommands: [],
	campProjection: null,
	campLegalCommands: [],
	finiteProjection: null,
	finiteLegalCommands: []
};

/** Resolves the Challenge-relevant equipment caps for `actor` against `state`:
 * a player's own tenure (if they hold one in the active round), or
 * `NO_EQUIPMENT` for the GM/a non-participant — never fabricated, always the
 * tenure's real persisted equipment. */
async function resolveEquipmentCapsFor(db: AppDb, state: SessionEngineStateV1, actor: SessionActor) {
	if (actor.kind !== 'player') return NO_EQUIPMENT;
	const challenge = readChallengeState(state);
	if (!challenge) return NO_EQUIPMENT;
	const tenureId = tenureIdForUser(challenge, actor.userId);
	if (!tenureId) return NO_EQUIPMENT;
	return resolveChallengeEquipmentCaps(db, tenureId);
}

function modifierCapsFrom(materials: ReturnType<typeof buildChallengeModifierMaterials>): ChallengeModifierDerivationCaps {
	return {
		counselMaxUsesPerRound: materials.counsel.maxUsesPerRound,
		guardianAngelMaxInstances: materials.guardianAngel.maxInstances,
		hasBow: materials.hasBow,
		hasShield: materials.hasShield
	};
}

export async function loadTableProjectionsForActor(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	actor: SessionActor,
	/**
	 * The campaign cursor, when the caller has already read it for this request.
	 * `sync/+server.ts` always has — it reads the cursor to decide whether there
	 * is anything to send at all, and this function would otherwise read the same
	 * `max(id)` a second time on every changed poll. One redundant round trip is
	 * ~80ms on a non-co-located Worker (docs/operations/campaign-capacity.md).
	 *
	 * Pass only a cursor read in the SAME request. Omit it and the authoritative
	 * read below still happens, which is what every other caller does.
	 */
	knownCampaignCursor?: number
): Promise<TableProjections> {
	// Ownership decided from the cheap summary read FIRST, ahead of the full load
	// (which parses every fragment and so can fail for reasons of its own): an
	// out-of-campaign caller always gets a flat 'not-found', never an
	// 'unloadable' that would confirm the session id exists somewhere.
	const summary = await loadSessionSummary(db, sessionId);
	if (!summary || summary.campaignId !== campaignId) return { ...EMPTY, loadFailure: 'not-found' };

	let loaded: LoadedSession;
	try {
		loaded = await loadSessionForReduce(db, sessionId);
	} catch (cause) {
		if (cause instanceof SessionNotFoundError) return { ...EMPTY, loadFailure: 'not-found' };
		// Integrity failures are the one class of failure an operator most needs
		// to see: they never resolve on their own and leave the campaign wedged.
		// Logged (not persisted, not shown to the client) because the message
		// carries schema paths, not secrets.
		if (cause instanceof SessionLoadIntegrityError) {
			console.error(`[table] session ${sessionId} is unloadable: ${cause.message}`);
		} else {
			console.error('[table] unexpected error loading session for projections', cause);
		}
		return { ...EMPTY, loadFailure: 'unloadable' };
	}

	// The session must belong to the REQUESTED campaign. A GM of campaign A
	// holding a session id from campaign B would otherwise receive B's full
	// generic AND per-procedure state. 'not-found', not 'unloadable': the caller
	// is outside this session's campaign and must not learn that it exists.
	if (loaded.campaignId !== campaignId) return { ...EMPTY, loadFailure: 'not-found' };

	const runtime = toSessionEngineRuntime(loaded.runtimeContent);

	let projection: SessionProjectionEnvelope<SessionProjection> | null;
	try {
		const built = projectForActor(loaded.engineState, actor, runtime.catalog);
		const cursor = knownCampaignCursor ?? (await campaignCursor(db, campaignId));
		projection = { campaignCursor: cursor, sessionVersion: loaded.currentVersion, projection: built };
	} catch (cause) {
		console.error('[table] unexpected error building generic projection', cause);
		projection = null;
	}

	let challengeProjection: ChallengeProjection | null = null;
	let challengeLegalCommands: ChallengeCommand['type'][] = [];
	try {
		const config = buildChallengeConfig(loaded.runtimeContent.procedures, loaded.runtimeContent.formulas);
		const equipment = await resolveEquipmentCapsFor(db, loaded.engineState, actor);
		const materials = buildChallengeModifierMaterials(loaded.runtimeContent.modifiers, equipment);
		const modifierCaps = modifierCapsFrom(materials);
		challengeProjection = projectChallengeForActor(loaded.engineState, actor, runtime.catalog, config, modifierCaps);
		challengeLegalCommands = legalChallengeCommands(loaded.engineState, actor, config, modifierCaps);
	} catch (cause) {
		console.error('[table] unexpected error building Challenge projection slice', cause);
		challengeProjection = null;
		challengeLegalCommands = [];
	}

	let guidedTestProjection: GuidedTestProjection | null = null;
	let guidedTestLegalCommands: GuidedTestControl[] = [];
	try {
		const materials = await loadGuidedTestMaterials(db, campaignId);
		guidedTestProjection = projectGuidedTestForActor(loaded.engineState, actor, runtime.catalog, materials);
		guidedTestLegalCommands = legalGuidedTestCommands(loaded.engineState, actor, materials);
	} catch (cause) {
		console.error('[table] unexpected error building guided-test projection slice', cause);
		guidedTestProjection = null;
		guidedTestLegalCommands = [];
	}

	// A generic projection that failed to build is the same fact as a session
	// that failed to load, as far as any caller is concerned: the session is
	// there and cannot be shown.
	let campProjection: CampProjection | null = null;
	let campLegalCommands: CampControl[] = [];
	try {
		const materials = await loadCampMaterials(db, campaignId);
		const config = buildCampConfig(loaded.runtimeContent.procedures, loaded.runtimeContent.formulas, loaded.runtimeContent.modifiers);
		campProjection = projectCampForActor(loaded.engineState, actor, runtime.catalog, materials, config);
		campLegalCommands = legalCampCommands(loaded.engineState, actor, materials, config);
	} catch (cause) {
		console.error('[table] unexpected error building Camp projection slice', cause);
		campProjection = null;
		campLegalCommands = [];
	}

	let finiteProjection: FiniteProjection | null = null;
	let finiteLegalCommands: FiniteControl[] = [];
	try {
		const materials = await loadCampMaterials(db, campaignId);
		finiteProjection = projectFiniteForActor(loaded.engineState, actor, runtime.catalog, materials, loaded.runtimeContent.procedures);
		finiteLegalCommands = legalFiniteCommands(loaded.engineState, actor, materials, loaded.runtimeContent.procedures);
	} catch (cause) {
		console.error('[table] unexpected error building finite projection slice', cause);
		finiteProjection = null;
		finiteLegalCommands = [];
	}

	return {
		projection,
		challengeProjection,
		challengeLegalCommands,
		guidedTestProjection,
		guidedTestLegalCommands,
		campProjection,
		campLegalCommands,
		finiteProjection,
		finiteLegalCommands,
		loadFailure: projection ? null : 'unloadable'
	};
}
