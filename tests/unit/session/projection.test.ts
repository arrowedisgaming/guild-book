import { describe, expect, it } from 'vitest';
import { projectForActor } from '$lib/engine/session/projection';
import { fixtureWithHands, makeSessionCatalogFixture, makeSessionFixture } from '../../fixtures/session';
import type { SessionActor, SessionGmProjection, SessionPlayerProjection } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const PLAYER_A: SessionActor = { kind: 'player', userId: 'playerA' };

describe('projectForActor — player privacy (Step 1 examples)', () => {
	const catalog = makeSessionCatalogFixture();

	it('lets a player see only their own hand identities', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'], playerB: ['swords-x'] });
		const projection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;

		expect(JSON.stringify(projection)).toContain('cups-i');
		expect(JSON.stringify(projection)).not.toContain('swords-x');
	});

	it('does not grant a GM player hand identities, and surfaces hand counts as PUBLIC (amendment 3)', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const projection = projectForActor(state, GM, catalog) as SessionGmProjection;

		expect(JSON.stringify(projection)).not.toContain('cups-i');
		expect(projection.public.playerHandCounts.playerA).toBe(1);
	});
});

describe('projectForActor — GM projection', () => {
	const catalog = makeSessionCatalogFixture();

	it('grants the GM their own hand identities and never a player\'s', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		state.gmHand = ['magician'];
		const projection = projectForActor(state, GM, catalog) as SessionGmProjection;

		expect(projection.gmHand).toEqual([{ hidden: false, id: 'magician', label: 'magician', imageKey: 'magician', value: 0 }]);
		expect(JSON.stringify(projection)).not.toContain('cups-i');
	});

	it('reports gmHandCount on the shared public projection', () => {
		const state = makeSessionFixture();
		state.gmHand = ['magician', 'high-priestess'];
		const projection = projectForActor(state, GM, catalog) as SessionGmProjection;
		expect(projection.public.gmHandCount).toBe(2);
	});
});

describe('projectForActor — player projection scoping', () => {
	const catalog = makeSessionCatalogFixture();

	it('separates hand/facedown/prepared by zone kind and excludes other owners', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		state.privateZones.push(
			{ id: 'facedown:playerA', kind: 'player-facedown', ownerUserId: 'playerA', cards: [] },
			{ id: 'prepared:playerA', kind: 'player-prepared', ownerUserId: 'playerA', cards: [] }
		);
		const cardId = state.playerDraw.pop();
		if (!cardId) throw new Error('fixture empty');
		state.privateZones.push({ id: 'facedown:playerB', kind: 'player-facedown', ownerUserId: 'playerB', cards: [cardId] });

		const projection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;

		expect(projection.privateHand.map((slot) => (slot.hidden ? null : slot.id))).toEqual(['cups-i']);
		expect(projection.privateFacedown).toEqual([]);
		expect(projection.privatePrepared).toEqual([]);
		expect(JSON.stringify(projection)).not.toContain(cardId);
	});
});

describe('projectForActor — shared public projection', () => {
	const catalog = makeSessionCatalogFixture();

	it('exposes public zone cards fully to every role', () => {
		const state = makeSessionFixture();
		const cardId = state.majorDraw.pop();
		if (!cardId) throw new Error('fixture empty');
		state.publicZones.push({ id: 'played:round-1', kind: 'played', cards: [cardId] });

		const playerProjection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;
		const gmProjection = projectForActor(state, GM, catalog) as SessionGmProjection;

		expect(playerProjection.public.publicZones[0]).toMatchObject({
			id: 'played:round-1',
			kind: 'played',
			cards: [{ hidden: false, id: cardId }]
		});
		expect(gmProjection.public.publicZones[0].cards[0]).toEqual(playerProjection.public.publicZones[0].cards[0]);
	});

	it('surfaces only the top of the discard piles, and null when empty', () => {
		const state = makeSessionFixture();
		const empty = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;
		expect(empty.public.majorDiscardTop).toBeNull();
		expect(empty.public.playerDiscardTop).toBeNull();

		const buried = state.playerDraw.pop();
		const top = state.playerDraw.pop();
		if (!buried || !top) throw new Error('fixture empty');
		state.playerDiscard = [top, buried];

		const projection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;
		expect(projection.public.playerDiscardTop).toEqual({ hidden: false, id: top, label: top, imageKey: top, value: 0 });
		expect(JSON.stringify(projection.public.playerDiscardTop)).not.toContain(buried);
	});

	it('reports pending zones as counts only, never card identities', () => {
		const state = makeSessionFixture();
		const cardId = state.majorDraw.pop();
		if (!cardId) throw new Error('fixture empty');
		state.pendingZones.push({ id: 'pending:augury', deck: 'major', cards: [cardId] });

		const projection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;
		expect(projection.public.pendingZoneCounts).toEqual([{ id: 'pending:augury', deck: 'major', count: 1 }]);
		expect(JSON.stringify(projection)).not.toContain(cardId);
	});

	it('projects the active procedure\'s public shape', () => {
		const state = makeSessionFixture();
		state.procedure = { procedureId: 'augury', stepIndex: 2, pendingZoneIds: [] };
		const projection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;
		expect(projection.public.procedure).toEqual({ procedureId: 'augury', stepIndex: 2, pendingZoneIds: [] });
	});

	it('always reports status active — the pure engine only runs against an active session', () => {
		const state = makeSessionFixture();
		const projection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;
		expect(projection.public.status).toBe('active');
	});

	it('sums multiple player-hand zones for the same owner into one count', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const secondCard = state.playerDraw.pop();
		if (!secondCard) throw new Error('fixture empty');
		state.privateZones.push({ id: 'hand:playerA:second', kind: 'player-hand', ownerUserId: 'playerA', cards: [secondCard] });

		const projection = projectForActor(state, GM, catalog) as SessionGmProjection;
		expect(projection.public.playerHandCounts.playerA).toBe(2);
	});
});
