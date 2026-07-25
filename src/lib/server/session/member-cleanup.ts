/**
 * Active-session member cleanup (Increment 4 Task 6) — ONE service used by
 * both departure paths. `leaveCampaign` and `removeCampaignMember` already
 * accept a `SessionStatePort`/`SessionCleanupPort` pair and commit whatever
 * the cleanup port returns in the SAME atomic batch as the membership
 * revocation and tenure end; Increment 2 stubbed those ports
 * (`noSessionsYet`). This module supplies the live implementations, following
 * the Challenge-death bridge exactly (session fragments re-expressed as
 * Drizzle statements so they join `runCampaignAtomic`, and the next session
 * version claimed through the same `session_commands` serialization index as
 * every other version-advancing write).
 *
 * What the batch contains when a session is open: the session version claim,
 * updated public/server fragments, updated private fragments for every
 * REMAINING recipient, DELETION of the departed user's private-state row and
 * of every event secret addressed to them, the sanitized count-only public
 * event, tenure end, and membership revocation — all or nothing. An injected
 * failure in any statement leaves original access and state intact.
 *
 * There is deliberately no auto-expiry and no silent force-delete fallback:
 * a batch that keeps losing races keeps failing loudly.
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AppDb } from '$lib/server/db';
import { isUniqueConstraintError } from '$lib/server/db/atomic';
import { leaveCampaign, removeCampaignMember, type MembershipDepartureResult } from '$lib/server/campaign/membership';
import { campaignEvents, campaignEventSecrets, campaignMembers, playSessions, sessionPrivateStates, sessionServerStates } from '$lib/server/db/schema';
import type { CampaignAtomicStatement } from '$lib/server/campaign/atomic';
import type { SessionCleanupInput, SessionCleanupPort, SessionStatePort } from '$lib/server/campaign/session-state-port';
import { makeRng } from '$lib/engine/rng';
import { removeParticipantFromSession } from '$lib/engine/session/member-removal';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { sha256Hex } from '$lib/server/content/canonical-json';
import { sessionVersionClaimStatement } from './command-service';
import { loadSessionForReduce, splitEngineState, type LoadedSession } from './repository';
import type { SessionEngineStateV1 } from '$lib/types/session';

/** The live `SessionStatePort`: an `active` OR `frozen` session occupies the
 * campaign's open slot (a frozen session still holds private state — Task 6
 * Step 3's archive boundary names both). */
export function livePlaySessionStatePort(db: AppDb): SessionStatePort {
	return {
		async activeSessionId(campaignId: string): Promise<string | null> {
			const row = await db
				.select({ id: playSessions.id })
				.from(playSessions)
				.where(and(eq(playSessions.campaignId, campaignId), inArray(playSessions.status, ['active', 'frozen'])))
				.get();
			return row?.id ?? null;
		},
		claimGuard(campaignId: string, activeSessionId: string | null): SQL {
			// Proves, AT CLAIM TIME, that the observed session state still holds:
			// either no open session exists, or the one we built cleanup for is
			// still the open one. A session that opened/closed between the read
			// and the commit fails the claim and rolls the whole batch back.
			if (activeSessionId === null) {
				return sql`NOT EXISTS (SELECT 1 FROM play_sessions WHERE campaign_id = ${campaignId} AND status IN ('active','frozen'))`;
			}
			return sql`EXISTS (SELECT 1 FROM play_sessions WHERE id = ${activeSessionId} AND campaign_id = ${campaignId} AND status IN ('active','frozen'))`;
		}
	};
}

export interface MemberCleanupIntent {
	campaignId: string;
	membershipId: string;
	actorUserId: string;
	reason: 'left' | 'removed';
}

/**
 * The live `SessionCleanupPort`. Builds the session half of a departure batch
 * from a FRESH load — called once per departure attempt, so a retry rebuilds
 * against current state rather than replaying stale fragments.
 */
export function sessionMemberCleanupPort(): SessionCleanupPort {
	return {
		async statements(db: AppDb, input: SessionCleanupInput): Promise<CampaignAtomicStatement[]> {
			// Death has its own, separately-wired path (`buildChallengeDeathStatements`).
			if (input.kind === 'death') return [];
			const departingUser = await db
				.select({ userId: campaignMembers.userId })
				.from(campaignMembers)
				.where(eq(campaignMembers.id, input.membershipId))
				.get();
			/* v8 ignore next -- departCampaign resolved the membership just before */
			if (!departingUser) return [];

			const loaded: LoadedSession = await loadSessionForReduce(db, input.sessionId);
			const now = new Date();
			const runtime = toSessionEngineRuntime(loaded.runtimeContent);

			const removal = removeParticipantFromSession(
				loaded.engineState,
				{
					membershipId: input.membershipId,
					userId: departingUser.userId,
					tenureIds: input.tenureId ? [input.tenureId] : [],
					reason: input.kind === 'remove' ? 'removed' : 'left'
				},
				makeRng(sha256Hex(`${loaded.shuffleSeed}:cleanup:${loaded.currentVersion}:${input.membershipId}`)),
				runtime.catalog
			);

			const nextVersion = loaded.currentVersion + 1;
			const finalState: SessionEngineStateV1 = { ...removal.state, version: nextVersion };
			// The departed user is no longer a recipient: their private-state row
			// is DELETED below, not updated to empty — an empty row would still
			// admit them to the recipient set on the next load.
			const remainingRecipients = loaded.recipientUserIds.filter((userId) => userId !== departingUser.userId);
			const { publicFragment, serverFragment, privateFragmentsByRecipient } = splitEngineState(
				finalState,
				loaded.shuffleSeed,
				loaded.gmUserId,
				remainingRecipients
			);

			const statements: CampaignAtomicStatement[] = [
				sessionVersionClaimStatement(db, {
					sessionId: input.sessionId,
					actorUserId: input.actorUserId,
					commandType: 'member-cleanup',
					expectedVersion: loaded.currentVersion,
					now
				}),
				db
					.update(playSessions)
					.set({
						version: nextVersion,
						phase: finalState.phase,
						procedureId: finalState.procedure?.procedureId ?? null,
						publicStateJson: JSON.stringify(publicFragment)
					})
					.where(and(eq(playSessions.id, input.sessionId), eq(playSessions.version, loaded.currentVersion))),
				db
					.update(sessionServerStates)
					.set({ sessionVersion: nextVersion, serverStateJson: JSON.stringify(serverFragment), updatedAt: now })
					.where(and(eq(sessionServerStates.sessionId, input.sessionId), eq(sessionServerStates.sessionVersion, loaded.currentVersion)))
			];

			for (const [recipientUserId, fragment] of privateFragmentsByRecipient) {
				statements.push(
					db
						.update(sessionPrivateStates)
						.set({ sessionVersion: nextVersion, privateStateJson: JSON.stringify(fragment), updatedAt: now })
						.where(
							and(
								eq(sessionPrivateStates.sessionId, input.sessionId),
								eq(sessionPrivateStates.recipientUserId, recipientUserId),
								eq(sessionPrivateStates.sessionVersion, loaded.currentVersion)
							)
						)
				);
			}

			statements.push(
				// Private-secret deletion: the departed user's own fragment row and
				// every event secret ever addressed to them in this session. Their
				// subsequent projection request is a flat 404, with nothing left to
				// serve even if it were not.
				db
					.delete(sessionPrivateStates)
					.where(and(eq(sessionPrivateStates.sessionId, input.sessionId), eq(sessionPrivateStates.recipientUserId, departingUser.userId))),
				db
					.delete(campaignEventSecrets)
					.where(
						and(
							eq(campaignEventSecrets.recipientUserId, departingUser.userId),
							sql`${campaignEventSecrets.eventId} IN (SELECT id FROM campaign_events WHERE session_id = ${input.sessionId})`
						)
					)
			);

			for (const event of removal.events) {
				statements.push(
					db.insert(campaignEvents).values({
						campaignId: input.campaignId,
						membershipId: input.membershipId,
						...(input.tenureId ? { tenureId: input.tenureId } : {}),
						sessionId: input.sessionId,
						actorUserId: input.actorUserId,
						kind: event.kind,
						publicPayloadJson: JSON.stringify(event.publicPayload),
						createdAt: now
					})
				);
			}

			return statements;
		}
	};
}

/** The ports bundle both departure routes pass — one definition, so leave and
 * removal can never wire different cleanup behavior. */
export function departurePorts(db: AppDb): { sessionState: SessionStatePort; sessionCleanup: SessionCleanupPort } {
	return { sessionState: livePlaySessionStatePort(db), sessionCleanup: sessionMemberCleanupPort() };
}

const MAX_ATTEMPTS = 4;

/**
 * Departure with cleanup, retried on a lost NONSTRUCTURAL race (another table
 * command claimed the session version between our fresh load and the commit).
 * Each attempt rebuilds the cleanup statements from a fresh load; a changed
 * membership context is a hard 'conflict', never retried.
 */
export async function leaveCampaignWithCleanup(
	db: AppDb,
	input: { campaignId: string; membershipId: string; userId: string; now?: Date }
): Promise<MembershipDepartureResult> {
	return retryDeparture(() => leaveCampaign(db, input, departurePorts(db)));
}

export async function removeCampaignMemberWithCleanup(
	db: AppDb,
	input: { campaignId: string; membershipId: string; ownerUserId: string; now?: Date }
): Promise<MembershipDepartureResult> {
	return retryDeparture(() => removeCampaignMember(db, input, departurePorts(db)));
}

async function retryDeparture(attemptOnce: () => Promise<MembershipDepartureResult>): Promise<MembershipDepartureResult> {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			return await attemptOnce();
		} catch (cause) {
			// departCampaign rethrows a commit failure whose membership context is
			// UNCHANGED — for us that is a session version race, retryable with
			// freshly rebuilt statements. Anything else propagates.
			if (!isUniqueConstraintError(cause) || attempt === MAX_ATTEMPTS) throw cause;
		}
	}
	/* v8 ignore next -- unreachable: the loop returns or throws */
	throw new Error('retryDeparture: exhausted');
}
