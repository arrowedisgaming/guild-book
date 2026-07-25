/**
 * Increment 4 Task 4 Step 1 — the Crawl and Camp-watch half of the coverage
 * matrix: Area Sense, Overland Travel, No Rest for the Wicked (camp-watch),
 * Patrol, and We're Doomed. Same discipline as `oracles.test.ts`: every test
 * drives the data-driven finite runner against the REAL content pack.
 */

import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { makeRng } from '$lib/engine/rng';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import {
	advanceFiniteProcedure,
	beginFiniteProcedure,
	completeFiniteProcedure,
	finiteZoneId,
	readFiniteProcedure,
	type FiniteMaterials,
	type FiniteReduceContext
} from '$lib/engine/session/procedures/finite-procedure';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, SessionEvent, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };
const BOB: SessionActor = { kind: 'player', userId: 'user-bob' };

const CATALOG: TarotCardCatalog = makeRichSessionCatalogFixture();
const PACK = getTarotProcedures();

const MATERIALS: FiniteMaterials = {
	actors: [
		{ tenureId: 'tenure-1', userId: 'user-alice', rosterOrder: 0 },
		{ tenureId: 'tenure-2', userId: 'user-bob', rosterOrder: 1 }
	]
};

function ctxFor(actor: SessionActor, seed = 'crawl'): FiniteReduceContext {
	return {
		actor,
		runtime: { catalog: CATALOG },
		rng: makeRng(seed),
		procedures: PACK.procedures,
		lookupTables: PACK.lookupTables,
		materials: MATERIALS
	};
}

type Result = ReturnType<typeof beginFiniteProcedure>;

function unwrap(result: Result): SessionEngineStateV1 {
	if (!result.ok) throw new Error(`expected ok, got ${result.rejection.code}: ${result.rejection.message}`);
	return result.state;
}

function eventsOf(result: Result): SessionEvent[] {
	if (!result.ok) throw new Error(`expected ok, got ${result.rejection.code}`);
	return result.events;
}

function withTopOfPlayerDraw(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const rest = state.playerDraw.filter((id) => !cardIds.includes(id));
	return { ...state, playerDraw: [...cardIds, ...rest] };
}

function withTopOfMajorDraw(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const rest = state.majorDraw.filter((id) => !cardIds.includes(id));
	return { ...state, majorDraw: [...cardIds, ...rest] };
}

function withMinorDiscardTop(state: SessionEngineStateV1, cardId: CardId): SessionEngineStateV1 {
	return { ...state, playerDraw: state.playerDraw.filter((id) => id !== cardId), playerDiscard: [cardId, ...state.playerDiscard] };
}

/** The major card with number `n` in the fixture catalog. */
function majorIdFor(n: number): CardId {
	const entry = Object.values(CATALOG).find((candidate) => candidate.major?.number === n);
	if (!entry) throw new Error(`no major card numbered ${n}`);
	return entry.id;
}

describe('crawl coverage matrix', () => {
	it('Crawl Area Sense — pay Resolve, pass the watch, draw the vision card, and the GM reads visions from its value', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['pentacles-vii']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'crawl-area-sense', actorTenureId: 'tenure-1' }, ctxFor(GM)));

		// Step 1 is the player's manual confirmation of the 2-Resolve cost (a
		// SHEET cost — the engine reports it, the table applies it). Step 2
		// (pass-watch, system/automatic) auto-runs.
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(ALICE)));
		expect(readFiniteProcedure(state)?.manual['pay-resolve']).toBe('yes');

		// Step 3: the player's public draw.
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(ALICE)));
		expect(findZoneDescriptor(state, finiteZoneId('crawl-area-sense'))?.cards).toEqual(['pentacles-vii']);

		// Step 4: the GM confirms the visions — the card-value effect resolves to
		// the drawn card's value, reported for the table, never auto-applied.
		const confirmed = advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(GM));
		state = unwrap(confirmed);
		const resolved = eventsOf(confirmed).find((event) => event.kind === 'finite-step-resolved');
		expect(resolved?.publicPayload).toMatchObject({
			stepId: 'resolve-visions',
			effect: { resource: 'visions', amount: 7 },
			manualConsequence: true
		});

		state = unwrap(completeFiniteProcedure(state, ctxFor(GM)));
		expect(state.playerDiscard).toContain('pentacles-vii');
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('Overland Travel — one major draw resolves the Meatgrinder row', () => {
		let state = withTopOfMajorDraw(makeSessionFixture(), [majorIdFor(11)]);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'overland-travel' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));

		expect(readFiniteProcedure(state)?.outcomes['travel-meatgrinder']).toMatchObject({
			tableId: 'meatgrinder',
			cells: [expect.objectContaining({ text: expect.stringContaining('[Travel event] Droppings') })]
		});
	});

	it('Camp watch — a random encounter consults the minor discard for WHICH watch, then the watcher draws', () => {
		// XVII is a random encounter row.
		let state = withTopOfMajorDraw(makeSessionFixture(), [majorIdFor(17)]);
		state = withMinorDiscardTop(state, 'cups-iii');
		state = withTopOfPlayerDraw(state, ['swords-x']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'camp-watch', actorTenureId: 'tenure-1' }, ctxFor(GM)));

		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));
		expect(readFiniteProcedure(state)?.outcomes['draw-meatgrinder']?.cells[0].text).toContain('[Random encounter]');

		// select-watch consults the discard top without consuming it.
		const discardBefore = state.playerDiscard.slice();
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));
		expect(state.playerDiscard).toEqual(discardBefore);

		// watch-cups-test: the watcher's own public draw.
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(ALICE)));
		expect(findZoneDescriptor(state, finiteZoneId('camp-watch'))?.cards).toContain('swords-x');
	});

	it('Camp watch — a non-encounter row skips the watch steps entirely', () => {
		// V is "Torches gutter" — no encounter, so select-watch and the cups test
		// are inapplicable and the procedure is complete after one draw.
		let state = withTopOfMajorDraw(makeSessionFixture(), [majorIdFor(5)]);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'camp-watch', actorTenureId: 'tenure-1' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));

		const runner = readFiniteProcedure(state);
		expect(runner?.outcomes['draw-meatgrinder']?.cells[0].text).toBe('Torches gutter');
		expect(runner?.skippedSteps).toEqual(expect.arrayContaining(['select-watch', 'watch-cups-test']));
	});

	it('Patrol — two draws, and the GM chooses the NON-encounter option', () => {
		// XVII (encounter) and XI (travel event): the GM must take XI.
		let state = withTopOfMajorDraw(makeSessionFixture(), [majorIdFor(17), majorIdFor(11)]);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'camp-patrol' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));

		const outcome = readFiniteProcedure(state)?.outcomes['draw-patrol-options'];
		expect(outcome?.cells).toHaveLength(2);

		// Choosing the encounter card is rejected by the choice's own rule.
		expect(advanceFiniteProcedure(state, { chosenCardId: majorIdFor(17) }, ctxFor(GM))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});

		state = unwrap(advanceFiniteProcedure(state, { chosenCardId: majorIdFor(11) }, ctxFor(GM)));
		expect(readFiniteProcedure(state)?.manual['choose-non-encounter']).toBe(majorIdFor(11));
		// Both drawn were not encounters, so the challenge-if-both step is skipped.
		expect(readFiniteProcedure(state)?.skippedSteps).toContain('challenge-if-both-encounters');
	});

	it('Patrol — two encounters force the Challenge confirmation instead of a choice', () => {
		// XVII and XIX are both random encounters.
		let state = withTopOfMajorDraw(makeSessionFixture(), [majorIdFor(17), majorIdFor(19)]);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'camp-patrol' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));

		// With every option an encounter, choose-one has nothing legal to choose —
		// it is skipped, and the both-encounters confirmation applies.
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(GM)));
		const runner = readFiniteProcedure(state);
		expect(runner?.skippedSteps).toContain('choose-non-encounter');
		expect(runner?.manual['challenge-if-both-encounters']).toBe('yes');
	});

	it('We’re Doomed — EACH attached player draws their own doom', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-ii', 'swords-page']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'crawl-were-doomed' }, ctxFor(GM)));

		// Alice draws numeral II -> the I–VII grue row.
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(ALICE)));
		expect(readFiniteProcedure(state)?.outcomes['draw-doom:tenure-1']?.cells[0].text).toBe('You are eaten by a grue.');

		// Alice cannot draw twice; Bob still must.
		expect(advanceFiniteProcedure(state, {}, ctxFor(ALICE))).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });

		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(BOB)));
		expect(readFiniteProcedure(state)?.outcomes['draw-doom:tenure-2']?.cells[0].text).toContain('You make it back to the surface');

		state = unwrap(completeFiniteProcedure(state, ctxFor(GM)));
		expect(state.playerDiscard).toEqual(expect.arrayContaining(['cups-ii', 'swords-page']));
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});
});
