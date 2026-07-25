/**
 * Increment 4 Task 2 Step 1 — the guided individual test of fate.
 *
 * These tests pin the stage machine (declare -> favor -> initial-draw ->
 * push-offer -> complete), the authorization split (the GM declares the
 * fictional test; the acting player confirms Resolve and pushes), and the two
 * facts the engine must read from SERVER-supplied materials rather than the
 * command: the tested attribute's current value and the actor's current
 * Resolve.
 *
 * The nesting test is the load-bearing one: Ch7 p.120's Test Fate action says
 * "the GM can call for a test of fate mid-Challenge", so a guided test must be
 * legal while `state.procedure` still holds `challenge-round`.
 */

import { describe, expect, it } from 'vitest';
import { getContentPack, getTarotProcedures } from '$lib/server/content/loader';
import { makeRng } from '$lib/engine/rng';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import {
	completeGuidedTest,
	declareTestOfFate,
	declineTestPush,
	drawTestCard,
	guidedTestZoneId,
	purchaseTestFavorWithResolve,
	readGuidedTest,
	setTestFavor,
	pushTestFate,
	TEST_OF_FATE_PROCEDURE_ID,
	type GuidedTestMaterials,
	type GuidedTestReduceContext
} from '$lib/engine/session/procedures/test-of-fate';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };
const BOB: SessionActor = { kind: 'player', userId: 'user-bob' };

const CATALOG: TarotCardCatalog = makeRichSessionCatalogFixture();

/** Deliberately distinct from the user ids, so a test that only passed by
 * conflating tenure and user cannot silently keep passing. */
const MATERIALS: GuidedTestMaterials = {
	actors: [
		{
			tenureId: 'tenure-1',
			characterId: 'char-alice',
			userId: 'user-alice',
			attributes: { swords: 4, pentacles: 2, cups: 2, wands: 1 },
			resolveCurrent: 3,
			rosterOrder: 0
		},
		{
			tenureId: 'tenure-2',
			characterId: 'char-bob',
			userId: 'user-bob',
			attributes: { swords: 1, pentacles: 1, cups: 1, wands: 1 },
			resolveCurrent: 0,
			rosterOrder: 1
		}
	]
};

/** The real `test-of-fate` definition from the content pack — its steps'
 * `reshuffle` rule is what drives the Fool boundary, so a fabricated stub
 * would prove nothing. */
const PROCEDURE = (() => {
	const found = getTarotProcedures().procedures.find((p) => p.id === TEST_OF_FATE_PROCEDURE_ID);
	if (!found) throw new Error('content pack is missing the test-of-fate procedure');
	return found;
})();

function ctxFor(actor: SessionActor, seed = 'test-of-fate', materials: GuidedTestMaterials = MATERIALS): GuidedTestReduceContext {
	return {
		actor,
		runtime: { catalog: CATALOG },
		rng: makeRng(seed),
		config: getContentPack().tarot,
		materials,
		procedure: PROCEDURE
	};
}

/** Forces `cardIds` to the top of the minor draw pile, in order, so a test can
 * pin an exact total instead of depending on the shuffle. */
function withTopOfPlayerDraw(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const rest = state.playerDraw.filter((id) => !cardIds.includes(id));
	return { ...state, playerDraw: [...cardIds, ...rest] };
}

function unwrap(result: ReturnType<typeof declareTestOfFate>): SessionEngineStateV1 {
	if (!result.ok) throw new Error(`expected ok, got rejection: ${result.rejection.code} ${result.rejection.message}`);
	return result.state;
}

/** Walks declare -> favor -> initial-draw, leaving the test ready to draw. */
function readyToDraw(
	options: { favor?: boolean; disfavor?: boolean; top?: CardId[]; seed?: string } = {}
): SessionEngineStateV1 {
	let state = makeSessionFixture(options.seed ?? 'test-of-fate');
	if (options.top) state = withTopOfPlayerDraw(state, options.top);
	state = unwrap(declareTestOfFate(state, { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));
	state = unwrap(setTestFavor(state, { favor: options.favor ?? false, disfavor: options.disfavor ?? false }, ctxFor(GM)));
	return state;
}

describe('guided test of fate — stage machine', () => {
	it('the GM declares the tested actor and suit, opening the favor stage', () => {
		const state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));

		expect(readGuidedTest(state)).toMatchObject({
			schemaVersion: 1,
			stage: 'favor',
			actorTenureId: 'tenure-1',
			testedSuit: 'swords',
			favor: false,
			disfavor: false,
			resolvePurchase: null,
			result: null
		});
	});

	it('a player may not declare a test of fate', () => {
		const result = declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(ALICE));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('declaring a test for a tenure that is not at the table is rejected', () => {
		const result = declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-absent', testedSuit: 'swords' }, ctxFor(GM));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('a second declaration while a test is in flight is rejected', () => {
		const state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));

		const result = declareTestOfFate(state, { actorTenureId: 'tenure-2', testedSuit: 'cups' }, ctxFor(GM));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('settling favor opens the initial-draw stage', () => {
		const state = readyToDraw({ favor: true });

		expect(readGuidedTest(state)).toMatchObject({ stage: 'initial-draw', favor: true, disfavor: false });
	});

	it('drawing before favor is settled is rejected', () => {
		const state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));

		expect(drawTestCard(state, ctxFor(ALICE))).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});
});

describe('guided test of fate — resolution reads server-side facts', () => {
	it('totals the SERVER-read attribute with the drawn card and classifies a great success', () => {
		// Alice's swords is 4 (materials); swords-x is worth 10. 4 + 10 = 14 on the
		// tested suit's own initial draw, with no push -> great success.
		const state = unwrap(drawTestCard(readyToDraw({ top: ['swords-x'] }), ctxFor(ALICE)));

		expect(readGuidedTest(state)).toMatchObject({
			stage: 'complete',
			result: { total: 14, outcome: 'great-success', pushed: false, canPush: false }
		});
	});

	it('a failing initial draw offers the free push instead of completing', () => {
		// 4 + 3 = 7, well under the threshold of 14.
		const state = unwrap(drawTestCard(readyToDraw({ top: ['cups-iii'] }), ctxFor(ALICE)));

		expect(readGuidedTest(state)).toMatchObject({
			stage: 'push-offer',
			result: { total: 7, outcome: 'failure', canPush: true }
		});
	});

	it('the drawn card lands face-up in the actor’s public test zone', () => {
		const state = unwrap(drawTestCard(readyToDraw({ top: ['swords-x'] }), ctxFor(ALICE)));

		const zone = findZoneDescriptor(state, guidedTestZoneId('tenure-1', 'initial'));
		expect(zone?.cards).toEqual(['swords-x']);
		expect(zone?.visibility).toBe('public');
	});

	it('only the acting player may draw for their own test', () => {
		const state = readyToDraw({ top: ['swords-x'] });

		expect(drawTestCard(state, ctxFor(BOB))).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('applies the content pack’s favor modifier rather than a hardcoded +3', () => {
		// 4 + 7 = 11 (a failure) becomes 14 with favor's +3 from the pack.
		const state = unwrap(drawTestCard(readyToDraw({ favor: true, top: ['cups-vii'] }), ctxFor(ALICE)));

		expect(readGuidedTest(state)).toMatchObject({ result: { total: 14, modifier: 3, outcome: 'success' } });
	});

	it('records that favor came from Resolve and reports the spend for the atomic write', () => {
		let state = readyToDraw();
		const purchased = purchaseTestFavorWithResolve(state, ctxFor(ALICE));
		state = unwrap(purchased);

		expect(readGuidedTest(state)).toMatchObject({
			resolvePurchase: { characterId: 'char-alice', spent: 1 }
		});
	});

	it('refuses a Resolve purchase the actor cannot afford', () => {
		let state = makeSessionFixture();
		state = unwrap(declareTestOfFate(state, { actorTenureId: 'tenure-2', testedSuit: 'cups' }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));

		// Bob's `resolveCurrent` is 0 in the materials.
		expect(purchaseTestFavorWithResolve(state, ctxFor(BOB))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});

	it('a Resolve purchase after the draw is rejected — favor is a pre-draw purchase', () => {
		const state = unwrap(drawTestCard(readyToDraw({ top: ['cups-iii'] }), ctxFor(ALICE)));

		expect(purchaseTestFavorWithResolve(state, ctxFor(ALICE))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});
});

describe('guided test of fate — pushing', () => {
	it('a push adds a second card and can never great-succeed', () => {
		let state = unwrap(drawTestCard(readyToDraw({ top: ['swords-iii', 'swords-x'] }), ctxFor(ALICE)));
		expect(readGuidedTest(state)?.stage).toBe('push-offer');

		state = unwrap(pushTestFate(state, ctxFor(ALICE)));

		// 4 + 3 + 10 = 17: a success off an initial tested-suit card, but pushed.
		expect(readGuidedTest(state)).toMatchObject({
			stage: 'complete',
			result: { total: 17, outcome: 'success', pushed: true }
		});
	});

	it('pushing into a still-failing total is a great failure', () => {
		let state = unwrap(drawTestCard(readyToDraw({ top: ['cups-ii', 'cups-iii'] }), ctxFor(ALICE)));
		state = unwrap(pushTestFate(state, ctxFor(ALICE)));

		expect(readGuidedTest(state)).toMatchObject({ result: { total: 9, outcome: 'great-failure', pushed: true } });
	});

	it('declining the push completes the test on the original failure', () => {
		let state = unwrap(drawTestCard(readyToDraw({ top: ['cups-iii'] }), ctxFor(ALICE)));
		state = unwrap(declineTestPush(state, ctxFor(ALICE)));

		expect(readGuidedTest(state)).toMatchObject({ stage: 'complete', result: { outcome: 'failure', pushed: false } });
	});

	it('a push is not offered after a success', () => {
		const state = unwrap(drawTestCard(readyToDraw({ top: ['swords-x'] }), ctxFor(ALICE)));

		expect(pushTestFate(state, ctxFor(ALICE))).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});
});

describe('guided test of fate — completion', () => {
	it('completing clears the slot and discards the test’s cards', () => {
		const drawn = unwrap(drawTestCard(readyToDraw({ top: ['swords-x'] }), ctxFor(ALICE)));

		const state = unwrap(completeGuidedTest(drawn, ctxFor(GM)));

		expect(readGuidedTest(state)).toBeUndefined();
		expect(state.playerDiscard).toContain('swords-x');
		expect(findZoneDescriptor(state, guidedTestZoneId('tenure-1', 'initial'))).toBeUndefined();
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('completing an unresolved test is rejected', () => {
		const state = readyToDraw();

		expect(completeGuidedTest(state, ctxFor(GM))).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('a Fool drawn in the test reshuffles both decks at the test’s own boundary', () => {
		// The Fool is worth 0, so this is a failure with the free push still on
		// offer; declining it is what resolves the test.
		let drawn = unwrap(drawTestCard(readyToDraw({ top: ['fool'] }), ctxFor(ALICE)));
		expect(readGuidedTest(drawn)?.result).toMatchObject({ foolDrawn: true });
		drawn = unwrap(declineTestPush(drawn, ctxFor(ALICE)));

		const state = unwrap(completeGuidedTest(drawn, ctxFor(GM)));

		// `test-of-fate`'s reshuffle rule has boundary `test-resolution`, not
		// `end-round`, so the flags must be consumed here rather than left
		// pending for a later `end-round`.
		expect(state.reshuffleAtBoundary).toEqual({ major: false, player: false });
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('leaves a host procedure’s own pending Fool reshuffle scheduled', () => {
		const base = makeSessionFixture();
		const hosted: SessionEngineStateV1 = {
			...withTopOfPlayerDraw(base, ['swords-x']),
			procedure: { procedureId: 'challenge-round', stepIndex: 3, pendingZoneIds: [] },
			reshuffleAtBoundary: { major: true, player: true }
		};
		let state = unwrap(declareTestOfFate(hosted, { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(drawTestCard(state, ctxFor(ALICE)));

		state = unwrap(completeGuidedTest(state, ctxFor(GM)));

		// The test itself drew no Fool, so the Challenge's pending end-round
		// reshuffle must survive untouched.
		expect(state.reshuffleAtBoundary).toEqual({ major: true, player: true });
	});
});

describe('guided test of fate — nesting inside a host procedure', () => {
	it('is legal while challenge-round still occupies the procedure slot (Ch7 p.120 Test Fate)', () => {
		const hosted: SessionEngineStateV1 = {
			...makeSessionFixture(),
			procedure: { procedureId: 'challenge-round', stepIndex: 3, pendingZoneIds: [] }
		};

		const state = unwrap(declareTestOfFate(hosted, { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));

		expect(readGuidedTest(state)?.stage).toBe('favor');
		// The host procedure is untouched — the test is a peer, not an occupant.
		expect(state.procedure).toEqual({ procedureId: 'challenge-round', stepIndex: 3, pendingZoneIds: [] });
	});
});
