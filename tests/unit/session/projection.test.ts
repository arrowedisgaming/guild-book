import { describe, expect, it } from 'vitest';
import { projectForActor } from '$lib/engine/session/projection';
import { legalCommandsForActor } from '$lib/engine/session/reducer';
import {
	fixtureWithHands,
	makeRichSessionCatalogFixture,
	makeSessionCatalogFixture,
	makeSessionFixture
} from '../../fixtures/session';
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

describe('projectForActor — private-zone card backs (spec §8.2)', () => {
	const catalog = makeSessionCatalogFixture();

	it("shows another player's face-down cards as hidden slots — count visible, identity never", () => {
		const state = fixtureWithHands({ playerA: [], playerB: [] });
		const buried = state.playerDraw.pop();
		const revealedElsewhere = state.playerDraw.pop();
		if (!buried || !revealedElsewhere) throw new Error('fixture empty');
		state.privateZones.push({ id: 'facedown:playerB', kind: 'player-facedown', ownerUserId: 'playerB', cards: [buried, revealedElsewhere] });

		const projectionA = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;

		expect(projectionA.public.privateZoneCardBacks).toEqual([
			{ id: 'facedown:playerB', kind: 'player-facedown', ownerUserId: 'playerB', cards: [{ hidden: true }, { hidden: true }] }
		]);
		expect(JSON.stringify(projectionA)).not.toContain(buried);
		expect(JSON.stringify(projectionA)).not.toContain(revealedElsewhere);
	});

	it("still shows the owner's own face-down zone as hidden backs in the shared public section — real identities live only in privateFacedown", () => {
		const state = fixtureWithHands({ playerA: [] });
		const cardId = state.playerDraw.pop();
		if (!cardId) throw new Error('fixture empty');
		state.privateZones.push({ id: 'facedown:playerA', kind: 'player-facedown', ownerUserId: 'playerA', cards: [cardId] });

		const projection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;

		expect(projection.public.privateZoneCardBacks).toEqual([
			{ id: 'facedown:playerA', kind: 'player-facedown', ownerUserId: 'playerA', cards: [{ hidden: true }] }
		]);
		expect(projection.privateFacedown).toEqual([{ hidden: false, id: cardId, label: cardId, imageKey: cardId, value: 0 }]);
	});

	it('the GM sees the same card backs as a player — never real identities via the shared section', () => {
		const state = fixtureWithHands({ playerA: [] });
		const cardId = state.playerDraw.pop();
		if (!cardId) throw new Error('fixture empty');
		state.privateZones.push({ id: 'prepared:playerA', kind: 'player-prepared', ownerUserId: 'playerA', cards: [cardId] });

		const gmProjection = projectForActor(state, GM, catalog) as SessionGmProjection;
		expect(gmProjection.public.privateZoneCardBacks).toEqual([
			{ id: 'prepared:playerA', kind: 'player-prepared', ownerUserId: 'playerA', cards: [{ hidden: true }] }
		]);
		expect(JSON.stringify(gmProjection.public)).not.toContain(cardId);
	});

	it('omits player-hand zones — those are already represented by playerHandCounts', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const projection = projectForActor(state, GM, catalog) as SessionGmProjection;
		expect(projection.public.privateZoneCardBacks).toEqual([]);
	});
});

describe('projectForActor — legalCommands (Step 4: projected controls, not client-side guesses)', () => {
	const catalog = makeSessionCatalogFixture();

	it("lists only the command types legal for the actor's role, matching legalCommandsForActor", () => {
		const state = makeSessionFixture();
		const playerProjection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;
		const gmProjection = projectForActor(state, GM, catalog) as SessionGmProjection;

		expect(playerProjection.legalCommands).toEqual(legalCommandsForActor(PLAYER_A));
		expect(gmProjection.legalCommands).toEqual(legalCommandsForActor(GM));
	});

	it("differs between roles where authority differs — GM-only structural commands are absent from a player's list", () => {
		const state = makeSessionFixture();
		const playerProjection = projectForActor(state, PLAYER_A, catalog) as SessionPlayerProjection;
		const gmProjection = projectForActor(state, GM, catalog) as SessionGmProjection;

		for (const gmOnly of ['deal', 'begin-procedure', 'advance-procedure', 'complete-procedure', 'end-round', 'apply-correction']) {
			expect(gmProjection.legalCommands).toContain(gmOnly);
			expect(playerProjection.legalCommands).not.toContain(gmOnly);
		}
		expect(playerProjection.legalCommands).toContain('play');
		expect(gmProjection.legalCommands).toContain('play');
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

	it('sums multiple player-hand zones for the same owner into one count', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const secondCard = state.playerDraw.pop();
		if (!secondCard) throw new Error('fixture empty');
		state.privateZones.push({ id: 'hand:playerA:second', kind: 'player-hand', ownerUserId: 'playerA', cards: [secondCard] });

		const projection = projectForActor(state, GM, catalog) as SessionGmProjection;
		expect(projection.public.playerHandCounts.playerA).toBe(2);
	});
});

describe('projectForActor — hydration from a rich runtime catalog (Task 4 metadata)', () => {
	const richCatalog = makeRichSessionCatalogFixture();

	it('hydrates a visible minor-card slot with the catalog entry\'s real label/imageKey/value/suit/rank, not the card id', () => {
		const state = fixtureWithHands({ playerA: ['cups-i'] });
		const entry = richCatalog['cups-i'];
		if (!entry) throw new Error('fixture missing cups-i');

		const projection = projectForActor(state, PLAYER_A, richCatalog) as SessionPlayerProjection;

		expect(projection.privateHand).toEqual([
			{
				hidden: false,
				id: 'cups-i',
				label: entry.label,
				imageKey: entry.imageKey,
				value: entry.value,
				suit: entry.suit,
				rank: entry.rank
			}
		]);
		expect(projection.privateHand[0]).not.toEqual({ hidden: false, id: 'cups-i', label: 'cups-i', imageKey: 'cups-i', value: 0 });
	});

	it('hydrates a visible major-card slot with the catalog entry\'s real label/value/major metadata', () => {
		const state = makeSessionFixture();
		state.gmHand = ['magician'];
		const entry = richCatalog['magician'];
		if (!entry) throw new Error('fixture missing magician');

		const projection = projectForActor(state, GM, richCatalog) as SessionGmProjection;

		expect(projection.gmHand).toEqual([
			{
				hidden: false,
				id: 'magician',
				label: entry.label,
				imageKey: entry.imageKey,
				value: entry.value,
				major: entry.major
			}
		]);
	});

	it('still hydrates only public zone cards fully — hidden slots stay `{ hidden: true }` with a rich catalog', () => {
		const state = fixtureWithHands({ playerA: [], playerB: [] });
		const cardId = state.playerDraw.pop();
		if (!cardId) throw new Error('fixture empty');
		state.privateZones.push({ id: 'facedown:playerB', kind: 'player-facedown', ownerUserId: 'playerB', cards: [cardId] });

		const projection = projectForActor(state, PLAYER_A, richCatalog) as SessionPlayerProjection;

		expect(projection.public.privateZoneCardBacks).toEqual([
			{ id: 'facedown:playerB', kind: 'player-facedown', ownerUserId: 'playerB', cards: [{ hidden: true }] }
		]);
		expect(Object.keys(projection.public.privateZoneCardBacks[0]?.cards[0] ?? {})).toEqual(['hidden']);
		expect(JSON.stringify(projection)).not.toContain(cardId);
	});

	it('falls back to the card id/0 when a catalog entry lacks metadata, even alongside rich entries elsewhere', () => {
		const state = makeSessionFixture();
		const cardId = state.majorDraw.pop();
		if (!cardId) throw new Error('fixture empty');
		state.publicZones.push({ id: 'played:round-1', kind: 'played', cards: [cardId] });

		const sparseCatalog = { ...richCatalog, [cardId]: { id: cardId, deck: 'major' as const } };
		const projection = projectForActor(state, PLAYER_A, sparseCatalog) as SessionPlayerProjection;

		expect(projection.public.publicZones[0]?.cards[0]).toEqual({
			hidden: false,
			id: cardId,
			label: cardId,
			imageKey: cardId,
			value: 0
		});
	});
});
