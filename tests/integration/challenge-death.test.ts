/**
 * Increment 3 Task 5: death and legal replacement joins.
 *
 * Marking a participating adventurer dead must, in ONE mutation, claim the
 * character version, update life JSON/status, end the tenure, redact the
 * dying tenure's owned Challenge zones, update participant state, emit
 * public death/cleanup events, and free membership eligibility (brief O4).
 * A replacement attached WHILE a Challenge round is active must not
 * participate until round cleanup admits it (O3).
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import * as schema from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import type { AppDbContext, AtomicStatement } from '$lib/server/db/atomic';
import { runAtomic } from '$lib/server/db/atomic';
import { runCampaignAtomic, type CampaignAtomicStatement } from '$lib/server/campaign/atomic';
import { createBlankCharacter } from '$lib/types/character';
import { attachAdventurer } from '$lib/server/campaign/tenure';
import { markCharacterDead } from '$lib/server/character/life';
import { startSession } from '$lib/server/session/lifecycle';
import {
	buildAcceptedCommandStatements,
	loadSessionForReduce
} from '$lib/server/session/repository';
import {
	buildChallengeDeathStatements,
	buildPendingChallengeJoinStatements,
	challengeSessionStatePort,
	executeChallengeDeath
} from '$lib/server/session/command-service';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import {
	beginChallenge,
	challengeHandZoneId,
	cleanupRound,
	readChallengeState,
	type ChallengeReduceContext,
	type SessionReduceResult
} from '$lib/engine/session/procedures/challenge/reducer';
import { dealRound } from '$lib/engine/session/procedures/challenge/deal';
import { placeInitiative, revealInitiative } from '$lib/engine/session/procedures/challenge/initiative';
import { beginTurns } from '$lib/engine/session/procedures/challenge/turns';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { projectForActor } from '$lib/engine/session/projection';
import { makeRng } from '$lib/engine/rng';
import type { SessionActor, SessionEngineStateV1 } from '$lib/types/session';

const GM_USER = 'gm-a';
const PLAYER_A = 'player-a';
const PLAYER_B = 'player-b';

describe('challenge death — atomic mutation and card conservation', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;
	let db: AppDb;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
		db = ctx.db as unknown as AppDb;
	});

	afterEach(() => sqlite.close());

	/** Seeds campaign-a with a GM and two players, each with one finalized
	 * character attached as a tenure — the minimum a Challenge round needs. */
	async function seedTwoParticipants(): Promise<{ tenureA: string; tenureB: string }> {
		seedUsersAndCampaign(sqlite, [GM_USER, PLAYER_A, PLAYER_B]);
		seedMembership(sqlite, 'membership-a', PLAYER_A);
		seedMembership(sqlite, 'membership-b', PLAYER_B);
		seedCharacter(sqlite, 'character-a', PLAYER_A);
		seedCharacter(sqlite, 'character-b', PLAYER_B);

		const attachA = await attachAdventurer(db, {
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			actorUserId: PLAYER_A,
			characterId: 'character-a',
			tenureId: 'tenure-a',
			now: new Date(150_000)
		});
		if (!attachA.ok) throw new Error('fixture: attach A failed');
		const attachB = await attachAdventurer(db, {
			campaignId: 'campaign-a',
			membershipId: 'membership-b',
			actorUserId: PLAYER_B,
			characterId: 'character-b',
			tenureId: 'tenure-b',
			now: new Date(150_000)
		});
		if (!attachB.ok) throw new Error('fixture: attach B failed');
		return { tenureA: attachA.tenureId, tenureB: attachB.tenureId };
	}

	async function beginAndDeal(sessionId: string, participantTenureIds: string[], tenureOwners: Record<string, string>): Promise<void> {
		await applyChallengeStep(ctx, sessionId, 'campaign-a', 'challenge-begin', (state, context) =>
			beginChallenge(state, { participantTenureIds, tenureOwners, enemyFacts: [] }, context)
		);
		await applyChallengeStep(ctx, sessionId, 'campaign-a', 'challenge-deal', (state, context) => dealRound(state, context));
	}

	it('atomically claims the character version, ends life, ends the tenure, redacts the Challenge hand, removes the participant, and emits public events — in ONE mutation', async () => {
		const { tenureA, tenureB } = await seedTwoParticipants();
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, sessionId: 'session-a', shuffleSeed: 'death-seed', now: new Date(200_000) });
		if (!started.ok) throw new Error('fixture: session failed to start');

		await beginAndDeal('session-a', [tenureA, tenureB], { [tenureA]: PLAYER_A, [tenureB]: PLAYER_B });

		const beforeDeath = await loadSessionForReduce(db, 'session-a');
		const handABefore = findZoneDescriptor(beforeDeath.engineState, challengeHandZoneId(tenureA))!.cards.slice();
		expect(handABefore.length).toBeGreaterThan(0);
		const handBBefore = findZoneDescriptor(beforeDeath.engineState, challengeHandZoneId(tenureB))!.cards.slice();

		const outcome = await executeChallengeDeath({
			db,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			tenureId: tenureA,
			actorUserId: GM_USER,
			now: new Date(210_000)
		});
		expect(outcome).toEqual({ ok: true, sessionVersion: beforeDeath.currentVersion + 1, characterVersion: 2, endedTenureId: tenureA });

		// Character: version claimed, life JSON/status updated.
		const character = sqlite.prepare('SELECT data, version, life_status FROM characters WHERE id = ?').get('character-a') as {
			data: string;
			version: number;
			life_status: string;
		};
		expect(character.version).toBe(2);
		expect(character.life_status).toBe('dead');
		expect(JSON.parse(character.data).life).toEqual({
			status: 'dead',
			diedAt: new Date(210_000).toISOString(),
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			markedByUserId: GM_USER
		});
		expect(
			sqlite
				.prepare('SELECT mutation_kind, resulting_version FROM character_version_claims WHERE character_id = ? ORDER BY resulting_version')
				.all('character-a')
		).toEqual([
			{ mutation_kind: 'create', resulting_version: 1 },
			{ mutation_kind: 'death', resulting_version: 2 }
		]);

		// Tenure ended.
		expect(
			sqlite.prepare('SELECT end_reason, death_session_id FROM campaign_adventurer_tenures WHERE id = ?').get(tenureA)
		).toEqual({ end_reason: 'died', death_session_id: 'session-a' });

		// Membership eligibility freed: no active tenure remains for membership-a.
		expect(
			sqlite.prepare('SELECT count(*) AS n FROM campaign_adventurer_tenures WHERE membership_id = ? AND ended_at IS NULL').get('membership-a')
		).toEqual({ n: 0 });

		// Session-engine redaction: hand zone gone, participant removed, sibling untouched.
		const after = await loadSessionForReduce(db, 'session-a');
		expect(findZoneDescriptor(after.engineState, challengeHandZoneId(tenureA))).toBeUndefined();
		expect(readChallengeState(after.engineState)!.participantTenureIds).toEqual([tenureB]);
		expect(findZoneDescriptor(after.engineState, challengeHandZoneId(tenureB))!.cards).toEqual(handBBefore);

		// Card conservation: every dealt card is now in the discard pile, not vanished.
		for (const cardId of handABefore) {
			expect(after.engineState.playerDiscard).toContain(cardId);
		}
		const catalog = toSessionEngineRuntime(after.runtimeContent).catalog;
		expect(() => assertSessionInvariants(after.engineState, catalog)).not.toThrow();

		// Public events: adventurer.died (campaign-level) AND the engine's own
		// public challenge-participant-died event, both recorded.
		const events = sqlite
			.prepare('SELECT kind, public_payload_json FROM campaign_events WHERE campaign_id = ? ORDER BY id')
			.all('campaign-a') as Array<{ kind: string; public_payload_json: string }>;
		expect(events.map((e) => e.kind)).toContain('adventurer.died');
		expect(events.map((e) => e.kind)).toContain('challenge-participant-died');
		const diedEvent = events.find((e) => e.kind === 'challenge-participant-died')!;
		expect(JSON.parse(diedEvent.public_payload_json)).toEqual({ tenureId: tenureA, round: 1 });

		// Player A's own projection no longer shows any hand from the dead
		// tenure; player B's is unaffected.
		const projectionA = projectForActor(after.engineState, { kind: 'player', userId: PLAYER_A }, catalog);
		expect('privateHand' in projectionA ? projectionA.privateHand : []).toEqual([]);
	});

	it('rejects death for a tenure that is not an active Challenge participant, and touches nothing', async () => {
		const { tenureA, tenureB } = await seedTwoParticipants();
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, sessionId: 'session-a', shuffleSeed: 'reject-seed', now: new Date(200_000) });
		if (!started.ok) throw new Error('fixture: session failed to start');
		await beginAndDeal('session-a', [tenureB], { [tenureB]: PLAYER_B });

		const outcome = await executeChallengeDeath({
			db,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			tenureId: tenureA,
			actorUserId: GM_USER,
			now: new Date(210_000)
		});
		expect(outcome).toMatchObject({ ok: false, reason: 'illegal-command' });
		expect(sqlite.prepare('SELECT version, life_status FROM characters WHERE id = ?').get('character-a')).toEqual({
			version: 1,
			life_status: 'alive'
		});
	});

	it('rejects a player marking a different tenure\'s owner dead — not-authorized, no partial write', async () => {
		const { tenureA, tenureB } = await seedTwoParticipants();
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, sessionId: 'session-a', shuffleSeed: 'auth-seed', now: new Date(200_000) });
		if (!started.ok) throw new Error('fixture: session failed to start');
		await beginAndDeal('session-a', [tenureA, tenureB], { [tenureA]: PLAYER_A, [tenureB]: PLAYER_B });

		const outcome = await executeChallengeDeath({
			db,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			tenureId: tenureA,
			actorUserId: PLAYER_B,
			now: new Date(210_000)
		});
		expect(outcome).toMatchObject({ ok: false, reason: 'not-authorized' });
		expect(sqlite.prepare('SELECT version, life_status FROM characters WHERE id = ?').get('character-a')).toEqual({
			version: 1,
			life_status: 'alive'
		});
	});

	// Discrimination (O6): could this rejection pass with the active-turn
	// guard deleted from `markTenureDead`? No — a DIFFERENT, non-active
	// tenure is marked dead successfully in the exact same state.
	it('rejects marking the currently-active-turn tenure dead, but a non-active sibling in the same state succeeds', async () => {
		const { tenureA, tenureB } = await seedTwoParticipants();
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, sessionId: 'session-a', shuffleSeed: 'active-turn-seed', now: new Date(200_000) });
		if (!started.ok) throw new Error('fixture: session failed to start');
		await beginAndDeal('session-a', [tenureA, tenureB], { [tenureA]: PLAYER_A, [tenureB]: PLAYER_B });

		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-place-a', (state, context) => {
			const hand = findZoneDescriptor(state, challengeHandZoneId(tenureA))!;
			return placeInitiative(state, tenureA, hand.cards[0], { ...context, actor: { kind: 'player', userId: PLAYER_A } });
		});
		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-place-b', (state, context) => {
			const hand = findZoneDescriptor(state, challengeHandZoneId(tenureB))!;
			return placeInitiative(state, tenureB, hand.cards[0], { ...context, actor: { kind: 'player', userId: PLAYER_B } });
		});
		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-reveal', (state, context) => revealInitiative(state, context));

		const loaded = await loadSessionForReduce(db, 'session-a');
		const challenge = readChallengeState(loaded.engineState)!;
		const activeTenureId = challenge.initiativeOrder[0].tenureId;
		const otherTenureId = activeTenureId === tenureA ? tenureB : tenureA;

		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-begin-turns', (state, context) => beginTurns(state, context));

		const activeOutcome = await executeChallengeDeath({
			db,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			tenureId: activeTenureId,
			actorUserId: GM_USER,
			now: new Date(210_000)
		});
		expect(activeOutcome).toMatchObject({ ok: false, reason: 'illegal-command' });

		const otherOutcome = await executeChallengeDeath({
			db,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			tenureId: otherTenureId,
			actorUserId: GM_USER,
			now: new Date(211_000)
		});
		expect(otherOutcome.ok).toBe(true);
	});

	it('replacement admitted during an active Challenge round joins pendingJoinTenureIds only — no hand until round cleanup admits it', async () => {
		const { tenureA, tenureB } = await seedTwoParticipants();
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, sessionId: 'session-a', shuffleSeed: 'join-seed', now: new Date(200_000) });
		if (!started.ok) throw new Error('fixture: session failed to start');
		await beginAndDeal('session-a', [tenureA, tenureB], { [tenureA]: PLAYER_A, [tenureB]: PLAYER_B });

		const death = await executeChallengeDeath({
			db,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			tenureId: tenureA,
			actorUserId: GM_USER,
			now: new Date(210_000)
		});
		expect(death.ok).toBe(true);

		// Player A attaches a replacement character — allowed mid-session ONLY
		// because tenure-a's own end reason is 'died' in THIS session
		// (tenure.ts's existing carve-out). Uses the REAL, DB-backed
		// `challengeSessionStatePort` (reviewer's ⚠️) rather than a stub port,
		// so `attachAdventurer`'s actual session-guard interaction with the
		// appended join statements is genuinely exercised, not just assumed.
		seedCharacter(sqlite, 'character-a2', PLAYER_A);
		const replacementAttach = await attachAdventurer(
			db,
			{
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				actorUserId: PLAYER_A,
				characterId: 'character-a2',
				tenureId: 'tenure-a2',
				now: new Date(220_000)
			},
			challengeSessionStatePort(db),
			buildPendingChallengeJoinStatements
		);
		expect(replacementAttach).toEqual({ ok: true, tenureId: 'tenure-a2' });

		// Pending, not participating: no hand zone, not in participantTenureIds.
		const afterJoin = await loadSessionForReduce(db, 'session-a');
		const challengeAfterJoin = readChallengeState(afterJoin.engineState)!;
		expect(challengeAfterJoin.pendingJoinTenureIds).toEqual(['tenure-a2']);
		expect(challengeAfterJoin.participantTenureIds).toEqual([tenureB]);
		expect(findZoneDescriptor(afterJoin.engineState, challengeHandZoneId('tenure-a2'))).toBeUndefined();

		// Advance to a legal cleanup boundary, then clean up — this is what
		// admits the pending join (Task 2's cleanupRound, composed with, not
		// reimplemented).
		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-place-b', (state, context) => {
			const hand = findZoneDescriptor(state, challengeHandZoneId(tenureB))!;
			return placeInitiative(state, tenureB, hand.cards[0], { ...context, actor: { kind: 'player', userId: PLAYER_B } });
		});
		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-reveal', (state, context) => revealInitiative(state, context));
		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-cleanup', (state, context) =>
			cleanupRound(state, context, { tenureOwners: { 'tenure-a2': PLAYER_A } })
		);

		const afterCleanup = await loadSessionForReduce(db, 'session-a');
		const challengeAfterCleanup = readChallengeState(afterCleanup.engineState)!;
		expect(challengeAfterCleanup.participantTenureIds).toEqual([tenureB, 'tenure-a2']);
		expect(challengeAfterCleanup.pendingJoinTenureIds).toEqual([]);
		// Still no hand dealt — dealing is a separate subsequent call, exactly
		// like every other round boundary.
		expect(findZoneDescriptor(afterCleanup.engineState, challengeHandZoneId('tenure-a2'))?.cards).toEqual([]);

		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-deal-2', (state, context) => dealRound(state, context));
		const afterDeal2 = await loadSessionForReduce(db, 'session-a');
		expect(findZoneDescriptor(afterDeal2.engineState, challengeHandZoneId('tenure-a2'))!.cards.length).toBeGreaterThan(0);

		// The replacement's projection is its OWN — never merged with the dead
		// tenure's redacted (now nonexistent) zone. Player A also still owns the
		// generic crawl-phase `hand:player-a` zone seeded at session start
		// (unrelated to Challenge, and empty) — the per-zone-id field (O2) must
		// distinguish it from the Challenge hand without merging either.
		const catalog = toSessionEngineRuntime(afterDeal2.runtimeContent).catalog;
		const replacementProjection = projectForActor(afterDeal2.engineState, { kind: 'player', userId: PLAYER_A }, catalog);
		if ('privateHandsByZoneId' in replacementProjection) {
			expect(Object.keys(replacementProjection.privateHandsByZoneId).sort()).toEqual(
				['hand:player-a', challengeHandZoneId('tenure-a2')].sort()
			);
			expect(replacementProjection.privateHandsByZoneId[challengeHandZoneId('tenure-a2')].length).toBeGreaterThan(0);
			expect(replacementProjection.privateHandsByZoneId['hand:player-a']).toEqual([]);
			expect(replacementProjection.privateHandsByZoneId[challengeHandZoneId('tenure-a')]).toBeUndefined();
		}
		expect(() => assertSessionInvariants(afterDeal2.engineState, catalog)).not.toThrow();
	});

	// Review Important 4: the generic out-of-session death path
	// (`life.ts`'s `markCharacterDead`) must refuse a tenure that is a
	// Challenge participant OR pending joiner — using it here would end the
	// tenure and mark the character dead while leaving `participantTenureIds`,
	// the hand zone, and the Initiative seat all intact.
	it('markCharacterDead (the generic out-of-session path) rejects a tenure that IS a live Challenge participant', async () => {
		const { tenureA, tenureB } = await seedTwoParticipants();
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, sessionId: 'session-a', shuffleSeed: 'life-guard-seed', now: new Date(200_000) });
		if (!started.ok) throw new Error('fixture: session failed to start');
		await beginAndDeal('session-a', [tenureA, tenureB], { [tenureA]: PLAYER_A, [tenureB]: PLAYER_B });

		const stubSessionState = { activeSessionId: async () => 'session-a', claimGuard: () => sql`1 = 1` };
		const result = await markCharacterDead(
			db,
			{ characterId: 'character-a', actorUserId: PLAYER_A, expectedVersion: 1, campaignId: 'campaign-a' },
			{ sessionState: stubSessionState, sessionCleanup: { statements: async () => [] } }
		);
		expect(result).toEqual({ ok: false, reason: 'is-challenge-participant' });

		// No partial write: character still alive, tenure still active, and
		// the Challenge engine state is completely untouched.
		expect(sqlite.prepare('SELECT version, life_status FROM characters WHERE id = ?').get('character-a')).toEqual({
			version: 1,
			life_status: 'alive'
		});
		expect(sqlite.prepare('SELECT ended_at FROM campaign_adventurer_tenures WHERE id = ?').get(tenureA)).toEqual({ ended_at: null });
		const after = await loadSessionForReduce(db, 'session-a');
		expect(readChallengeState(after.engineState)!.participantTenureIds).toEqual([tenureA, tenureB]);
	});

	it('markCharacterDead rejects a tenure that is only a PENDING Challenge joiner too', async () => {
		const { tenureA, tenureB } = await seedTwoParticipants();
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, sessionId: 'session-a', shuffleSeed: 'life-guard-pending-seed', now: new Date(200_000) });
		if (!started.ok) throw new Error('fixture: session failed to start');
		await beginAndDeal('session-a', [tenureA, tenureB], { [tenureA]: PLAYER_A, [tenureB]: PLAYER_B });

		const death = await executeChallengeDeath({ db, campaignId: 'campaign-a', sessionId: 'session-a', tenureId: tenureA, actorUserId: GM_USER, now: new Date(210_000) });
		expect(death.ok).toBe(true);

		// A replacement for tenure-a joins mid-Challenge — real attach flow,
		// same carve-out and real port as the earlier "replacement admitted"
		// test — landing PENDING (O3), not yet a full participant.
		seedCharacter(sqlite, 'character-a2', PLAYER_A);
		const pendingAttach = await attachAdventurer(
			db,
			{ campaignId: 'campaign-a', membershipId: 'membership-a', actorUserId: PLAYER_A, characterId: 'character-a2', tenureId: 'tenure-a2', now: new Date(220_000) },
			challengeSessionStatePort(db),
			buildPendingChallengeJoinStatements
		);
		expect(pendingAttach).toEqual({ ok: true, tenureId: 'tenure-a2' });
		const afterJoin = await loadSessionForReduce(db, 'session-a');
		expect(readChallengeState(afterJoin.engineState)!.pendingJoinTenureIds).toEqual(['tenure-a2']);

		const stubSessionState = { activeSessionId: async () => 'session-a', claimGuard: () => sql`1 = 1` };
		const result = await markCharacterDead(
			db,
			{ characterId: 'character-a2', actorUserId: PLAYER_A, expectedVersion: 1, campaignId: 'campaign-a' },
			{ sessionState: stubSessionState, sessionCleanup: { statements: async () => [] } }
		);
		expect(result).toEqual({ ok: false, reason: 'is-challenge-participant' });
		expect(sqlite.prepare('SELECT version, life_status FROM characters WHERE id = ?').get('character-a2')).toEqual({
			version: 1,
			life_status: 'alive'
		});
	});
});

describe('challenge death — atomicity failure-injection matrix (O4/O6)', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;
	let db: AppDb;

	beforeEach(async () => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
		db = ctx.db as unknown as AppDb;

		seedUsersAndCampaign(sqlite, [GM_USER, PLAYER_A, PLAYER_B]);
		seedMembership(sqlite, 'membership-a', PLAYER_A);
		seedMembership(sqlite, 'membership-b', PLAYER_B);
		seedCharacter(sqlite, 'character-a', PLAYER_A);
		seedCharacter(sqlite, 'character-b', PLAYER_B);
		await attachAdventurer(db, { campaignId: 'campaign-a', membershipId: 'membership-a', actorUserId: PLAYER_A, characterId: 'character-a', tenureId: 'tenure-a', now: new Date(150_000) });
		await attachAdventurer(db, { campaignId: 'campaign-a', membershipId: 'membership-b', actorUserId: PLAYER_B, characterId: 'character-b', tenureId: 'tenure-b', now: new Date(150_000) });
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, sessionId: 'session-a', shuffleSeed: 'atomic-seed', now: new Date(200_000) });
		if (!started.ok) throw new Error('fixture: session failed to start');

		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-begin', (state, context) =>
			beginChallenge(state, { participantTenureIds: ['tenure-a', 'tenure-b'], tenureOwners: { 'tenure-a': PLAYER_A, 'tenure-b': PLAYER_B }, enemyFacts: [] }, context)
		);
		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-deal', (state, context) => dealRound(state, context));
	});

	afterEach(() => sqlite.close());

	it('rolls back the ENTIRE death batch at every statement index — no partial death survives an injected failure anywhere', async () => {
		const built = await buildChallengeDeathStatements({
			db,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			tenureId: 'tenure-a',
			actorUserId: GM_USER,
			now: new Date(210_000)
		});
		if (!built.ok) throw new Error(`fixture: buildChallengeDeathStatements rejected: ${built.reason}`);
		expect(built.statements.length).toBeGreaterThanOrEqual(7);

		const snapshotBefore = fullSnapshot(sqlite);

		for (let i = 0; i < built.statements.length; i++) {
			await expect(runCampaignAtomic(db, corruptAt(built.statements, i))).rejects.toThrow();
			expect(fullSnapshot(sqlite)).toEqual(snapshotBefore);
		}

		// Sanity: the SAME (uncorrupted) statement list actually succeeds.
		await runCampaignAtomic(db, built.statements);
		expect(sqlite.prepare('SELECT life_status FROM characters WHERE id = ?').get('character-a')).toEqual({ life_status: 'dead' });
	});

	// Review Critical 1: a failure-injection matrix that only ever corrupts ONE
	// writer's OWN batch can never see a race between TWO writers — this is
	// exactly what let the missing `session_commands` claim through. These two
	// tests model a genuine second writer racing the death in both directions.
	it('a concurrent SessionCommand that commits FIRST makes a stale death fail outright — never silently overwritten (Critical 1)', async () => {
		// Read (but do not commit) the death from the PRE-race version.
		const staleDeath = await buildChallengeDeathStatements({
			db,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			tenureId: 'tenure-a',
			actorUserId: GM_USER,
			now: new Date(210_000)
		});
		if (!staleDeath.ok) throw new Error(`fixture: buildChallengeDeathStatements rejected: ${staleDeath.reason}`);

		// A real, ordinary Challenge command — a SECOND writer — commits FIRST,
		// claiming the very next version the stale death also targets.
		await applyChallengeStep(ctx, 'session-a', 'campaign-a', 'challenge-place-b', (state, context) => {
			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-b'))!;
			return placeInitiative(state, 'tenure-b', hand.cards[0], { ...context, actor: { kind: 'player', userId: PLAYER_B } });
		});

		// The stale death — built from a read that happened BEFORE that
		// command committed — must now fail outright (claim collision on the
		// version the command already claimed), never silently overwrite it.
		await expect(runCampaignAtomic(db, staleDeath.statements)).rejects.toThrow();

		// The command's effect survives; the death never applied to either
		// domain (session-engine OR character/tenure).
		const after = await loadSessionForReduce(db, 'session-a');
		const challenge = readChallengeState(after.engineState)!;
		expect(challenge.initiativeOrder.some((entry) => entry.tenureId === 'tenure-b')).toBe(true);
		expect(challenge.participantTenureIds).toEqual(['tenure-a', 'tenure-b']);
		expect(sqlite.prepare('SELECT life_status FROM characters WHERE id = ?').get('character-a')).toEqual({ life_status: 'alive' });
		expect(
			sqlite.prepare('SELECT ended_at FROM campaign_adventurer_tenures WHERE id = ?').get('tenure-a')
		).toEqual({ ended_at: null });
	});

	it('a death that commits FIRST makes a stale concurrent SessionCommand fail outright — never silently overwritten (Critical 1)', async () => {
		// Read (but do not commit) an ordinary command from the PRE-race
		// version — the SECOND writer, built stale on purpose.
		const staleCommandStatements = await buildChallengeStepStatements(ctx, 'session-a', 'campaign-a', 'challenge-place-b', (state, context) => {
			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-b'))!;
			return placeInitiative(state, 'tenure-b', hand.cards[0], { ...context, actor: { kind: 'player', userId: PLAYER_B } });
		});

		// The death commits first.
		const death = await executeChallengeDeath({
			db,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			tenureId: 'tenure-a',
			actorUserId: GM_USER,
			now: new Date(210_000)
		});
		expect(death.ok).toBe(true);

		// The stale command — built from a read before the death committed —
		// must now fail outright, never silently resurrect the pre-death
		// session state (the dead tenure's hand/participant slot) underneath
		// the death's own commit.
		await expect(runAtomic(ctx, staleCommandStatements)).rejects.toThrow();

		const after = await loadSessionForReduce(db, 'session-a');
		const challenge = readChallengeState(after.engineState)!;
		expect(challenge.participantTenureIds).toEqual(['tenure-b']);
		expect(challenge.initiativeOrder).toEqual([]); // the stale placement never landed
		expect(sqlite.prepare('SELECT life_status FROM characters WHERE id = ?').get('character-a')).toEqual({ life_status: 'dead' });
	});
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds (but does NOT run) the raw `AtomicStatement`s for one ordinary
 * Challenge reducer step, read fresh from `sessionId`'s CURRENT state —
 * factored out of `applyChallengeStep` so a racing-writer test (Critical 1)
 * can hold onto a "stale" statement list, let something else commit first,
 * and only then attempt it. */
async function buildChallengeStepStatements(
	ctx: AppDbContext,
	sessionId: string,
	campaignId: string,
	commandType: string,
	step: (state: SessionEngineStateV1, context: ChallengeReduceContext) => SessionReduceResult
): Promise<AtomicStatement[]> {
	const db = ctx.db as unknown as AppDb;
	const loaded = await loadSessionForReduce(db, sessionId);
	const { procedures, formulas } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);
	const actor: SessionActor = { kind: 'gm', userId: loaded.gmUserId };
	const context: ChallengeReduceContext = {
		actor,
		runtime: toSessionEngineRuntime(loaded.runtimeContent),
		rng: makeRng(`${commandType}-seed`),
		config
	};
	const result = step(loaded.engineState, context);
	if (!result.ok) throw new Error(`${commandType} rejected: ${result.rejection.code} ${result.rejection.message}`);
	const nextState = { ...result.state, version: loaded.currentVersion + 1 };
	return buildAcceptedCommandStatements({
		commandRowId: nanoid(),
		sessionId,
		campaignId,
		commandId: nanoid(),
		actorUserId: loaded.gmUserId,
		requestHash: nanoid(),
		commandType,
		clientObservedVersion: loaded.currentVersion,
		structuralPreconditionVersion: loaded.currentVersion,
		expectedVersion: loaded.currentVersion,
		nextState,
		events: result.events,
		shuffleSeed: loaded.shuffleSeed,
		gmUserId: loaded.gmUserId,
		recipientUserIds: loaded.recipientUserIds,
		now: new Date(),
		idFactory: () => nanoid()
	});
}

async function applyChallengeStep(
	ctx: AppDbContext,
	sessionId: string,
	campaignId: string,
	commandType: string,
	step: (state: SessionEngineStateV1, context: ChallengeReduceContext) => SessionReduceResult
): Promise<void> {
	const statements = await buildChallengeStepStatements(ctx, sessionId, campaignId, commandType, step);
	await runAtomic(ctx, statements);
}

function corruptAt(statements: readonly CampaignAtomicStatement[], index: number): CampaignAtomicStatement[] {
	return statements.map((statement, i) =>
		i === index
			? {
					run(): unknown {
						throw new Error('injected failure');
					}
				}
			: statement
	);
}

function fullSnapshot(sqlite: Database.Database): unknown {
	return {
		characters: sqlite.prepare('SELECT id, version, life_status, data FROM characters ORDER BY id').all(),
		tenures: sqlite.prepare('SELECT id, ended_at, end_reason, death_session_id FROM campaign_adventurer_tenures ORDER BY id').all(),
		versionClaims: sqlite.prepare('SELECT character_id, resulting_version, mutation_kind FROM character_version_claims ORDER BY id').all(),
		// Minor 7 (review): without this, a claim row that leaks past a
		// rolled-back batch (e.g. the conditional claim's SELECT matched but
		// something LATER in the same batch still failed) would be invisible
		// to the failure-injection matrix — a real partial-write mode this
		// snapshot must be able to see.
		mutationClaims: sqlite.prepare('SELECT id, campaign_id, character_id, kind FROM campaign_mutation_claims ORDER BY id').all(),
		mutationReceipts: sqlite.prepare('SELECT claim_id FROM campaign_mutation_receipts ORDER BY claim_id').all(),
		sessionCommandClaims: sqlite
			.prepare('SELECT session_id, command_type, resulting_version, status FROM session_commands ORDER BY id')
			.all(),
		playSessions: sqlite.prepare('SELECT id, version, public_state_json FROM play_sessions ORDER BY id').all(),
		serverStates: sqlite.prepare('SELECT session_id, session_version, server_state_json FROM session_server_states ORDER BY session_id').all(),
		privateStates: sqlite
			.prepare('SELECT session_id, recipient_user_id, session_version, private_state_json FROM session_private_states ORDER BY session_id, recipient_user_id')
			.all(),
		events: sqlite.prepare('SELECT campaign_id, kind, public_payload_json FROM campaign_events ORDER BY id').all()
	};
}

function seedUsersAndCampaign(sqlite: Database.Database, userIds: string[]): void {
	for (const userId of userIds) {
		sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
	}
	sqlite
		.prepare('INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run('campaign-a', GM_USER, 'The Lantern Guild', '', 100, 100);
}

function seedMembership(sqlite: Database.Database, membershipId: string, userId: string): void {
	sqlite
		.prepare('INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?)')
		.run(membershipId, 'campaign-a', userId, 100);
}

function seedCharacter(sqlite: Database.Database, characterId: string, userId: string): void {
	const character = createBlankCharacter();
	character.name = characterId;
	character.isDraft = false;
	sqlite
		.prepare(
			`INSERT INTO characters
			(id, user_id, name, data, version, life_status, is_draft, is_archived, created_at, updated_at)
			VALUES (?, ?, ?, ?, 1, 'alive', 0, 0, 100, 100)`
		)
		.run(characterId, userId, character.name, JSON.stringify(character));
	sqlite
		.prepare(
			`INSERT INTO character_version_claims
			(character_id, resulting_version, mutation_kind, actor_user_id, created_at)
			VALUES (?, 1, 'create', ?, 100)`
		)
		.run(characterId, userId);
}

function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
}
