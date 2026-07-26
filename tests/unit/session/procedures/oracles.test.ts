/**
 * Increment 4 Task 4 Step 1 — the coverage matrix for the oracle, City, and
 * sorcery procedures, one named test per audited procedure. Every one runs the
 * DATA-DRIVEN finite runner against the real content pack: the runner maps each
 * validated content step to one generic card command, and these tests assert
 * actor, deck, count, visibility, legal zone transitions, boundary, and the
 * RESOLVED outcome text (per the amendment: oracles resolve their tables — the
 * app supplies the rule text, the GM adjudicates the fictional consequence).
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

function ctxFor(actor: SessionActor, seed = 'oracles'): FiniteReduceContext {
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

describe('oracle coverage matrix', () => {
	it('Maleficence — the GM draws against the realm’s own table and the cell text is the outcome', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-i']);
		state = unwrap(
			beginFiniteProcedure(state, { procedureId: 'oracle-maleficence', mode: 'appropriate-realm', realmTableId: 'maleficence-wastes' }, ctxFor(GM))
		);

		// The applicable-realm step is the GM's; the random-realm step is skipped.
		const advanced = advanceFiniteProcedure(state, {}, ctxFor(GM));
		state = unwrap(advanced);

		const runner = readFiniteProcedure(state);
		expect(runner?.outcomes['draw-applicable-maleficence']).toMatchObject({
			tableId: 'maleficence-wastes',
			cells: [expect.objectContaining({ text: expect.stringContaining('imps appear') })]
		});
		// The resolved outcome is public, with its Appendix C reference typed.
		const resolved = eventsOf(advanced).find((event) => event.kind === 'finite-step-resolved');
		expect(resolved?.publicPayload).toMatchObject({
			procedureId: 'oracle-maleficence',
			outcome: expect.objectContaining({
				cells: [expect.objectContaining({ references: [expect.objectContaining({ collection: 'denizens', entryId: 'imp' })] })]
			})
		});
		expect(resolved?.privatePayloads).toBeUndefined();
	});

	it('Maleficence — random mode lets the PLAYER draw and the realm comes from the rng', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-i']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'oracle-maleficence', mode: 'random-realm', actorTenureId: 'tenure-1' }, ctxFor(GM)));

		// The GM may not draw the player's step.
		expect(advanceFiniteProcedure(state, {}, ctxFor(GM))).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });

		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(ALICE)));
		const outcome = readFiniteProcedure(state)?.outcomes['draw-random-maleficence'];
		expect(outcome?.tableId).toMatch(/^maleficence-(wastes|weald|weird|welkin)$/);
	});

	it('Malediction — the drawn curse resolves its row, and the delayed step is the flat 50% manual gate', () => {
		// swords-i is numeral I -> the City Dogs curse, whose delayed clause is a
		// 50% chance the runner must express as a MANUAL yes/no, never a draw.
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-i']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'oracle-malediction' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));

		expect(readFiniteProcedure(state)?.outcomes['draw-curse']).toMatchObject({ tableId: 'malediction' });

		const before = state;
		const gated = advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(GM));
		state = unwrap(gated);

		// The 50% gate moved NO cards: both deck orders are byte-identical.
		expect(state.playerDraw).toEqual(before.playerDraw);
		expect(state.majorDraw).toEqual(before.majorDraw);
		expect(state.playerDiscard).toEqual(before.playerDiscard);
		expect(state.majorDiscard).toEqual(before.majorDiscard);
		expect(readFiniteProcedure(state)?.manual['delayed-city-dogs']).toBe('yes');
		// The I-keyed delayed step ran; the II/III/IX ones were skipped as
		// inapplicable, so the procedure is now past every step.
		expect(readFiniteProcedure(state)?.completedSteps).toContain('delayed-city-dogs');
	});

	it('Random Totem — the 14×4 grid resolves by rank row and suit column', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['wands-iii']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'oracle-random-totem', actorTenureId: 'tenure-1' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(ALICE)));

		expect(readFiniteProcedure(state)?.outcomes['draw-totem']).toMatchObject({
			tableId: 'random-totem',
			cells: [expect.objectContaining({ columnId: 'wands', text: 'Centipede, Dire' })]
		});
	});

	it('GM twist — consults the minor discard top WITHOUT consuming it', () => {
		let state = withMinorDiscardTop(makeSessionFixture(), 'cups-v');
		const discardBefore = state.playerDiscard.slice();
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'gm-twist' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));

		// consume: false — the card stays exactly where it was.
		expect(state.playerDiscard).toEqual(discardBefore);
		expect(readFiniteProcedure(state)?.outcomes['consult-discard-top']).toMatchObject({ tableId: 'gm-twist' });
	});

	it('GM twist — rejects with an empty discard rather than inventing a card', () => {
		let state = unwrap(beginFiniteProcedure(makeSessionFixture(), { procedureId: 'gm-twist' }, ctxFor(GM)));

		expect(advanceFiniteProcedure(state, {}, ctxFor(GM))).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('Disposition — the discard top resolves the starting-disposition band', () => {
		// cups-v is numeral V -> the V–VI band, "Sadness".
		let state = withMinorDiscardTop(makeSessionFixture(), 'cups-v');
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'denizen-disposition' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));

		expect(readFiniteProcedure(state)?.outcomes['consult-discard-top']).toMatchObject({
			cells: [expect.objectContaining({ text: 'Sadness' })]
		});
	});

	it('City Doomsaying — four draws read the suit-by-step prophecy left to right', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-ii', 'pentacles-ix', 'cups-iv', 'wands-knight']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'city-doomsaying', actorTenureId: 'tenure-1' }, ctxFor(GM)));

		// pay-fee is the player's manual confirmation; drawing before it is illegal.
		expect(advanceFiniteProcedure(state, {}, ctxFor(ALICE))).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(ALICE)));

		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(ALICE)));
		const outcome = readFiniteProcedure(state)?.outcomes['draw-prophecy'];
		expect(outcome?.cells.map((cell) => cell.columnId)).toEqual(['step-1', 'step-2', 'step-3', 'step-4']);
		expect(outcome?.cells[0].text).toContain('Constellation of the Beast');
		expect(outcome?.cells[3].text).toContain('the Clarion of Altheia');

		// All four cards landed face-up in the procedure's public zone.
		expect(findZoneDescriptor(state, finiteZoneId('city-doomsaying'))?.cards).toHaveLength(4);
	});

	it('Strange Communions — a manual choice, recipient-private, no deck mutation', () => {
		const base = makeSessionFixture();
		let state = unwrap(beginFiniteProcedure(base, { procedureId: 'city-strange-communions', actorTenureId: 'tenure-1' }, ctxFor(GM)));
		const advanced = advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(ALICE));
		state = unwrap(advanced);

		expect(state.playerDraw).toEqual(base.playerDraw);
		expect(state.majorDraw).toEqual(base.majorDraw);
		expect(readFiniteProcedure(state)?.manual['choose-source']).toBe('yes');
	});

	it('As Above, So Below — the player reorders the top three of the minor deck, privately', () => {
		const base = makeSessionFixture();
		const [a, b, c] = base.playerDraw.slice(0, 3);
		let state = unwrap(beginFiniteProcedure(base, { procedureId: 'city-as-above-so-below', actorTenureId: 'tenure-1' }, ctxFor(GM)));

		// Bob may not reorder Alice's reading.
		expect(advanceFiniteProcedure(state, { orderedCardIds: [c, a, b] }, ctxFor(BOB))).toMatchObject({
			ok: false,
			rejection: { code: 'not-authorized' }
		});

		const advanced = advanceFiniteProcedure(state, { orderedCardIds: [c, a, b] }, ctxFor(ALICE));
		state = unwrap(advanced);

		expect(state.playerDraw.slice(0, 3)).toEqual([c, a, b]);
		// The new order reaches only the acting player — the public event carries
		// a count, never the identities.
		const reordered = eventsOf(advanced).find((event) => event.kind === 'zone-reordered');
		expect(JSON.stringify(reordered?.publicPayload)).not.toContain(a);
		expect(Object.keys(reordered?.privatePayloads ?? {})).toEqual(['user-alice']);
	});

	it('Test Augury — the GM’s draw stays private until accepted, and declining discards it unseen-then-public', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-ix']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'test-augury', actorTenureId: 'tenure-1' }, ctxFor(GM)));

		// Step 1: the GM draws privately — the public event carries a count only.
		const drawn = advanceFiniteProcedure(state, {}, ctxFor(GM));
		state = unwrap(drawn);
		const drawEvent = eventsOf(drawn).find((event) => event.kind === 'card-drawn');
		expect(JSON.stringify(drawEvent?.publicPayload)).not.toContain('cups-ix');
		expect(drawEvent?.privatePayloads?.['gm-1']).toMatchObject({ cardIds: ['cups-ix'] });

		// Step 2: the parable is described (GM manual), step 3: the player chooses.
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(ALICE)));

		// Step 4: accepting reveals the card publicly (skipping decline-card).
		const accepted = advanceFiniteProcedure(state, { stepId: 'accept-card' }, ctxFor(GM));
		state = unwrap(accepted);
		const revealEvent = eventsOf(accepted).find((event) => JSON.stringify(event.publicPayload).includes('cups-ix'));
		expect(revealEvent).toBeDefined();

		state = unwrap(completeFiniteProcedure(state, ctxFor(GM)));
		expect(state.playerDiscard).toContain('cups-ix');
		expect(readFiniteProcedure(state)).toBeUndefined();
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('Test Augury — declining routes the card to the discard instead', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-ix']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'test-augury', actorTenureId: 'tenure-1' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'no' }, ctxFor(ALICE)));

		state = unwrap(advanceFiniteProcedure(state, { stepId: 'decline-card' }, ctxFor(GM)));

		expect(state.playerDiscard[0]).toBe('cups-ix');
		state = unwrap(completeFiniteProcedure(state, ctxFor(GM)));
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('the flat 50% manual branch never draws a tarot card', () => {
		// The malediction delayed clause IS the audited flat-50% case: reducer
		// state and both deck orders stay byte-identical across the command
		// except for procedure/log metadata.
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-ii']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'oracle-malediction' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));
		const before = state;

		const gated = advanceFiniteProcedure(state, { confirm: 'no' }, ctxFor(GM));
		const after = unwrap(gated);

		expect(after.playerDraw).toEqual(before.playerDraw);
		expect(after.playerDiscard).toEqual(before.playerDiscard);
		expect(after.majorDraw).toEqual(before.majorDraw);
		expect(after.majorDiscard).toEqual(before.majorDiscard);
		expect(after.privateZones).toEqual(before.privateZones);
		expect(after.publicZones).toEqual(before.publicZones);
		expect(eventsOf(gated).some((event) => event.kind === 'card-drawn')).toBe(false);
	});

	it('a Fool drawn on a lookup step is set aside and redrawn, with the reshuffle left at the boundary', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['fool', 'wands-iii']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'oracle-random-totem', actorTenureId: 'tenure-1' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(ALICE)));

		// The Fool has no oracle entry (it is the deck's reset card): the redraw
		// resolves the totem, the Fool waits in the zone for the completion
		// discard, and the reshuffle stays scheduled for end-round.
		expect(readFiniteProcedure(state)?.outcomes['draw-totem']?.cells[0].text).toBe('Centipede, Dire');
		expect(findZoneDescriptor(state, finiteZoneId('oracle-random-totem'))?.cards).toContain('fool');
		expect(state.reshuffleAtBoundary).toEqual({ major: true, player: true });
	});

	it('a second procedure cannot begin while one is in flight, and completion clears the slot', () => {
		let state = withMinorDiscardTop(makeSessionFixture(), 'cups-v');
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'gm-twist' }, ctxFor(GM)));

		expect(beginFiniteProcedure(state, { procedureId: 'denizen-disposition' }, ctxFor(GM))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});

		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));
		state = unwrap(completeFiniteProcedure(state, ctxFor(GM)));
		expect(state.procedure).toBeNull();
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('stepId may not skip a step that belongs to another actor', () => {
		// Review finding: the stepId walk marked intervening steps skipped and
		// authorized only the DESTINATION, so a player could target their own
		// later step to jump past the GM's, and the GM could target `accept-card`
		// to skip the player's choice and reveal the card.
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-ix']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'test-augury', actorTenureId: 'tenure-1' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, {}, ctxFor(GM)));

		// The next step is the GM's `describe-parable` — a SEQUENTIAL step, not a
		// fork alternative, so Alice targeting her own later `choose-course`
		// is refused as an illegal skip.
		expect(advanceFiniteProcedure(state, { stepId: 'choose-course', confirm: 'yes' }, ctxFor(ALICE))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});

		// Once the GM has taken their own step, the player's step is reachable.
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(GM)));
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(ALICE)));

		// The accept/decline pair IS a fork, so the alternative check passes — and
		// the OWNERSHIP check is what stops a player from resolving the GM's
		// branch. Both guards are load-bearing.
		expect(advanceFiniteProcedure(state, { stepId: 'decline-card' }, ctxFor(ALICE))).toMatchObject({
			ok: false,
			rejection: { code: 'not-authorized' }
		});
		// The GM may take either branch.
		expect(advanceFiniteProcedure(state, { stepId: 'decline-card' }, ctxFor(GM))).toMatchObject({ ok: true });
	});

	it('stepId may not skip a step that is not a fork alternative, even the actor’s own', () => {
		// Second-pass review: authorizing a skipped step proves ownership, not
		// that skipping is legitimate. Doomsaying's `pay-fee` and `draw-prophecy`
		// are BOTH the player's and sequential — targeting the draw must not dodge
		// the fee.
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-ii', 'pentacles-ix', 'cups-iv', 'wands-knight']);
		state = unwrap(beginFiniteProcedure(state, { procedureId: 'city-doomsaying', actorTenureId: 'tenure-1' }, ctxFor(GM)));

		expect(advanceFiniteProcedure(state, { stepId: 'draw-prophecy' }, ctxFor(ALICE))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});

		// The fee still has to be paid, and then the draw runs normally.
		state = unwrap(advanceFiniteProcedure(state, { confirm: 'yes' }, ctxFor(ALICE)));
		expect(readFiniteProcedure(state)?.manual['pay-fee']).toBe('yes');
		expect(advanceFiniteProcedure(state, {}, ctxFor(ALICE))).toMatchObject({ ok: true });
	});

	it('a player may not begin a GM oracle', () => {
		expect(beginFiniteProcedure(makeSessionFixture(), { procedureId: 'gm-twist' }, ctxFor(ALICE))).toMatchObject({
			ok: false,
			rejection: { code: 'not-authorized' }
		});
	});
});
