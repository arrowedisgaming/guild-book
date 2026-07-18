import { describe, expect, it } from 'vitest';
import { legalCommandsForActor, reduceSession, type ReduceContext } from '$lib/engine/session/reducer';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { makeRng } from '$lib/engine/rng';
import { fixtureWithHands, makeSessionCatalogFixture, makeSessionFixture } from '../../fixtures/session';
import type { SessionActor, SessionCommand, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const PLAYER_A: SessionActor = { kind: 'player', userId: 'playerA' };
const PLAYER_B: SessionActor = { kind: 'player', userId: 'playerB' };
const PLAYER_C: SessionActor = { kind: 'player', userId: 'playerC' };

function ctx(actor: SessionActor, catalog: TarotCardCatalog, seed = 'reducer-test'): ReduceContext {
	return { actor, runtime: { catalog }, rng: makeRng(seed) };
}

/** Redistributes `state.majorDraw`'s 21 cards across draw/discard/gmHand,
 * preserving total conservation, to set up deck-exhaustion scenarios
 * deterministically. */
function partitionMajor(state: SessionEngineStateV1, drawCount: number, discardCount: number): SessionEngineStateV1 {
	const all = state.majorDraw.slice();
	const majorDraw = all.slice(0, drawCount);
	const majorDiscard = all.slice(drawCount, drawCount + discardCount);
	const held = all.slice(drawCount + discardCount);
	return { ...state, majorDraw, majorDiscard, gmHand: state.gmHand.concat(held) };
}

/** Moves `topCardIds` to the front of `playerDraw` without changing which
 * cards exist or their deck — used to make a specific draw deterministic
 * (e.g. drawing the Fool). */
function withPlayerDrawTop(state: SessionEngineStateV1, topCardIds: string[]): SessionEngineStateV1 {
	const rest = state.playerDraw.filter((id) => !topCardIds.includes(id));
	return { ...state, playerDraw: [...topCardIds, ...rest] };
}

describe('legalCommandsForActor', () => {
	it('grants the GM all 15 command types', () => {
		expect(legalCommandsForActor(GM)).toHaveLength(15);
	});

	it('withholds the six GM-only structural commands from a player', () => {
		const legal = legalCommandsForActor(PLAYER_A);
		expect(legal).toHaveLength(9);
		for (const gmOnly of ['deal', 'begin-procedure', 'advance-procedure', 'complete-procedure', 'end-round', 'apply-correction']) {
			expect(legal).not.toContain(gmOnly);
		}
	});
});

describe('reduceSession — coarse role gate', () => {
	const catalog = makeSessionCatalogFixture();
	const state = makeSessionFixture();

	const gmOnlyCommands: SessionCommand[] = [
		{ type: 'deal', deck: 'major', destinationZoneIds: ['gmHand'], countPerDestination: 1 },
		{ type: 'begin-procedure', procedureId: 'augury' },
		{ type: 'advance-procedure', procedureId: 'augury' },
		{ type: 'complete-procedure', procedureId: 'augury' },
		{ type: 'end-round' },
		{ type: 'apply-correction', targetEventId: 'evt-1', note: 'fix' }
	];

	it.each(gmOnlyCommands)('rejects a player issuing %o before touching state', (command) => {
		const result = reduceSession(state, command, ctx(PLAYER_A, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});
});

describe('reduceSession — draw', () => {
	const catalog = makeSessionCatalogFixture();

	it('lets the GM draw from the major deck into the GM hand', () => {
		const state = makeSessionFixture();
		const before = state.majorDraw.length;
		const result = reduceSession(state, { type: 'draw', deck: 'major', destinationZoneId: 'gmHand', count: 2 }, ctx(GM, catalog));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.majorDraw).toHaveLength(before - 2);
		expect(result.state.gmHand).toHaveLength(2);
		expect(() => assertSessionInvariants(result.state, catalog)).not.toThrow();

		const event = result.events[0];
		expect(event.kind).toBe('card-drawn');
		expect(JSON.stringify(event.publicPayload)).not.toMatch(/major-|magician|hierophant|fool/);
		expect(event.privatePayloads?.[GM.userId]).toBeDefined();
	});

	it('lets a player draw into their own private hand', () => {
		const state = fixtureWithHands({ playerA: [] });
		const result = reduceSession(
			state,
			{ type: 'draw', deck: 'player', destinationZoneId: 'hand:playerA', count: 1 },
			ctx(PLAYER_A, catalog)
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const hand = result.state.privateZones.find((z) => z.id === 'hand:playerA');
		expect(hand?.cards).toHaveLength(1);
	});

	it('rejects a player drawing into another player\'s hand', () => {
		const state = fixtureWithHands({ playerA: [], playerB: [] });
		const result = reduceSession(
			state,
			{ type: 'draw', deck: 'player', destinationZoneId: 'hand:playerB', count: 1 },
			ctx(PLAYER_A, catalog)
		);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('rejects an unknown destination zone', () => {
		const state = makeSessionFixture();
		const result = reduceSession(state, { type: 'draw', deck: 'major', destinationZoneId: 'nope', count: 1 }, ctx(GM, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a deck/zone mismatch', () => {
		const state = makeSessionFixture();
		const result = reduceSession(state, { type: 'draw', deck: 'player', destinationZoneId: 'gmHand', count: 1 }, ctx(GM, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a draw that exceeds draw pile plus discard pile', () => {
		const state = partitionMajor(makeSessionFixture(), 2, 1);
		const result = reduceSession(state, { type: 'draw', deck: 'major', destinationZoneId: 'gmHand', count: 5 }, ctx(GM, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		if (!result.ok) expect(result.rejection.message).toMatch(/3 available/);
	});

	it('reshuffles the discard pile into the draw pile when the draw pile alone is insufficient', () => {
		const state = partitionMajor(makeSessionFixture(), 2, 5); // 2 in draw, 5 in discard, 14 already held in gmHand
		const result = reduceSession(state, { type: 'draw', deck: 'major', destinationZoneId: 'gmHand', count: 4 }, ctx(GM, catalog));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.majorDiscard).toHaveLength(0);
		expect(result.state.majorDraw).toHaveLength(3); // (2 + 5) - 4 drawn
		expect(result.state.gmHand).toHaveLength(14 + 4);
		expect(result.events[0].publicPayload).toMatchObject({ reshuffled: true });
		expect(() => assertSessionInvariants(result.state, catalog)).not.toThrow();
	});

	it('schedules both decks for a boundary reshuffle when the Fool is drawn', () => {
		const state = withPlayerDrawTop(fixtureWithHands({ playerA: [] }), ['fool']);
		const result = reduceSession(
			state,
			{ type: 'draw', deck: 'player', destinationZoneId: 'hand:playerA', count: 1 },
			ctx(PLAYER_A, catalog)
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.reshuffleAtBoundary).toEqual({ major: true, player: true });
	});
});

describe('reduceSession — deal', () => {
	const catalog = makeSessionCatalogFixture();

	it('lets the GM deal to multiple private hands with per-recipient private payloads', () => {
		const state = fixtureWithHands({ playerA: [], playerB: [] });
		const result = reduceSession(
			state,
			{ type: 'deal', deck: 'player', destinationZoneIds: ['hand:playerA', 'hand:playerB'], countPerDestination: 2 },
			ctx(GM, catalog)
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.privateZones.find((z) => z.id === 'hand:playerA')?.cards).toHaveLength(2);
		expect(result.state.privateZones.find((z) => z.id === 'hand:playerB')?.cards).toHaveLength(2);
		const event = result.events[0];
		expect(event.privatePayloads?.playerA).toBeDefined();
		expect(event.privatePayloads?.playerB).toBeDefined();
		expect(JSON.stringify(event.publicPayload)).not.toMatch(/cups-|swords-|wands-|pentacles-|fool/);
		expect(() => assertSessionInvariants(result.state, catalog)).not.toThrow();
	});

	it('discloses every batch privately when the same destination repeats in one deal', () => {
		const state = fixtureWithHands({ playerA: [] });
		const result = reduceSession(
			state,
			{ type: 'deal', deck: 'player', destinationZoneIds: ['hand:playerA', 'hand:playerA'], countPerDestination: 1 },
			ctx(GM, catalog)
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.privateZones.find((z) => z.id === 'hand:playerA')?.cards).toHaveLength(2);
		const batches = result.events[0].privatePayloads?.playerA as Array<{ zoneId: string; cardIds: string[] }>;
		expect(batches).toHaveLength(2);
		expect(batches.flatMap((b) => b.cardIds)).toHaveLength(2);
	});

	it('rejects an unknown destination among several', () => {
		const state = fixtureWithHands({ playerA: [] });
		const result = reduceSession(
			state,
			{ type: 'deal', deck: 'player', destinationZoneIds: ['hand:playerA', 'nope'], countPerDestination: 1 },
			ctx(GM, catalog)
		);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a deck/zone mismatch on any destination', () => {
		const state = fixtureWithHands({ playerA: [] });
		const result = reduceSession(
			state,
			{ type: 'deal', deck: 'major', destinationZoneIds: ['hand:playerA'], countPerDestination: 1 },
			ctx(GM, catalog)
		);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a deal that cannot be satisfied even with a reshuffle', () => {
		const state = partitionMajor(fixtureWithHands({ playerA: [] }), 1, 0);
		const result = reduceSession(
			state,
			{ type: 'deal', deck: 'major', destinationZoneIds: ['gmHand'], countPerDestination: 99 },
			ctx(GM, catalog)
		);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});
});

describe('reduceSession — play / place-facedown / discard / transfer / select-from-discard', () => {
	const catalog = makeSessionCatalogFixture();

	it('lets a player play their own card into a public zone, disclosing its identity publicly', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		state.publicZones.push({ id: 'played:round-1', kind: 'played', cards: [] });

		const result = reduceSession(
			state,
			{ type: 'play', sourceZoneId: 'hand:playerA', cardId: 'cups-i', destinationZoneId: 'played:round-1' },
			ctx(PLAYER_A, catalog)
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.privateZones.find((z) => z.id === 'hand:playerA')?.cards).toEqual([]);
		expect(result.state.publicZones.find((z) => z.id === 'played:round-1')?.cards).toEqual(['cups-i']);
		expect(result.events[0].publicPayload).toMatchObject({ cardIds: ['cups-i'] });
		expect(() => assertSessionInvariants(result.state, catalog)).not.toThrow();
	});

	it('lets a player discard their own card into the shared discard pile', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const result = reduceSession(
			state,
			{ type: 'discard', sourceZoneId: 'hand:playerA', cardId: 'cups-i', destinationZoneId: 'playerDiscard' },
			ctx(PLAYER_A, catalog)
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.playerDiscard).toEqual(['cups-i']);
	});

	it('rejects moving another player\'s private card (Step 1 example)', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'], playerB: ['swords-x'] });
		const result = reduceSession(
			state,
			{ type: 'discard', sourceZoneId: 'hand:playerB', cardId: 'swords-x', destinationZoneId: 'playerDiscard' },
			ctx(PLAYER_A, catalog)
		);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('rejects a player transferring their own card into another player\'s hand, but allows the GM to', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'], playerB: [] });
		const command = {
			type: 'transfer' as const,
			sourceZoneId: 'hand:playerA',
			cardId: 'cups-i',
			destinationZoneId: 'hand:playerB'
		};

		const byPlayer = reduceSession(state, command, ctx(PLAYER_A, catalog));
		expect(byPlayer).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });

		const byGm = reduceSession(state, command, ctx(GM, catalog));
		expect(byGm.ok).toBe(true);
		if (!byGm.ok) return;
		expect(byGm.state.privateZones.find((z) => z.id === 'hand:playerB')?.cards).toEqual(['cups-i']);
		expect(byGm.events[0].privatePayloads?.playerB).toBeDefined();
		expect(JSON.stringify(byGm.events[0].publicPayload)).not.toContain('cups-i');
	});

	it('lets any actor select-from-discard because the pile is public-top, not private', () => {
		// Fixture setup teleports 'cups-i' straight from the draw pile into the
		// discard pile — conservation-safe (still exactly one instance)
		// without needing a prior `discard` command.
		const base = fixtureWithHands({ playerA: [], playerC: [] });
		const discarded = { ...base, playerDraw: base.playerDraw.filter((id) => id !== 'cups-i'), playerDiscard: ['cups-i'] };

		const result = reduceSession(
			discarded,
			{ type: 'select-from-discard', sourceZoneId: 'playerDiscard', cardId: 'cups-i', destinationZoneId: 'hand:playerC' },
			ctx(PLAYER_C, catalog)
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.privateZones.find((z) => z.id === 'hand:playerC')?.cards).toEqual(['cups-i']);
		expect(result.state.playerDiscard).toEqual([]);
	});

	it('rejects a content-mismatched card id without ever touching state', () => {
		const state = fixtureWithHands({ playerA: [] });
		const result = reduceSession(
			state,
			{ type: 'play', sourceZoneId: 'hand:playerA', cardId: 'not-a-real-card', destinationZoneId: 'playerDiscard' },
			ctx(PLAYER_A, catalog)
		);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'content-mismatch' } });
	});

	it('rejects a card that is not actually present in the source zone, without naming it', () => {
		const state = fixtureWithHands({ playerA: [] });
		const result = reduceSession(
			state,
			{ type: 'play', sourceZoneId: 'hand:playerA', cardId: 'wands-ii', destinationZoneId: 'playerDiscard' },
			ctx(PLAYER_A, catalog)
		);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		if (!result.ok) expect(result.rejection.message).not.toContain('wands-ii');
	});

	it('rejects a cross-deck destination even when the GM is fully authorized', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const result = reduceSession(
			state,
			{ type: 'play', sourceZoneId: 'hand:playerA', cardId: 'cups-i', destinationZoneId: 'gmHand' },
			ctx(GM, catalog)
		);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects an unknown source or destination zone', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const badSource = reduceSession(
			state,
			{ type: 'play', sourceZoneId: 'nope', cardId: 'cups-i', destinationZoneId: 'playerDiscard' },
			ctx(GM, catalog)
		);
		expect(badSource).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });

		const badDestination = reduceSession(
			state,
			{ type: 'play', sourceZoneId: 'hand:playerA', cardId: 'cups-i', destinationZoneId: 'nope' },
			ctx(GM, catalog)
		);
		expect(badDestination).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});
});

describe('reduceSession — reveal', () => {
	const catalog = makeSessionCatalogFixture();

	it('lets the owner reveal their own card, disclosing it publicly', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const result = reduceSession(state, { type: 'reveal', zoneId: 'hand:playerA', cardId: 'cups-i' }, ctx(PLAYER_A, catalog));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state).toBe(state); // reveal never moves a card
		expect(result.events[0]).toMatchObject({ kind: 'card-revealed', publicPayload: { zoneId: 'hand:playerA', cardId: 'cups-i' } });
	});

	it('lets the GM reveal a card from a zone they do not own', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const result = reduceSession(state, { type: 'reveal', zoneId: 'hand:playerA', cardId: 'cups-i' }, ctx(GM, catalog));
		expect(result.ok).toBe(true);
	});

	it('rejects a non-owner player revealing another player\'s card', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'], playerB: [] });
		const result = reduceSession(state, { type: 'reveal', zoneId: 'hand:playerA', cardId: 'cups-i' }, ctx(PLAYER_B, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('rejects revealing a card not present in the zone', () => {
		const state = fixtureWithHands({ playerA: [] });
		const result = reduceSession(state, { type: 'reveal', zoneId: 'hand:playerA', cardId: 'cups-i' }, ctx(PLAYER_A, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects an unrecognized card id', () => {
		const state = fixtureWithHands({ playerA: [] });
		const result = reduceSession(state, { type: 'reveal', zoneId: 'hand:playerA', cardId: 'not-a-real-card' }, ctx(PLAYER_A, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'content-mismatch' } });
	});

	it('rejects an unknown zone', () => {
		const state = fixtureWithHands({ playerA: [] });
		const result = reduceSession(state, { type: 'reveal', zoneId: 'nope', cardId: 'cups-i' }, ctx(PLAYER_A, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});
});

describe('reduceSession — reorder-top', () => {
	const catalog = makeSessionCatalogFixture();

	it('lets the GM reorder the top cards of a hidden pile without disclosing identities publicly', () => {
		const state = makeSessionFixture();
		const top2 = state.majorDraw.slice(0, 2);
		const reversed = [...top2].reverse();

		const result = reduceSession(state, { type: 'reorder-top', zoneId: 'majorDraw', cardIds: reversed }, ctx(GM, catalog));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.majorDraw.slice(0, 2)).toEqual(reversed);
		expect(JSON.stringify(result.events[0].publicPayload)).not.toMatch(/magician|hierophant|fool|-i$/);
		expect(result.events[0].privatePayloads?.[GM.userId]).toMatchObject({ cardIds: reversed });
	});

	it('rejects a player reordering a hidden pile', () => {
		const state = makeSessionFixture();
		const top2 = state.majorDraw.slice(0, 2);
		const result = reduceSession(state, { type: 'reorder-top', zoneId: 'majorDraw', cardIds: top2 }, ctx(PLAYER_A, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('rejects reordering an unordered zone', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const result = reduceSession(state, { type: 'reorder-top', zoneId: 'hand:playerA', cardIds: ['cups-i'] }, ctx(PLAYER_A, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a reorder set that does not match the current top cards', () => {
		const state = makeSessionFixture();
		const result = reduceSession(
			state,
			{ type: 'reorder-top', zoneId: 'majorDraw', cardIds: ['not-a-real-major'] },
			ctx(GM, catalog)
		);
		// unrecognized card id is checked before the multiset comparison
		expect(result).toMatchObject({ ok: false, rejection: { code: 'content-mismatch' } });
	});

	it('rejects a reorder set of real cards that are not actually on top', () => {
		const state = partitionMajor(makeSessionFixture(), 0, 0); // majorDraw now empty, all majors in gmHand
		const anyMajor = Object.values(makeSessionCatalogFixture()).find((c) => c.deck === 'major')!.id;
		const result = reduceSession(state, { type: 'reorder-top', zoneId: 'majorDraw', cardIds: [anyMajor] }, ctx(GM, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});
});

describe('reduceSession — mulligan', () => {
	const catalog = makeSessionCatalogFixture();

	it('discards the whole hand and redraws the same count for its owner', () => {
		const state = fixtureWithHands({ playerA: ['cups-i', 'swords-x'] });
		const result = reduceSession(state, { type: 'mulligan', zoneId: 'hand:playerA' }, ctx(PLAYER_A, catalog));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.playerDiscard).toEqual(expect.arrayContaining(['cups-i', 'swords-x']));
		expect(result.state.privateZones.find((z) => z.id === 'hand:playerA')?.cards).toHaveLength(2);
		expect(() => assertSessionInvariants(result.state, catalog)).not.toThrow();
	});

	it('rejects mulligan against a deck\'s own draw/discard pile (self-reference would double-count cards)', () => {
		const state = makeSessionFixture();
		const result = reduceSession(state, { type: 'mulligan', zoneId: 'majorDraw' }, ctx(GM, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects mulligan on a mixed-deck zone', () => {
		const state = makeSessionFixture();
		state.publicZones.push({ id: 'initiative:round-1', kind: 'initiative', cards: [] });
		const result = reduceSession(state, { type: 'mulligan', zoneId: 'initiative:round-1' }, ctx(GM, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a non-owner mulligan', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'], playerB: [] });
		const result = reduceSession(state, { type: 'mulligan', zoneId: 'hand:playerA' }, ctx(PLAYER_B, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('always has enough cards to redraw, even from an empty draw pile — the mulliganed cards join the eligible pool first', () => {
		const base = fixtureWithHands({ playerA: ['cups-i', 'swords-x'] });
		// Move the rest of the player draw pile into the discard pile (still
		// 'player' deck, still conserved) so `playerDraw` itself is empty.
		const state = { ...base, playerDraw: [], playerDiscard: [...base.playerDiscard, ...base.playerDraw] };
		const result = reduceSession(state, { type: 'mulligan', zoneId: 'hand:playerA' }, ctx(PLAYER_A, catalog));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.privateZones.find((z) => z.id === 'hand:playerA')?.cards).toHaveLength(2);
		expect(() => assertSessionInvariants(result.state, catalog)).not.toThrow();
	});

	it('schedules both decks for reshuffle when a mulligan redraws the Fool', () => {
		const state = withPlayerDrawTop(fixtureWithHands({ playerA: ['cups-i'] }), ['fool']);
		const result = reduceSession(state, { type: 'mulligan', zoneId: 'hand:playerA' }, ctx(PLAYER_A, catalog));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.reshuffleAtBoundary).toEqual({ major: true, player: true });
	});
});

describe('reduceSession — procedure lifecycle', () => {
	const catalog = makeSessionCatalogFixture();

	it('begins, advances, and completes a procedure', () => {
		const started = reduceSession(makeSessionFixture(), { type: 'begin-procedure', procedureId: 'augury' }, ctx(GM, catalog));
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(started.state.procedure).toEqual({ procedureId: 'augury', stepIndex: 0, pendingZoneIds: [] });

		const advanced = reduceSession(started.state, { type: 'advance-procedure', procedureId: 'augury' }, ctx(GM, catalog));
		expect(advanced.ok).toBe(true);
		if (!advanced.ok) return;
		expect(advanced.state.procedure?.stepIndex).toBe(1);

		const completed = reduceSession(advanced.state, { type: 'complete-procedure', procedureId: 'augury' }, ctx(GM, catalog));
		expect(completed.ok).toBe(true);
		if (!completed.ok) return;
		expect(completed.state.procedure).toBeNull();
	});

	it('rejects beginning a procedure while one is already active', () => {
		const started = reduceSession(makeSessionFixture(), { type: 'begin-procedure', procedureId: 'augury' }, ctx(GM, catalog));
		if (!started.ok) throw new Error('setup failed');
		const result = reduceSession(started.state, { type: 'begin-procedure', procedureId: 'high-chant' }, ctx(GM, catalog));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects advancing/completing a procedure id that does not match the active one', () => {
		const started = reduceSession(makeSessionFixture(), { type: 'begin-procedure', procedureId: 'augury' }, ctx(GM, catalog));
		if (!started.ok) throw new Error('setup failed');

		const advanced = reduceSession(started.state, { type: 'advance-procedure', procedureId: 'high-chant' }, ctx(GM, catalog));
		expect(advanced).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });

		const completed = reduceSession(started.state, { type: 'complete-procedure', procedureId: 'high-chant' }, ctx(GM, catalog));
		expect(completed).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects advancing/completing when no procedure is active', () => {
		const state = makeSessionFixture();
		expect(reduceSession(state, { type: 'advance-procedure', procedureId: 'augury' }, ctx(GM, catalog))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
		expect(reduceSession(state, { type: 'complete-procedure', procedureId: 'augury' }, ctx(GM, catalog))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});
});

describe('reduceSession — end-round', () => {
	const catalog = makeSessionCatalogFixture();

	it('is a no-op reshuffle when no deck was scheduled', () => {
		const state = makeSessionFixture();
		const result = reduceSession(state, { type: 'end-round' }, ctx(GM, catalog));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.events[0].publicPayload).toMatchObject({ reshuffledDecks: [] });
		expect(result.state.reshuffleAtBoundary).toEqual({ major: false, player: false });
	});

	it('reshuffles both decks and clears both flags when both were scheduled', () => {
		const state = { ...makeSessionFixture(), reshuffleAtBoundary: { major: true, player: true } };
		const result = reduceSession(state, { type: 'end-round' }, ctx(GM, catalog));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.events[0].publicPayload).toMatchObject({ reshuffledDecks: ['major', 'player'] });
		expect(result.state.reshuffleAtBoundary).toEqual({ major: false, player: false });
		expect(() => assertSessionInvariants(result.state, catalog)).not.toThrow();
	});
});

describe('reduceSession — apply-correction', () => {
	const catalog = makeSessionCatalogFixture();

	it('records a GM audit event without mutating state', () => {
		const state = makeSessionFixture();
		const result = reduceSession(
			state,
			{ type: 'apply-correction', targetEventId: 'evt-42', note: 'undid a misclick' },
			ctx(GM, catalog)
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state).toBe(state);
		expect(result.events[0]).toMatchObject({
			kind: 'correction-applied',
			publicPayload: { targetEventId: 'evt-42', note: 'undid a misclick' }
		});
	});
});
