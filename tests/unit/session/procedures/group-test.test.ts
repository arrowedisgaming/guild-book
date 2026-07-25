/**
 * Increment 4 Task 2 Steps 1/3 — the guided group test (Ch1 "Group tests").
 *
 * A group test is two COMPLETE tests of fate, so this module sequences the
 * individual guided test rather than reimplementing it: each subtest owns its
 * own favor/disfavor, its own Resolve decision, its own push, and its own card
 * zones. The two things genuinely new here are selection (most- and
 * least-qualified by the tested attribute, stable roster order as the
 * tie-break) and the hit total — both delegated to Increment 0.5's
 * `selectGroupTestActors`/`resolveGroupTest` so no arithmetic is forked.
 */

import { describe, expect, it } from 'vitest';
import { getContentPack, getTarotProcedures } from '$lib/server/content/loader';
import { makeRng } from '$lib/engine/rng';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import {
	declineTestPush,
	drawTestCard,
	pushTestFate,
	readGuidedTest,
	setTestFavor,
	TEST_OF_FATE_PROCEDURE_ID,
	type GuidedTestMaterials,
	type GuidedTestReduceContext
} from '$lib/engine/session/procedures/test-of-fate';
import {
	advanceGroupTest,
	declareGroupTest,
	overrideGroupTestActors,
	readGroupTest
} from '$lib/engine/session/procedures/group-test';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, SessionEvent, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };
const BOB: SessionActor = { kind: 'player', userId: 'user-bob' };

const CATALOG: TarotCardCatalog = makeRichSessionCatalogFixture();

const PROCEDURE = (() => {
	const found = getTarotProcedures().procedures.find((p) => p.id === TEST_OF_FATE_PROCEDURE_ID);
	if (!found) throw new Error('content pack is missing the test-of-fate procedure');
	return found;
})();

function actor(
	tenureId: string,
	userId: string,
	swords: number,
	rosterOrder: number,
	resolveCurrent = 3
): GuidedTestMaterials['actors'][number] {
	return {
		tenureId,
		characterId: `char-${userId}`,
		userId,
		attributes: { swords, pentacles: 2, cups: 2, wands: 2 },
		characterVersion: 1,
		resolveCurrent,
		rosterOrder
	};
}

/** No tie: Alice is clearly most qualified at Swords, Bob clearly least. */
const MATERIALS: GuidedTestMaterials = {
	actors: [
		actor('tenure-1', 'user-alice', 4, 0),
		actor('tenure-2', 'user-bob', 1, 1),
		actor('tenure-3', 'user-carol', 3, 2)
	]
};

/** Bob and Dave both sit at Swords 1 — Ch1's "apparent ties". */
const TIED_MATERIALS: GuidedTestMaterials = {
	actors: [
		actor('tenure-1', 'user-alice', 4, 0),
		actor('tenure-2', 'user-bob', 1, 1),
		actor('tenure-3', 'user-carol', 3, 2),
		actor('tenure-4', 'user-dave', 1, 3)
	]
};

function ctxFor(a: SessionActor, materials: GuidedTestMaterials = MATERIALS, seed = 'group-test'): GuidedTestReduceContext {
	return {
		actor: a,
		runtime: { catalog: CATALOG },
		rng: makeRng(seed),
		config: getContentPack().tarot,
		materials,
		procedure: PROCEDURE
	};
}

type Result = { ok: true; state: SessionEngineStateV1; events: SessionEvent[] } | { ok: false; rejection: { code: string; message: string } };

function unwrap(result: Result): SessionEngineStateV1 {
	if (!result.ok) throw new Error(`expected ok, got rejection: ${result.rejection.code} ${result.rejection.message}`);
	return result.state;
}

function eventsOf(result: Result): SessionEvent[] {
	if (!result.ok) throw new Error(`expected ok, got rejection: ${result.rejection.code}`);
	return result.events;
}

function withTopOfPlayerDraw(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const rest = state.playerDraw.filter((id) => !cardIds.includes(id));
	return { ...state, playerDraw: [...cardIds, ...rest] };
}

const CANDIDATES = ['tenure-1', 'tenure-2', 'tenure-3'];

describe('group test — selection', () => {
	it('picks the most and least qualified by the SERVER-read tested attribute', () => {
		const state = unwrap(
			declareGroupTest(makeSessionFixture(), { testedSuit: 'swords', candidateTenureIds: CANDIDATES }, ctxFor(GM))
		);

		expect(readGroupTest(state)).toMatchObject({
			schemaVersion: 1,
			testedSuit: 'swords',
			mostQualifiedTenureId: 'tenure-1',
			leastQualifiedTenureId: 'tenure-2',
			requiresTableDecision: false,
			result: null
		});
	});

	it('ranks by the tested suit, not a fixed attribute', () => {
		// Every candidate has cups 2, so the highest-Swords adventurer no longer
		// leads: the cups tie falls back to roster order.
		const state = unwrap(
			declareGroupTest(makeSessionFixture(), { testedSuit: 'cups', candidateTenureIds: CANDIDATES }, ctxFor(GM))
		);

		expect(readGroupTest(state)).toMatchObject({ testedSuit: 'cups', requiresTableDecision: true });
	});

	it('flags an apparent tie while still proposing a stable default', () => {
		const state = unwrap(
			declareGroupTest(
				makeSessionFixture(),
				{ testedSuit: 'swords', candidateTenureIds: ['tenure-1', 'tenure-2', 'tenure-3', 'tenure-4'] },
				ctxFor(GM, TIED_MATERIALS)
			)
		);

		// Bob (roster 1) and Dave (roster 3) tie at Swords 1; roster order breaks it.
		expect(readGroupTest(state)).toMatchObject({
			leastQualifiedTenureId: 'tenure-2',
			requiresTableDecision: true
		});
	});

	it('publishes the chosen actors before any card is drawn', () => {
		const result = declareGroupTest(
			makeSessionFixture(),
			{ testedSuit: 'swords', candidateTenureIds: CANDIDATES },
			ctxFor(GM)
		);

		const events = eventsOf(result);
		expect(events).toContainEqual(
			expect.objectContaining({
				kind: 'group-test-declared',
				publicPayload: expect.objectContaining({
					testedSuit: 'swords',
					mostQualifiedTenureId: 'tenure-1',
					leastQualifiedTenureId: 'tenure-2',
					requiresTableDecision: false
				})
			})
		);
		// The names are announced; no card has moved yet.
		expect(events.map((event) => event.kind)).not.toContain('card-drawn');
	});

	it('opens the most-qualified adventurer’s subtest first', () => {
		const state = unwrap(
			declareGroupTest(makeSessionFixture(), { testedSuit: 'swords', candidateTenureIds: CANDIDATES }, ctxFor(GM))
		);

		expect(readGuidedTest(state)).toMatchObject({ stage: 'favor', actorTenureId: 'tenure-1', testedSuit: 'swords' });
		expect(readGroupTest(state)?.stage).toBe('most-qualified');
	});

	it('needs at least two distinct candidates', () => {
		const result = declareGroupTest(
			makeSessionFixture(),
			{ testedSuit: 'swords', candidateTenureIds: ['tenure-1'] },
			ctxFor(GM)
		);

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a candidate who is not at the table', () => {
		const result = declareGroupTest(
			makeSessionFixture(),
			{ testedSuit: 'swords', candidateTenureIds: ['tenure-1', 'tenure-absent'] },
			ctxFor(GM)
		);

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('a player may not declare a group test', () => {
		const result = declareGroupTest(
			makeSessionFixture(),
			{ testedSuit: 'swords', candidateTenureIds: CANDIDATES },
			ctxFor(ALICE)
		);

		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('is rejected while an individual test is already in flight', () => {
		const state = unwrap(
			declareGroupTest(makeSessionFixture(), { testedSuit: 'swords', candidateTenureIds: CANDIDATES }, ctxFor(GM))
		);

		const result = declareGroupTest(state, { testedSuit: 'cups', candidateTenureIds: CANDIDATES }, ctxFor(GM));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});
});

describe('group test — table override on a tie', () => {
	it('lets the GM substitute the table’s decision', () => {
		let state = unwrap(
			declareGroupTest(
				makeSessionFixture(),
				{ testedSuit: 'swords', candidateTenureIds: ['tenure-1', 'tenure-2', 'tenure-3', 'tenure-4'] },
				ctxFor(GM, TIED_MATERIALS)
			)
		);

		state = unwrap(
			overrideGroupTestActors(
				state,
				{ mostQualifiedTenureId: 'tenure-1', leastQualifiedTenureId: 'tenure-4' },
				ctxFor(GM, TIED_MATERIALS)
			)
		);

		expect(readGroupTest(state)).toMatchObject({ leastQualifiedTenureId: 'tenure-4' });
		// The open subtest must follow the override, not the superseded default.
		expect(readGuidedTest(state)).toMatchObject({ actorTenureId: 'tenure-1' });
	});

	it('refuses an override once the first subtest has drawn', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-x']);
		state = unwrap(
			declareGroupTest(
				state,
				{ testedSuit: 'swords', candidateTenureIds: ['tenure-1', 'tenure-2', 'tenure-3', 'tenure-4'] },
				ctxFor(GM, TIED_MATERIALS)
			)
		);
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM, TIED_MATERIALS)));
		state = unwrap(drawTestCard(state, ctxFor(ALICE, TIED_MATERIALS)));

		const result = overrideGroupTestActors(
			state,
			{ mostQualifiedTenureId: 'tenure-1', leastQualifiedTenureId: 'tenure-4' },
			ctxFor(GM, TIED_MATERIALS)
		);

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('refuses an override naming someone outside the declared group', () => {
		const state = unwrap(
			declareGroupTest(
				makeSessionFixture(),
				{ testedSuit: 'swords', candidateTenureIds: ['tenure-1', 'tenure-2'] },
				ctxFor(GM, TIED_MATERIALS)
			)
		);

		const result = overrideGroupTestActors(
			state,
			{ mostQualifiedTenureId: 'tenure-1', leastQualifiedTenureId: 'tenure-4' },
			ctxFor(GM, TIED_MATERIALS)
		);

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('refuses an override that names one adventurer for both ends', () => {
		const state = unwrap(
			declareGroupTest(
				makeSessionFixture(),
				{ testedSuit: 'swords', candidateTenureIds: ['tenure-1', 'tenure-2'] },
				ctxFor(GM, TIED_MATERIALS)
			)
		);

		const result = overrideGroupTestActors(
			state,
			{ mostQualifiedTenureId: 'tenure-1', leastQualifiedTenureId: 'tenure-1' },
			ctxFor(GM, TIED_MATERIALS)
		);

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});
});

describe('group test — two full independent flows', () => {
	/** Alice (Swords 4) great-succeeds on swords-x; Bob (Swords 1) fails on
	 * cups-iii and declines the push. 2 + 0 hits = 2 -> the "Success" band. */
	function runBothSubtests(): { state: SessionEngineStateV1; finalEvents: SessionEvent[] } {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-x', 'cups-iii']);
		state = unwrap(declareGroupTest(state, { testedSuit: 'swords', candidateTenureIds: CANDIDATES }, ctxFor(GM)));

		// Subtest one — Alice, with circumstantial favor she does not need.
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(drawTestCard(state, ctxFor(ALICE)));
		expect(readGuidedTest(state)).toMatchObject({ stage: 'complete', result: { outcome: 'great-success' } });
		state = unwrap(advanceGroupTest(state, ctxFor(GM)));

		// Subtest two — Bob, a separate favor decision and a declined push.
		expect(readGuidedTest(state)).toMatchObject({ stage: 'favor', actorTenureId: 'tenure-2' });
		state = unwrap(setTestFavor(state, { favor: false, disfavor: true }, ctxFor(GM)));
		state = unwrap(drawTestCard(state, ctxFor(BOB)));
		state = unwrap(declineTestPush(state, ctxFor(BOB)));

		const final = advanceGroupTest(state, ctxFor(GM));
		return { state: unwrap(final), finalEvents: eventsOf(final) };
	}

	it('totals hits through resolveGroupTest and classifies the band', () => {
		const { state } = runBothSubtests();

		expect(readGroupTest(state)).toMatchObject({
			stage: 'complete',
			outcomes: ['great-success', 'failure'],
			result: { hits: 2, outcome: { id: 'success', label: 'Success' } }
		});
	});

	it('each subtest keeps its own favor decision', () => {
		const { state } = runBothSubtests();

		// Alice tested with neither; Bob tested with disfavor. A shared favor flag
		// would have collapsed these into one value.
		expect(readGroupTest(state)?.subtestSummaries).toEqual([
			expect.objectContaining({ actorTenureId: 'tenure-1', favor: false, disfavor: false, outcome: 'great-success' }),
			expect.objectContaining({ actorTenureId: 'tenure-2', favor: false, disfavor: true, outcome: 'failure' })
		]);
	});

	it('publishes the two outcomes and the hit total only after both tests finish', () => {
		const { finalEvents } = runBothSubtests();

		expect(finalEvents).toContainEqual(
			expect.objectContaining({
				kind: 'group-test-resolved',
				publicPayload: expect.objectContaining({
					outcomes: ['great-success', 'failure'],
					hits: 2,
					outcomeId: 'success'
				})
			})
		);
	});

	it('clears both slots and conserves every card', () => {
		const { state } = runBothSubtests();

		expect(readGuidedTest(state)).toBeUndefined();
		expect(state.playerDiscard).toEqual(expect.arrayContaining(['swords-x', 'cups-iii']));
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('a resolved group test may be replaced by a new declaration', () => {
		const { state } = runBothSubtests();

		const next = unwrap(declareGroupTest(state, { testedSuit: 'cups', candidateTenureIds: CANDIDATES }, ctxFor(GM)));

		expect(readGroupTest(next)).toMatchObject({ testedSuit: 'cups', stage: 'most-qualified', outcomes: [], result: null });
	});

	it('advancing before the open subtest resolves is rejected', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-x', 'cups-iii']);
		state = unwrap(declareGroupTest(state, { testedSuit: 'swords', candidateTenureIds: CANDIDATES }, ctxFor(GM)));

		expect(advanceGroupTest(state, ctxFor(GM))).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('a player may not advance the group test', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-x', 'cups-iii']);
		state = unwrap(declareGroupTest(state, { testedSuit: 'swords', candidateTenureIds: CANDIDATES }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(drawTestCard(state, ctxFor(ALICE)));

		expect(advanceGroupTest(state, ctxFor(ALICE))).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('a subtest that pushes records the pushed outcome, not the initial failure', () => {
		// Alice fails on cups-ii (4 + 2 = 6) and pushes into swords-x: 4 + 2 + 10
		// = 16. A pushed success is an ordinary success, never a great one.
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-ii', 'swords-x']);
		state = unwrap(declareGroupTest(state, { testedSuit: 'swords', candidateTenureIds: CANDIDATES }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(drawTestCard(state, ctxFor(ALICE)));
		state = unwrap(pushTestFate(state, ctxFor(ALICE)));
		state = unwrap(advanceGroupTest(state, ctxFor(GM)));

		expect(readGroupTest(state)?.outcomes).toEqual(['success']);
		// Both of the first subtest's cards are discarded before the second opens.
		expect(state.playerDiscard).toEqual(expect.arrayContaining(['cups-ii', 'swords-x']));
	});
});
