/**
 * Increment 4 Task 3 Step 3 — the Camp projection's disclosure boundaries.
 *
 * The one assertion that matters most: an inspiration card's FACE reaches its
 * holder and nobody else. Everyone sees the COUNT, which is what makes Ch5's
 * one-per-player cap checkable at the table without exposing what anyone drew.
 */

import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { makeRng } from '$lib/engine/rng';
import {
	beginHighChant,
	beginLeeches,
	buildCampConfig,
	completeHighChantTransfer,
	selectInspiration,
	advanceLeeches,
	type CampConfig,
	type CampMaterials,
	type CampReduceContext
} from '$lib/engine/session/procedures/camp';
import { projectCampForActor } from '$lib/engine/session/procedures/camp-projection';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };
const BOB: SessionActor = { kind: 'player', userId: 'user-bob' };
const CAROL: SessionActor = { kind: 'player', userId: 'user-carol' };

const CATALOG: TarotCardCatalog = makeRichSessionCatalogFixture();

const MATERIALS: CampMaterials = {
	actors: [
		{ tenureId: 'tenure-1', characterId: 'char-alice', userId: 'user-alice', attributes: { swords: 2, pentacles: 2, cups: 3, wands: 1 }, rosterOrder: 0 },
		{ tenureId: 'tenure-2', characterId: 'char-bob', userId: 'user-bob', attributes: { swords: 4, pentacles: 1, cups: 1, wands: 2 }, rosterOrder: 1 },
		{ tenureId: 'tenure-3', characterId: 'char-carol', userId: 'user-carol', attributes: { swords: 1, pentacles: 3, cups: 2, wands: 2 }, rosterOrder: 2 }
	]
};

const CONFIG: CampConfig = (() => {
	const pack = getTarotProcedures();
	return buildCampConfig(pack.procedures, pack.formulas, pack.modifiers);
})();

function ctxFor(actor: SessionActor): CampReduceContext {
	return { actor, runtime: { catalog: CATALOG }, rng: makeRng('camp-projection'), config: CONFIG, materials: MATERIALS };
}

function unwrap(result: ReturnType<typeof beginHighChant>): SessionEngineStateV1 {
	if (!result.ok) throw new Error(`expected ok, got ${result.rejection.code}: ${result.rejection.message}`);
	return result.state;
}

function withMinorDiscard(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const playerDraw = state.playerDraw.filter((id) => !cardIds.includes(id));
	return { ...state, playerDraw, playerDiscard: [...state.playerDiscard, ...cardIds] };
}

function withTopOfPlayerDraw(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const rest = state.playerDraw.filter((id) => !cardIds.includes(id));
	return { ...state, playerDraw: [...cardIds, ...rest] };
}

function project(state: SessionEngineStateV1, actor: SessionActor) {
	return projectCampForActor(state, actor, CATALOG, MATERIALS, CONFIG);
}

const DISCARD = ['cups-ii', 'cups-iii', 'cups-iv'];

/** Alice performs, selects all three, and hands one to Bob. */
function granted(): SessionEngineStateV1 {
	let state = withMinorDiscard(makeSessionFixture(), DISCARD);
	state = unwrap(beginHighChant(state, ctxFor(ALICE)));
	state = unwrap(selectInspiration(state, { cardIds: DISCARD }, ctxFor(ALICE)));
	return unwrap(completeHighChantTransfer(state, { cardId: 'cups-ii', recipientTenureId: 'tenure-2' }, ctxFor(ALICE)));
}

describe('camp projection — inspiration privacy', () => {
	it('shows the holder their own inspiration card', () => {
		expect(project(granted(), BOB).myInspiration).toMatchObject({ hidden: false, id: 'cups-ii' });
	});

	it('never shows another player’s inspiration card', () => {
		const state = granted();

		expect(project(state, CAROL).myInspiration).toBeNull();
		// Alice handed it over, so it is no longer hers either.
		expect(project(state, ALICE).myInspiration).toBeNull();
	});

	it('never shows the GM anyone’s inspiration card', () => {
		const view = project(granted(), GM);

		expect(view.myInspiration).toBeNull();
		expect(JSON.stringify(view)).not.toContain('cups-ii');
	});

	it('shows every viewer the counts, so the one-per-player cap is checkable', () => {
		const state = granted();

		for (const actor of [GM, ALICE, BOB, CAROL]) {
			expect(project(state, actor).inspiration).toEqual(
				expect.arrayContaining([
					{ tenureId: 'tenure-2', count: 1, atCap: true },
					{ tenureId: 'tenure-3', count: 0, atCap: false }
				])
			);
		}
	});

	it('shows the performer their own undistributed selection and nobody else', () => {
		const state = granted();

		expect(project(state, ALICE).highChant?.mySelection.map((slot) => (slot.hidden ? null : slot.id))).toEqual(['cups-iii', 'cups-iv']);
		expect(project(state, BOB).highChant?.mySelection).toEqual([]);
		expect(project(state, GM).highChant?.mySelection).toEqual([]);
	});

	it('publishes how many are left to hand out without publishing which', () => {
		const view = project(granted(), CAROL).highChant;

		expect(view).toMatchObject({ undistributedCount: 2, isMine: false });
		expect(JSON.stringify(view)).not.toContain('cups-iii');
	});

	it('names who received one, never what they received', () => {
		const view = project(granted(), CAROL).highChant;

		expect(view?.assignments).toEqual([{ recipientTenureId: 'tenure-2' }]);
	});
});

describe('camp projection — the minor discard during a High Chant', () => {
	it('surfaces the whole pile while selecting, so a performer can reach past the top card', () => {
		let state = withMinorDiscard(makeSessionFixture(), DISCARD);
		state = unwrap(beginHighChant(state, ctxFor(ALICE)));

		// Ch5 selects "a number of cards from the minor arcana discard pile equal to
		// your Cups" — the generic projection's top-card-only view could never
		// reach the second one.
		expect(project(state, ALICE).minorDiscard.map((slot) => (slot.hidden ? null : slot.id))).toEqual(DISCARD);
	});

	it('stops surfacing it once selection is done', () => {
		expect(project(granted(), ALICE).minorDiscard).toEqual([]);
	});

	it('does not surface it when no High Chant is running', () => {
		const state = withMinorDiscard(makeSessionFixture(), DISCARD);

		expect(project(state, ALICE).minorDiscard).toEqual([]);
	});
});

describe('camp projection — leeches is public', () => {
	it('shows the drawn card and outcome to every viewer', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(advanceLeeches(state, ctxFor(ALICE)));

		for (const actor of [GM, ALICE, BOB, CAROL]) {
			expect(project(state, actor).leeches).toMatchObject({
				drawnCard: expect.objectContaining({ id: 'cups-iv' }),
				outcome: { effect: 'cure-affliction', charges: 2 }
			});
		}
	});

	it('carries the pack’s suit sets so the panel never restates the rule', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));

		expect(project(state, BOB).leeches).toMatchObject({
			noEffectSuits: ['swords', 'pentacles'],
			cureSuits: ['cups', 'wands']
		});
	});

	it('marks the applying player’s own view as theirs', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));

		expect(project(state, ALICE).leeches?.isMine).toBe(true);
		expect(project(state, BOB).leeches?.isMine).toBe(false);
	});
});

describe('camp projection — controls', () => {
	it('offers both Camp actions to an adventurer when nothing is running', () => {
		expect(project(makeSessionFixture(), ALICE).controls).toEqual(['begin-high-chant', 'begin-leeches']);
	});

	it('offers the GM nothing to start — Camp Actions belong to adventurers', () => {
		expect(project(makeSessionFixture(), GM).controls).toEqual([]);
	});

	it('offers selection only to the performer', () => {
		let state = withMinorDiscard(makeSessionFixture(), DISCARD);
		state = unwrap(beginHighChant(state, ctxFor(ALICE)));

		expect(project(state, ALICE).controls).toEqual(['select-inspiration']);
		expect(project(state, BOB).controls).toEqual([]);
	});

	it('stops offering a hand-over once every adventurer is at the cap', () => {
		let state = granted();
		state = unwrap(completeHighChantTransfer(state, { cardId: 'cups-iii', recipientTenureId: 'tenure-3' }, ctxFor(ALICE)));
		state = unwrap(completeHighChantTransfer(state, { cardId: 'cups-iv', recipientTenureId: 'tenure-1' }, ctxFor(ALICE)));

		// Everyone holds one now, so the only move left is to finish.
		expect(project(state, ALICE).controls).toEqual(['complete-camp-procedure']);
	});

	it('offers the draw only to the applying player', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));

		expect(project(state, ALICE).controls).toEqual(['advance-leeches']);
		expect(project(state, BOB).controls).toEqual([]);
		expect(project(state, GM).controls).toEqual([]);
	});
});
