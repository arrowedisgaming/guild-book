/**
 * Increment 4 Task 2 — the single guided-test dispatch entry point.
 *
 * Mirrors `challenge/command.ts`'s `applyChallengeCommand`: derives the legal
 * set from `legalGuidedTestCommands` and rejects a command whose type is absent
 * from it OUTRIGHT, before the underlying transition ever runs. The individual
 * transitions still re-check their own preconditions (defence in depth), so
 * this gate is about never dispatching something the projection did not offer.
 */

import { describe, expect, it } from 'vitest';
import { getContentPack, getTarotProcedures } from '$lib/server/content/loader';
import { makeRng } from '$lib/engine/rng';
import {
	readGuidedTest,
	TEST_OF_FATE_PROCEDURE_ID,
	type GuidedTestMaterials,
	type GuidedTestReduceContext
} from '$lib/engine/session/procedures/test-of-fate';
import { readGroupTest } from '$lib/engine/session/procedures/group-test';
import { applyGuidedTestCommand } from '$lib/engine/session/procedures/guided-test-command';
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

function ctxFor(actor: SessionActor): GuidedTestReduceContext {
	return {
		actor,
		runtime: { catalog: CATALOG },
		rng: makeRng('guided-test-command'),
		config: getContentPack().tarot,
		materials: MATERIALS,
		procedure: PROCEDURE
	};
}

function unwrap(result: ReturnType<typeof applyGuidedTestCommand>): SessionEngineStateV1 {
	if (!result.ok) throw new Error(`expected ok, got ${result.rejection.code}: ${result.rejection.message}`);
	return result.state;
}

function withTopOfPlayerDraw(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const rest = state.playerDraw.filter((id) => !cardIds.includes(id));
	return { ...state, playerDraw: [...cardIds, ...rest] };
}

describe('guided test command dispatch', () => {
	it('drives a whole individual test through one entry point', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-x']);
		state = unwrap(
			applyGuidedTestCommand(state, { type: 'declare-test-of-fate', actorTenureId: 'tenure-1', testedSuit: 'swords' }, ctxFor(GM))
		);
		state = unwrap(applyGuidedTestCommand(state, { type: 'set-test-favor', favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(applyGuidedTestCommand(state, { type: 'draw-test-card' }, ctxFor(ALICE)));

		expect(readGuidedTest(state)).toMatchObject({ stage: 'complete', result: { outcome: 'great-success' } });

		state = unwrap(applyGuidedTestCommand(state, { type: 'complete-guided-test' }, ctxFor(GM)));
		expect(readGuidedTest(state)).toBeUndefined();
	});

	it('drives a whole group test through one entry point', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-x', 'cups-iii']);
		state = unwrap(
			applyGuidedTestCommand(
				state,
				{ type: 'declare-group-test', testedSuit: 'swords', candidateTenureIds: ['tenure-1', 'tenure-2'] },
				ctxFor(GM)
			)
		);
		state = unwrap(applyGuidedTestCommand(state, { type: 'set-test-favor', favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(applyGuidedTestCommand(state, { type: 'draw-test-card' }, ctxFor(ALICE)));
		state = unwrap(applyGuidedTestCommand(state, { type: 'advance-group-test' }, ctxFor(GM)));
		state = unwrap(applyGuidedTestCommand(state, { type: 'set-test-favor', favor: false, disfavor: false }, ctxFor(GM)));
		state = unwrap(applyGuidedTestCommand(state, { type: 'draw-test-card' }, ctxFor(BOB)));
		state = unwrap(applyGuidedTestCommand(state, { type: 'decline-test-push' }, ctxFor(BOB)));
		state = unwrap(applyGuidedTestCommand(state, { type: 'advance-group-test' }, ctxFor(GM)));

		expect(readGroupTest(state)).toMatchObject({ stage: 'complete', result: { hits: 2 } });
	});

	it('rejects a command the projection does not currently offer', () => {
		// Nothing is in flight, so there is nothing to draw.
		const result = applyGuidedTestCommand(makeSessionFixture(), { type: 'draw-test-card' }, ctxFor(ALICE));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a player attempting a GM-only command', () => {
		const result = applyGuidedTestCommand(
			makeSessionFixture(),
			{ type: 'declare-test-of-fate', actorTenureId: 'tenure-1', testedSuit: 'swords' },
			ctxFor(ALICE)
		);

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a Resolve purchase the actor cannot afford before dispatching it', () => {
		let state = unwrap(
			applyGuidedTestCommand(
				makeSessionFixture(),
				{ type: 'declare-test-of-fate', actorTenureId: 'tenure-2', testedSuit: 'cups' },
				ctxFor(GM)
			)
		);
		state = unwrap(applyGuidedTestCommand(state, { type: 'set-test-favor', favor: false, disfavor: false }, ctxFor(GM)));

		// Bob holds 0 Resolve, so the control is never offered and the gate refuses.
		expect(applyGuidedTestCommand(state, { type: 'purchase-test-favor' }, ctxFor(BOB))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});

	it('reports which command types spend Resolve so the service can splice the write', () => {
		let state = unwrap(
			applyGuidedTestCommand(
				makeSessionFixture(),
				{ type: 'declare-test-of-fate', actorTenureId: 'tenure-1', testedSuit: 'swords' },
				ctxFor(GM)
			)
		);
		state = unwrap(applyGuidedTestCommand(state, { type: 'set-test-favor', favor: false, disfavor: false }, ctxFor(GM)));

		const spent = unwrap(applyGuidedTestCommand(state, { type: 'purchase-test-favor' }, ctxFor(ALICE)));
		expect(readGuidedTest(spent)).toMatchObject({ resolvePurchase: { characterId: 'char-alice', spent: 1 } });
	});
});
