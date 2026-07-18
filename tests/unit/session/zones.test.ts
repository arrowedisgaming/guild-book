import { describe, expect, it } from 'vitest';
import { listZoneDescriptors } from '$lib/engine/session/zones';
import { makeSessionFixture } from '../../fixtures/session';

describe('session zone descriptors', () => {
	it('produces unique zone ids across fixed, private, public, and pending zones', () => {
		const state = makeSessionFixture();
		state.privateZones.push({ id: 'hand:player-a', kind: 'player-hand', ownerUserId: 'user-a', cards: [] });
		state.publicZones.push({ id: 'initiative:round-1', kind: 'initiative', cards: [] });
		state.pendingZones.push({ id: 'pending:augury', deck: 'major', cards: [] });

		const ids = listZoneDescriptors(state).map((zone) => zone.id);

		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(
			expect.arrayContaining([
				'majorDraw',
				'majorDiscard',
				'playerDraw',
				'playerDiscard',
				'gmHand',
				'hand:player-a',
				'initiative:round-1',
				'pending:augury'
			])
		);
	});

	it('marks each private zone with its owning player and gmHand with the GM', () => {
		const state = makeSessionFixture();
		state.privateZones.push({ id: 'hand:player-a', kind: 'player-hand', ownerUserId: 'user-a', cards: [] });

		const zones = listZoneDescriptors(state);

		expect(zones.find((zone) => zone.id === 'hand:player-a')?.owner).toEqual({
			kind: 'player',
			userId: 'user-a'
		});
		expect(zones.find((zone) => zone.id === 'gmHand')?.owner).toEqual({ kind: 'gm' });
	});

	it('marks draw/discard piles, pending zones, and initiative as ordered; hands and other public zones as unordered', () => {
		const state = makeSessionFixture();
		state.privateZones.push({ id: 'hand:player-a', kind: 'player-hand', ownerUserId: 'user-a', cards: [] });
		state.publicZones.push({ id: 'initiative:round-1', kind: 'initiative', cards: [] });
		state.publicZones.push({ id: 'played:round-1', kind: 'played', cards: [] });
		state.pendingZones.push({ id: 'pending:augury', deck: 'major', cards: [] });

		const zones = listZoneDescriptors(state);
		const orderedById = new Map(zones.map((zone) => [zone.id, zone.ordered]));

		expect(orderedById.get('majorDraw')).toBe(true);
		expect(orderedById.get('playerDiscard')).toBe(true);
		expect(orderedById.get('pending:augury')).toBe(true);
		expect(orderedById.get('gmHand')).toBe(false);
		expect(orderedById.get('hand:player-a')).toBe(false);
		// Initiative order is position-significant in HMTW Challenge resolution
		// (spec §8.2/§8.7) — unlike other public zones, it is ordered.
		expect(orderedById.get('initiative:round-1')).toBe(true);
		expect(orderedById.get('played:round-1')).toBe(false);
	});

	it('declares initiative/played/revealed as mixed-deck zones and inspiration as player-deck only', () => {
		const state = makeSessionFixture();
		state.publicZones.push({ id: 'initiative:round-1', kind: 'initiative', cards: [] });
		state.publicZones.push({ id: 'played:round-1', kind: 'played', cards: [] });
		state.publicZones.push({ id: 'revealed:round-1', kind: 'revealed', cards: [] });
		state.publicZones.push({ id: 'inspiration:pool', kind: 'inspiration', cards: [] });

		const zones = listZoneDescriptors(state);
		const deckById = new Map(zones.map((zone) => [zone.id, zone.deck]));

		expect(deckById.get('initiative:round-1')).toBe('both');
		expect(deckById.get('played:round-1')).toBe('both');
		expect(deckById.get('revealed:round-1')).toBe('both');
		expect(deckById.get('inspiration:pool')).toBe('player');
	});
});
