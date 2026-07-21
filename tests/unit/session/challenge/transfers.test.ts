import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig } from '$lib/engine/session/procedures/challenge/types';
import {
	beginChallenge,
	challengeHandZoneId,
	cleanupRound,
	readChallengeState,
	type ChallengeReduceContext
} from '$lib/engine/session/procedures/challenge/reducer';
import { dealRound } from '$lib/engine/session/procedures/challenge/deal';
import { placeInitiative, revealInitiative } from '$lib/engine/session/procedures/challenge/initiative';
import { counselTransfer, CHALLENGE_COUNSEL_ID } from '$lib/engine/session/procedures/challenge/transfers';
import { findModifierParams } from '$lib/engine/session/procedures/challenge/modifiers';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { projectForActor } from '$lib/engine/session/projection';
import { makeRng } from '$lib/engine/rng';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, SessionGmProjection, SessionPlayerProjection, TarotCardCatalog } from '$lib/types/session';
import type { CounselTransferParams } from '$lib/types/content-pack';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };

const TENURE_OWNERS: Record<string, string> = {
	'tenure-1': 'user-alice',
	'tenure-2': 'user-bob',
	'tenure-3': 'user-carol'
};

function playerActor(tenureId: string): SessionActor {
	const owner = TENURE_OWNERS[tenureId];
	if (!owner) throw new Error(`no owner fixture registered for ${tenureId}`);
	return { kind: 'player', userId: owner };
}

function ctxFor(actor: SessionActor, catalog: TarotCardCatalog, config: ChallengeConfig, seed: string): ChallengeReduceContext {
	return { actor, runtime: { catalog }, rng: makeRng(seed), config };
}

function expectConserved(state: SessionEngineStateV1, catalog: TarotCardCatalog): void {
	expect(() => assertSessionInvariants(state, catalog)).not.toThrow();
}

function forceHand(state: SessionEngineStateV1, tenureId: string, cardIds: CardId[]): SessionEngineStateV1 {
	const zoneId = challengeHandZoneId(tenureId);
	const zone = findZoneDescriptor(state, zoneId);
	if (!zone) throw new Error(`forceHand: unknown zone ${zoneId}`);

	let playerDraw = state.playerDraw.concat(zone.cards);
	let privateZones = state.privateZones.map((z) => (z.id === zoneId ? { ...z, cards: [] } : z));

	for (const cardId of cardIds) {
		if (playerDraw.includes(cardId)) {
			playerDraw = playerDraw.filter((id) => id !== cardId);
		} else {
			privateZones = privateZones.map((z) => ({ ...z, cards: z.cards.filter((id) => id !== cardId) }));
		}
	}

	const targetIndex = privateZones.findIndex((z) => z.id === zoneId);
	privateZones[targetIndex] = { ...privateZones[targetIndex], cards: cardIds.slice() };

	return { ...state, playerDraw, privateZones };
}

describe('Counsel — private-transfer (Increment 3 Task 4)', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas, modifiers } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);
	const counselParams = findModifierParams<CounselTransferParams>(modifiers, CHALLENGE_COUNSEL_ID, 'private-transfer');

	/** Three participants, dealt hands, any-time-during-Challenge (Counsel's
	 * own `timing` — no turns/Initiative needed to exercise it). tenure-3 is
	 * the deliberately UNINVOLVED third party for the canary test. */
	function dealtThreePlayer(seed: string) {
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(
			state,
			{ participantTenureIds: ['tenure-1', 'tenure-2', 'tenure-3'], tenureOwners: TENURE_OWNERS, enemyFacts: [] },
			gmCtx
		);
		if (!begun.ok) throw begun;
		const dealResult = dealRound(begun.state, gmCtx);
		if (!dealResult.ok) throw dealResult;
		return { state: dealResult.state, gmCtx };
	}

	it('transfers an owned private card to an authorized recipient without public identity (Step 1)', () => {
		const { state } = dealtThreePlayer('counsel-basic');
		const forced = forceHand(state, 'tenure-1', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);
		const senderCtx = ctxFor(playerActor('tenure-1'), catalog, config, 'counsel-basic');

		const result = counselTransfer(forced, TENURE_OWNERS['tenure-2'], 'swords-vii', counselParams, senderCtx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(findZoneDescriptor(result.state, challengeHandZoneId('tenure-1'))?.cards).not.toContain('swords-vii');
		expect(findZoneDescriptor(result.state, challengeHandZoneId('tenure-2'))?.cards).toContain('swords-vii');

		expect(result.events).toHaveLength(1);
		const event = result.events[0];
		expect(event.kind).toBe('challenge-counsel-transferred');
		// Public transfer event: sender/recipient/count/reason ONLY (O3) —
		// never card identity.
		expect(event.publicPayload).toEqual({
			senderTenureId: 'tenure-1',
			recipientTenureId: 'tenure-2',
			count: 1,
			reason: 'counsel'
		});
		expect(JSON.stringify(event.publicPayload)).not.toContain('swords-vii');

		// Sender and recipient each get the minimum secret payload; the GM
		// never appears as a party (this helper only ever moves player-owned
		// private zones — see `transfers.ts`'s file header).
		expect(event.privatePayloads?.[TENURE_OWNERS['tenure-1']]).toMatchObject({ cardId: 'swords-vii', direction: 'sent' });
		expect(event.privatePayloads?.[TENURE_OWNERS['tenure-2']]).toMatchObject({ cardId: 'swords-vii', direction: 'received' });
		expect(event.privatePayloads?.[GM.userId]).toBeUndefined();

		expectConserved(result.state, catalog);
	});

	it('transfer canary: the card identity is visible only to sender/recipient — never the GM, never an uninvolved third player', () => {
		const { state } = dealtThreePlayer('counsel-canary');
		const forced = forceHand(state, 'tenure-1', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);
		const senderCtx = ctxFor(playerActor('tenure-1'), catalog, config, 'counsel-canary');

		const result = counselTransfer(forced, TENURE_OWNERS['tenure-2'], 'swords-vii', counselParams, senderCtx);
		if (!result.ok) throw result;

		const senderProjection = projectForActor(result.state, playerActor('tenure-1'), catalog) as SessionPlayerProjection;
		const recipientProjection = projectForActor(result.state, playerActor('tenure-2'), catalog) as SessionPlayerProjection;
		const uninvolvedProjection = projectForActor(result.state, playerActor('tenure-3'), catalog) as SessionPlayerProjection;
		const gmProjection = projectForActor(result.state, GM, catalog) as SessionGmProjection;

		expect(recipientProjection.privateHand.some((slot) => !slot.hidden && slot.id === 'swords-vii')).toBe(true);
		expect(senderProjection.privateHand.some((slot) => !slot.hidden && slot.id === 'swords-vii')).toBe(false);
		expect(JSON.stringify(uninvolvedProjection)).not.toContain('swords-vii');
		expect(JSON.stringify(gmProjection)).not.toContain('swords-vii');
	});

	it('enforces maxUsesPerRound (content, not a fabricated number) — the second Counsel use this round is rejected', () => {
		const { state } = dealtThreePlayer('counsel-cap');
		const forced = forceHand(state, 'tenure-1', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);
		const senderCtx = ctxFor(playerActor('tenure-1'), catalog, config, 'counsel-cap');

		const first = counselTransfer(forced, TENURE_OWNERS['tenure-2'], 'swords-vii', counselParams, senderCtx);
		if (!first.ok) throw first;
		expect(counselParams.maxUsesPerRound).toBe(1);

		const second = counselTransfer(first.state, TENURE_OWNERS['tenure-3'], 'cups-ii', counselParams, senderCtx);
		expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('already been used') } });
	});

	it('rejects a non-player actor distinctly from the cap guard (test discrimination)', () => {
		const { state, gmCtx } = dealtThreePlayer('counsel-not-player');
		const forced = forceHand(state, 'tenure-1', ['swords-vii']);
		const result = counselTransfer(forced, TENURE_OWNERS['tenure-2'], 'swords-vii', counselParams, gmCtx);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('rejects counseling a user who is not an active participant', () => {
		const { state } = dealtThreePlayer('counsel-not-participant');
		const forced = forceHand(state, 'tenure-1', ['swords-vii']);
		const senderCtx = ctxFor(playerActor('tenure-1'), catalog, config, 'counsel-not-participant');
		const result = counselTransfer(forced, 'user-not-in-this-challenge', 'swords-vii', counselParams, senderCtx);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects counseling yourself', () => {
		const { state } = dealtThreePlayer('counsel-self');
		const forced = forceHand(state, 'tenure-1', ['swords-vii']);
		const senderCtx = ctxFor(playerActor('tenure-1'), catalog, config, 'counsel-self');
		const result = counselTransfer(forced, TENURE_OWNERS['tenure-1'], 'swords-vii', counselParams, senderCtx);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('yourself') } });
	});

	it('rejects transferring a card the sender does not actually hold', () => {
		const { state } = dealtThreePlayer('counsel-no-card');
		const senderCtx = ctxFor(playerActor('tenure-1'), catalog, config, 'counsel-no-card');
		const senderHand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
		const notHeld = ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv', 'swords-king'].find((id) => !senderHand.cards.includes(id))!;

		const result = counselTransfer(state, TENURE_OWNERS['tenure-2'], notHeld, counselParams, senderCtx);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('does not hold') } });
	});

	it("the per-round cap resets at cleanup (Counsel's instance is `resolved`, not carried forward)", () => {
		const { state, gmCtx } = dealtThreePlayer('counsel-cleanup-reset');
		// A spare Initiative card ('wands-iii') distinct from the counseled
		// card, so placing Initiative afterward doesn't collide with it.
		const forced = forceHand(state, 'tenure-1', ['wands-iii', 'swords-vii']);
		const senderCtx = ctxFor(playerActor('tenure-1'), catalog, config, 'counsel-cleanup-reset');

		const first = counselTransfer(forced, TENURE_OWNERS['tenure-2'], 'swords-vii', counselParams, senderCtx);
		if (!first.ok) throw first;
		expect(readChallengeState(first.state)?.modifiers).toHaveLength(1);

		// `cleanupRound` only accepts stage `'initiative-reveal'` or later —
		// complete Initiative placement/reveal for every participant first.
		const p1 = placeInitiative(first.state, 'tenure-1', 'wands-iii', senderCtx);
		if (!p1.ok) throw p1;
		const tenure2Ctx = ctxFor(playerActor('tenure-2'), catalog, config, 'counsel-cleanup-reset');
		const hand2CardId = findZoneDescriptor(p1.state, challengeHandZoneId('tenure-2'))!.cards[0];
		const p2 = placeInitiative(p1.state, 'tenure-2', hand2CardId, tenure2Ctx);
		if (!p2.ok) throw p2;
		const tenure3Ctx = ctxFor(playerActor('tenure-3'), catalog, config, 'counsel-cleanup-reset');
		const hand3CardId = findZoneDescriptor(p2.state, challengeHandZoneId('tenure-3'))!.cards[0];
		const p3 = placeInitiative(p2.state, 'tenure-3', hand3CardId, tenure3Ctx);
		if (!p3.ok) throw p3;
		const revealed = revealInitiative(p3.state, gmCtx);
		if (!revealed.ok) throw revealed;

		const cleaned = cleanupRound(revealed.state, gmCtx);
		expect(cleaned.ok).toBe(true);
		if (!cleaned.ok) return;
		expect(readChallengeState(cleaned.state)?.modifiers).toEqual([]);
	});
});
