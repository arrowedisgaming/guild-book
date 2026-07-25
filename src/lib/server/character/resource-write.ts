/**
 * Increment 4 Task 1: the ONLY character mutation a session command may cause.
 *
 * Spending Resolve for favor is a pre-draw purchase (global constraint: "Resolve-
 * for-favor is an explicit pre-draw purchase. Pushing remains free"), so it has
 * to touch the character sheet from inside the session write path. That is a
 * genuinely dangerous shape — the sheet is edited concurrently by its owner on a
 * different screen — so this module deliberately makes it the narrowest write in
 * the app:
 *
 * - It NEVER accepts a character document. The intent carries two numbers and a
 *   reason; the document is always reread here.
 * - It changes exactly one field, `resolve.current`, on a freshly-migrated copy
 *   of whatever is currently stored. Every other field is carried through by
 *   spread, so a concurrent notes/equipment edit is preserved rather than
 *   clobbered by a stale client snapshot.
 * - `expectedCharacterVersion` is ADVISORY. A version that moved for an
 *   unrelated reason is not a conflict — the reread simply reapplies against the
 *   newer version. Only `expectedResolveCurrent` is a hard precondition, because
 *   only Resolve drift means the player is about to buy something they did not
 *   agree to buy.
 * - A `resource-changed` refusal writes nothing at all: no version claim, no
 *   session command row, no draw. The UI must ask the player again with the
 *   current numbers (Step 3's reconfirmation contract).
 *
 * `buildResolveIntentStatements` is separated from `applyResolveIntent` for the
 * same reason `buildChallengeDeathStatements` is: a caller can splice the
 * statements into a LARGER atomic unit (the accepted session command's own
 * batch), and the failure-injection tests can corrupt any one statement and
 * prove the whole batch rolls back.
 */

import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppDb } from '$lib/server/db';
import type { AppDbContext, AtomicStatement } from '$lib/server/db/atomic';
import {
	mutationClaimReceipt,
	runCampaignAtomic,
	type CampaignAtomicStatement
} from '$lib/server/campaign/atomic';
import {
	campaignAdventurerTenures,
	campaignMutationClaims,
	characterVersionClaims,
	characters
} from '$lib/server/db/schema';
import { migrateCharacterData } from '$lib/engine/character-migration';
import type { GuildBookCharacterData } from '$lib/types/character';

/** How many times a commit that lost an unrelated version race is retried
 * before giving up. Matches `command-service.ts`'s nonstructural budget. */
const MAX_ATTEMPTS = 4;

export interface ResolveIntent {
	campaignId: string;
	sessionId: string;
	/** The spending adventurer's character. Always the actor's own. */
	characterId: string;
	actorUserId: string;
	/** Advisory — see the module comment. Never a hard precondition. */
	expectedCharacterVersion: number;
	/** The hard precondition: the Resolve the player agreed to spend from. */
	expectedResolveCurrent: number;
	/** Only ±1 today; the rulebook has no larger single Resolve movement in
	 * session, and a wider delta would need its own reconfirmation wording. */
	delta: -1 | 1;
	/** Audit label for the version claim's `mutation_kind` payload. */
	reason: string;
	now?: Date;
}

export type ResolveIntentResult =
	| { ok: true; version: number; resolveCurrent: number }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'not-authorized' }
	| { ok: false; reason: 'insufficient-resolve'; currentResolve: number; currentVersion: number }
	| { ok: false; reason: 'resource-changed'; currentResolve: number; currentVersion: number }
	| { ok: false; reason: 'retry-exhausted' };

/** Every way a spend can be refused — the read phase's whole return surface
 * apart from success, kept separate so a `{ ok: true }` from the read is never
 * confused with a `{ ok: true }` from the commit. */
export type ResolveIntentFailure = Extract<ResolveIntentResult, { ok: false }>;

export interface ResolveWriteContext {
	characterId: string;
	ownerUserId: string;
	currentVersion: number;
	currentResolve: number;
	nextResolve: number;
	nextData: GuildBookCharacterData;
}

/**
 * Reads the current document, applies every precondition, and returns the
 * context a statement build needs — or the typed refusal. Reads only; nothing
 * here mutates. Split out so `executeCommand` can evaluate the whole intent
 * BEFORE it reduces the session, and refuse without having drawn a card.
 */
export async function readResolveWriteContext(
	db: AppDb,
	intent: ResolveIntent
): Promise<{ ok: true; context: ResolveWriteContext } | ResolveIntentFailure> {
	const row = await db
		.select({
			ownerUserId: characters.userId,
			version: characters.version,
			data: characters.data,
			lifeStatus: characters.lifeStatus
		})
		.from(characters)
		.where(eq(characters.id, intent.characterId))
		.get();

	if (!row) return { ok: false, reason: 'not-found' };
	if (row.ownerUserId !== intent.actorUserId) return { ok: false, reason: 'not-authorized' };
	// A dead adventurer buys nothing. Reported as `not-found` rather than a
	// distinct code for the same reason `readChallengeDeathContext` does: the
	// caller has no separate branch for it, and the session UI has already
	// removed the participant.
	if (row.lifeStatus !== 'alive') return { ok: false, reason: 'not-found' };

	const liveTenure = await db
		.select({ id: campaignAdventurerTenures.id })
		.from(campaignAdventurerTenures)
		.where(
			and(
				eq(campaignAdventurerTenures.characterId, intent.characterId),
				eq(campaignAdventurerTenures.campaignId, intent.campaignId),
				isNull(campaignAdventurerTenures.endedAt)
			)
		)
		.get();
	if (!liveTenure) return { ok: false, reason: 'not-found' };

	const currentData = parseCharacterData(row.data);
	const currentResolve = currentData.resolve.current;

	// The hard precondition. Checked BEFORE the affordability check so a player
	// whose Resolve was spent elsewhere is told "it changed" (reconfirm), not
	// "you cannot afford it" (a dead end that hides why).
	if (currentResolve !== intent.expectedResolveCurrent) {
		return { ok: false, reason: 'resource-changed', currentResolve, currentVersion: row.version };
	}

	const nextResolve = currentResolve + intent.delta;
	if (nextResolve < 0 || nextResolve > currentData.resolve.max) {
		return { ok: false, reason: 'insufficient-resolve', currentResolve, currentVersion: row.version };
	}

	// The one field this module is allowed to change.
	const nextData: GuildBookCharacterData = {
		...currentData,
		resolve: { ...currentData.resolve, current: nextResolve }
	};

	return {
		ok: true,
		context: {
			characterId: intent.characterId,
			ownerUserId: row.ownerUserId,
			currentVersion: row.version,
			currentResolve,
			nextResolve,
			nextData
		}
	};
}

/**
 * The conditional claim proving, at commit time, that the character is STILL at
 * the version this write read AND still holds exactly the Resolve the player
 * agreed to spend from. `json_extract` on the stored document is what makes the
 * resource itself part of the claim rather than a read-then-write check: a
 * concurrent spend that lands between the read above and this commit fails the
 * claim, so the last statement's FK receipt fails and the whole batch aborts.
 * Mirrors `challengeDeathClaimStatement`'s INSERT...SELECT...WHERE shape.
 */
export function resolveClaimStatement(
	db: AppDb,
	input: {
		claimId: string;
		campaignId: string;
		characterId: string;
		ownerUserId: string;
		actorUserId: string;
		expectedVersion: number;
		expectedResolveCurrent: number;
		now: Date;
	}
): CampaignAtomicStatement {
	return db.insert(campaignMutationClaims).select(
		db
			.select({
				id: sql<string>`${input.claimId}`.as('id'),
				campaignId: sql<string>`${input.campaignId}`.as('campaign_id'),
				characterId: characters.id,
				kind: sql<string>`${'session.resolve'}`.as('kind'),
				actorUserId: sql<string>`${input.actorUserId}`.as('actor_user_id'),
				createdAt: sql<Date>`${Math.floor(input.now.getTime() / 1000)}`.as('created_at')
			})
			.from(characters)
			.where(
				and(
					eq(characters.id, input.characterId),
					eq(characters.userId, input.ownerUserId),
					eq(characters.version, input.expectedVersion),
					eq(characters.lifeStatus, 'alive'),
					sql`json_extract(${characters.data}, '$.resolve.current') = ${input.expectedResolveCurrent}`,
					exists(
						db
							.select({ id: campaignAdventurerTenures.id })
							.from(campaignAdventurerTenures)
							.where(
								and(
									eq(campaignAdventurerTenures.characterId, input.characterId),
									eq(campaignAdventurerTenures.campaignId, input.campaignId),
									isNull(campaignAdventurerTenures.endedAt)
								)
							)
					)
				)
			)
	);
}

/**
 * The character half of a Resolve spend: conditional claim, version-claim
 * record, the narrow document/version update, and the FK-dependent receipt.
 * A caller commits these ALONE (`applyResolveIntent`) or splices them into an
 * accepted session command's batch so the spend and the draw it paid for are
 * one indivisible write.
 */
export function buildResolveIntentStatements(
	db: AppDb,
	intent: ResolveIntent,
	context: ResolveWriteContext
): CampaignAtomicStatement[] {
	const now = intent.now ?? new Date();
	const claimId = nanoid();
	const resultingVersion = context.currentVersion + 1;

	return [
		resolveClaimStatement(db, {
			claimId,
			campaignId: intent.campaignId,
			characterId: intent.characterId,
			ownerUserId: context.ownerUserId,
			actorUserId: intent.actorUserId,
			expectedVersion: context.currentVersion,
			expectedResolveCurrent: context.currentResolve,
			now
		}),
		db.insert(characterVersionClaims).values({
			characterId: intent.characterId,
			resultingVersion,
			mutationKind: 'session-resolve',
			actorUserId: intent.actorUserId,
			createdAt: now
		}),
		db
			.update(characters)
			.set({ data: JSON.stringify(context.nextData), version: resultingVersion, updatedAt: now })
			.where(
				and(
					eq(characters.id, intent.characterId),
					eq(characters.userId, context.ownerUserId),
					eq(characters.version, context.currentVersion)
				)
			),
		mutationClaimReceipt(db, claimId)
	];
}

/**
 * Commits a Resolve spend on its own. Retries a commit that lost an UNRELATED
 * version race (the reread finds the same Resolve at a newer version) up to
 * `MAX_ATTEMPTS`; a Resolve that actually moved is never retried — it is
 * refused so the player can reconfirm.
 */
export async function applyResolveIntent(
	dbContext: AppDbContext,
	intent: ResolveIntent
): Promise<ResolveIntentResult> {
	const db = dbContext.db as unknown as AppDb;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const read = await readResolveWriteContext(db, intent);
		if (!read.ok) return read;

		const statements = buildResolveIntentStatements(db, intent, read.context);
		try {
			await runCampaignAtomic(db, statements);
		} catch {
			// Lost a race between the read and this commit. Loop: the next
			// reread either finds the same Resolve at a newer version (retry) or
			// finds Resolve itself moved (refuse, above).
			continue;
		}

		return {
			ok: true,
			version: read.context.currentVersion + 1,
			resolveCurrent: read.context.nextResolve
		};
	}

	return { ok: false, reason: 'retry-exhausted' };
}

/**
 * The character the actor is currently playing in this campaign — the only one
 * a session command may ever spend from. A player has at most one live tenure
 * at a time (Increment 1's membership invariant), so this is unambiguous;
 * `null` means the actor has no adventurer at the table and cannot buy favor.
 */
export async function readActorSpendingCharacterId(
	db: AppDb,
	campaignId: string,
	actorUserId: string
): Promise<string | null> {
	const row = await db
		.select({ characterId: campaignAdventurerTenures.characterId })
		.from(campaignAdventurerTenures)
		.innerJoin(characters, eq(characters.id, campaignAdventurerTenures.characterId))
		.where(
			and(
				eq(campaignAdventurerTenures.campaignId, campaignId),
				isNull(campaignAdventurerTenures.endedAt),
				eq(characters.userId, actorUserId),
				eq(characters.lifeStatus, 'alive')
			)
		)
		.get();
	return row?.characterId ?? null;
}

/**
 * Renders the Drizzle statements above into the `{ sql, params }` shape
 * `$lib/server/db/atomic.ts`'s `runAtomic` executes, so a Resolve spend can be
 * spliced into an accepted session command's batch and commit as ONE unit.
 *
 * This is the reverse of the bridge `command-service.ts`'s Challenge-death path
 * had to build (it re-expressed session fragments as Drizzle statements to join
 * `runCampaignAtomic`). Going this direction is strictly better where it works:
 * `buildAcceptedCommandStatements` needs read-your-own-writes inside the
 * transaction for its campaign-event ids, which the Drizzle batch shape cannot
 * express, whereas these four statements have no such need — Drizzle already
 * knows how to render them, and `toSQL()` applies the same column mappers the
 * driver would (timestamps arrive as epoch seconds, not `Date`s).
 */
export function toAtomicStatements(statements: CampaignAtomicStatement[]): AtomicStatement[] {
	return statements.map((statement) => {
		const { sql: text, params } = (
			statement as unknown as { toSQL(): { sql: string; params: unknown[] } }
		).toSQL();
		return { sql: text, params };
	});
}

function parseCharacterData(json: string): GuildBookCharacterData {
	try {
		return migrateCharacterData(JSON.parse(json));
	} catch {
		return migrateCharacterData(null);
	}
}
