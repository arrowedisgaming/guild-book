/**
 * Increment 4 Task 2 Step 4 — the guided test's own actor-scoped projection and
 * legal-command derivation.
 *
 * A parallel slice alongside the generic `SessionPlayerProjection`/
 * `SessionGmProjection`, exactly like `procedures/challenge/projection.ts`:
 * `state.guidedTest`/`state.groupTest` are `unknown` to the generic engine by
 * design, so nothing about them reaches an actor without a projector of its
 * own.
 *
 * The panels render their controls from `controls` here rather than guessing
 * client-side — the same "don't offer a button guaranteed to fail" discipline
 * `legalChallengeCommands` established.
 */

import { describe, expect, it } from 'vitest';
import { getContentPack, getTarotProcedures } from '$lib/server/content/loader';
import { makeRng } from '$lib/engine/rng';
import {
	declareTestOfFate,
	drawTestCard,
	setTestFavor,
	TEST_OF_FATE_PROCEDURE_ID,
	type GuidedTestMaterials,
	type GuidedTestReduceContext
} from '$lib/engine/session/procedures/test-of-fate';
import { declareGroupTest } from '$lib/engine/session/procedures/group-test';
import { projectGuidedTestForActor } from '$lib/engine/session/procedures/guided-test-projection';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };
const BOB: SessionActor = { kind: 'player', userId: 'user-bob' };

const CATALOG: TarotCardCatalog = makeRichSessionCatalogFixture();

const PROCEDURE = (() => {
	const found = getTarotProcedures().procedures.find((p) => p.id === TEST_OF_FATE_PROCEDURE_ID);
	if (!found) throw new Error('content pack is missing the test-of-fate procedure');
	return found;
})();

const MATERIALS: GuidedTestMaterials = {
	actors: [
		{
			tenureId: 'tenure-1',
			characterId: 'char-alice',
			userId: 'user-alice',
			attributes: { swords: 4, pentacles: 2, cups: 2, wands: 2 },
			characterVersion: 1,
			resolveCurrent: 3,
			rosterOrder: 0
		},
		{
			tenureId: 'tenure-2',
			characterId: 'char-bob',
			userId: 'user-bob',
			attributes: { swords: 1, pentacles: 1, cups: 1, wands: 1 },
			characterVersion: 1,
			resolveCurrent: 0,
			rosterOrder: 1
		},
		// Carol matches Alice at Cups exactly — a two-candidate group of these
		// two is Ch1's "apparent tie" at both ends at once.
		{
			tenureId: 'tenure-3',
			characterId: 'char-carol',
			userId: 'user-carol',
			attributes: { swords: 3, pentacles: 2, cups: 2, wands: 2 },
			characterVersion: 1,
			resolveCurrent: 2,
			rosterOrder: 2
		}
	]
};

function ctxFor(actor: SessionActor): GuidedTestReduceContext {
	return {
		actor,
		runtime: { catalog: CATALOG },
		rng: makeRng('guided-test-projection'),
		config: getContentPack().tarot,
		materials: MATERIALS,
		procedure: PROCEDURE
	};
}

function unwrap(result: ReturnType<typeof declareTestOfFate>): SessionEngineStateV1 {
	if (!result.ok) throw new Error(`expected ok, got ${result.rejection.code}: ${result.rejection.message}`);
	return result.state;
}

function withTopOfPlayerDraw(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const rest = state.playerDraw.filter((id) => !cardIds.includes(id));
	return { ...state, playerDraw: [...cardIds, ...rest] };
}

function project(state: SessionEngineStateV1, actor: SessionActor) {
	return projectGuidedTestForActor(state, actor, CATALOG, MATERIALS);
}

describe('guided test projection', () => {
	it('reports no test and no controls beyond declaring when nothing is in flight', () => {
		const view = project(makeSessionFixture(), GM);

		expect(view.test).toBeNull();
		expect(view.group).toBeNull();
		expect(view.controls).toEqual(['declare-test-of-fate', 'declare-group-test']);
	});

	it('offers a player nothing to declare', () => {
		const view = project(makeSessionFixture(), ALICE);

		expect(view.controls).toEqual([]);
	});

	it('surfaces the declared test with its actor, suit and stage', () => {
		const state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));

		expect(project(state, ALICE).test).toMatchObject({
			stage: 'favor',
			actorTenureId: 'tenure-1',
			testedSuit: 'swords',
			isMine: true,
			result: null
		});
	});

	it('tells a non-acting player the test is not theirs', () => {
		const state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));

		expect(project(state, BOB).test).toMatchObject({ isMine: false });
		expect(project(state, BOB).controls).toEqual([]);
	});

	it('offers only the GM favor settlement at the favor stage', () => {
		const state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));

		expect(project(state, GM).controls).toEqual(['set-test-favor']);
		expect(project(state, ALICE).controls).toEqual([]);
	});

	it('offers the acting player the draw and the Resolve purchase once favor is settled', () => {
		let state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));

		expect(project(state, ALICE).controls).toEqual(expect.arrayContaining(['draw-test-card', 'purchase-test-favor']));
	});

	it('withholds the Resolve purchase from an actor who cannot afford it', () => {
		let state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-2', testedSuit: 'cups' }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));

		// Bob holds 0 Resolve — the button must never be offered.
		expect(project(state, BOB).controls).toEqual(['draw-test-card']);
	});

	it('reports the affordable flag so the panel can explain the absence', () => {
		let state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-2', testedSuit: 'cups' }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));

		expect(project(state, BOB).test).toMatchObject({ resolveAffordable: false, resolveCurrent: 0 });
	});

	it('never reports another actor’s Resolve', () => {
		let state = unwrap(declareTestOfFate(makeSessionFixture(), { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));

		// Alice holds 3, but Bob is not the tester and the GM does not own a sheet.
		expect(project(state, BOB).test?.resolveCurrent).toBeNull();
		expect(project(state, GM).test?.resolveCurrent).toBeNull();
	});

	it('hydrates the drawn card and publishes the outcome after the draw', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-x']);
		state = unwrap(declareTestOfFate(state, { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(drawTestCard(state, ctxFor(ALICE)));

		const view = project(state, BOB).test;
		expect(view?.initialCard).toMatchObject({ hidden: false, id: 'swords-x', value: 10 });
		expect(view?.result).toMatchObject({ outcome: 'great-success', total: 14 });
	});

	it('offers the push only to the acting player off a failure', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iii']);
		state = unwrap(declareTestOfFate(state, { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(drawTestCard(state, ctxFor(ALICE)));

		expect(project(state, ALICE).controls).toEqual(expect.arrayContaining(['push-test-fate', 'decline-test-push']));
		expect(project(state, BOB).controls).toEqual([]);
		expect(project(state, GM).controls).toEqual([]);
	});

	it('offers the GM completion once the test resolves', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-x']);
		state = unwrap(declareTestOfFate(state, { actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(drawTestCard(state, ctxFor(ALICE)));

		expect(project(state, GM).controls).toEqual(['complete-guided-test']);
	});
});

describe('group test projection', () => {
	it('surfaces the chosen adventurers and the tie flag', () => {
		const state = unwrap(
			declareGroupTest(
				makeSessionFixture(),
				{ testedSuit: 'swords', candidateTenureIds: ['tenure-1', 'tenure-2'] },
				ctxFor(GM)
			)
		);

		expect(project(state, BOB).group).toMatchObject({
			stage: 'most-qualified',
			testedSuit: 'swords',
			mostQualifiedTenureId: 'tenure-1',
			leastQualifiedTenureId: 'tenure-2',
			requiresTableDecision: false,
			outcomes: [],
			result: null
		});
	});

	it('offers the GM the table-decision override only while a tie is unresolved', () => {
		const state = unwrap(
			declareGroupTest(
				makeSessionFixture(),
				{ testedSuit: 'cups', candidateTenureIds: ['tenure-1', 'tenure-3'] },
				ctxFor(GM)
			)
		);

		// Alice and Carol both hold Cups 2, so this selection is tied at both ends.
		expect(project(state, GM).group?.requiresTableDecision).toBe(true);
		expect(project(state, GM).controls).toEqual(expect.arrayContaining(['override-group-test-actors']));
	});

	it('offers the GM the group advance once the open subtest resolves', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-x']);
		state = unwrap(declareGroupTest(state, { testedSuit: 'swords', candidateTenureIds: ['tenure-1', 'tenure-2'] }, ctxFor(GM)));
		state = unwrap(setTestFavor(state, { favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(drawTestCard(state, ctxFor(ALICE)));

		// The group's own advance replaces the standalone completion — finalizing
		// the subtest is what scores it.
		expect(project(state, GM).controls).toEqual(['advance-group-test']);
	});
});
