import { describe, expect, it } from 'vitest';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { makeSessionCatalogFixture, makeSessionFixture } from '../../fixtures/session';

describe('session card invariants', () => {
	it('accepts one location for all 78 cards', () => {
		const catalog = makeSessionCatalogFixture();
		expect(() => assertSessionInvariants(makeSessionFixture(), catalog)).not.toThrow();
	});

	it('rejects duplicate and missing card ids', () => {
		const catalog = makeSessionCatalogFixture();

		const duplicate = makeSessionFixture();
		duplicate.playerDiscard.push(duplicate.playerDraw[0]);
		expect(() => assertSessionInvariants(duplicate, catalog)).toThrow(/duplicate card/i);

		const missing = makeSessionFixture();
		missing.playerDraw.pop();
		expect(() => assertSessionInvariants(missing, catalog)).toThrow(/missing card/i);
	});

	it('rejects a card placed in a zone of the wrong deck', () => {
		// The invariant is deck MEMBERSHIP, not card kind: the Fool is a
		// major-arcana card that legitimately lives in the player deck. A
		// genuine major (popped off the major draw pile) is illegal in the
		// player-only draw zone.
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		const major = state.majorDraw.pop();
		if (!major) throw new Error('major fixture empty');
		state.playerDraw.push(major);
		expect(() => assertSessionInvariants(state, catalog)).toThrow(/wrong deck/i);
	});

	it('rejects a major-arcana card placed in an inspiration public zone', () => {
		// `inspiration` is declared player-deck only (High Chant distributes
		// inspiration from the player discard — spec §8.7), unlike the
		// genuinely mixed `initiative`/`played`/`revealed` public zones.
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		const major = state.majorDraw.pop();
		if (!major) throw new Error('major fixture empty');
		state.publicZones.push({ id: 'inspiration:pool', kind: 'inspiration', cards: [major] });
		expect(() => assertSessionInvariants(state, catalog)).toThrow(/wrong deck/i);
	});

	it('rejects a duplicate zone id across session zones', () => {
		// T1 minor finding: this branch previously had no dedicated test.
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		state.privateZones.push(
			{ id: 'dup', kind: 'player-hand', ownerUserId: 'user-a', cards: [] },
			{ id: 'dup', kind: 'player-hand', ownerUserId: 'user-b', cards: [] }
		);
		expect(() => assertSessionInvariants(state, catalog)).toThrow(/duplicate zone id/i);
	});

	it('rejects a private zone missing a recipient owner', () => {
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		state.privateZones.push({ id: 'hand:orphan', kind: 'player-hand', ownerUserId: '', cards: [] });
		expect(() => assertSessionInvariants(state, catalog)).toThrow(/missing a recipient owner/i);
	});

	it('rejects a private zone with an illegal kind', () => {
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		state.privateZones.push({
			id: 'hand:bad-kind',
			// @ts-expect-error deliberately illegal for this invariant test
			kind: 'not-a-real-kind',
			ownerUserId: 'user-a',
			cards: []
		});
		expect(() => assertSessionInvariants(state, catalog)).toThrow(/illegal kind/i);
	});

	it('rejects a public zone with an illegal kind', () => {
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		state.publicZones.push({
			id: 'public:bad-kind',
			// @ts-expect-error deliberately illegal for this invariant test
			kind: 'not-a-real-kind',
			cards: []
		});
		expect(() => assertSessionInvariants(state, catalog)).toThrow(/illegal kind/i);
	});

	it('rejects a card id that is not present in the card catalog', () => {
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		state.majorDraw.push('not-a-real-card');
		expect(() => assertSessionInvariants(state, catalog)).toThrow(/unrecognized card id/i);
	});

	it('rejects a session version that is not a non-negative integer', () => {
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		state.version = -1;
		expect(() => assertSessionInvariants(state, catalog)).toThrow(/version/i);
	});

	it('rejects a procedure that references an unknown pending zone', () => {
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		state.procedure = { procedureId: 'augury', stepIndex: 0, pendingZoneIds: ['pending:missing'] };
		expect(() => assertSessionInvariants(state, catalog)).toThrow(/pending zone/i);
	});

	it('accepts a procedure whose pending zone references resolve', () => {
		const catalog = makeSessionCatalogFixture();
		const state = makeSessionFixture();
		const cardId = state.playerDraw.pop();
		if (!cardId) throw new Error('player fixture empty');
		state.pendingZones.push({ id: 'pending:augury', deck: 'player', cards: [cardId] });
		state.procedure = { procedureId: 'augury', stepIndex: 0, pendingZoneIds: ['pending:augury'] };
		expect(() => assertSessionInvariants(state, catalog)).not.toThrow();
	});
});
