import { describe, expect, it } from 'vitest';
import { reduceSession, type ReduceContext } from '$lib/engine/session/reducer';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { listZoneDescriptors, type ZoneDescriptor } from '$lib/engine/session/zones';
import { makeRng, type Rng } from '$lib/engine/rng';
import { fixtureWithHands, makeSessionCatalogFixture } from '../../fixtures/session';
import type { SessionActor, SessionCommand, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

/**
 * Randomized command-sequence conservation tests (brief Step 5). Without a
 * property-testing dependency, `chooseLegalCommand` picks a plausible
 * command + actor from `state`'s CURRENT zones using a step-seeded `Rng`.
 * Illegal/unauthorized picks are expected and harmless — `reduceSession`
 * leaves state untouched on rejection — the point is that after every
 * ACCEPTED command, all 78 configured cards still exist in exactly one zone.
 */

const GM_ACTOR: SessionActor = { kind: 'gm', userId: 'gm-1' };
const PLAYER_IDS = ['playerA', 'playerB'];

function buildStartingState(seed: string): SessionEngineStateV1 {
	const state = fixtureWithHands({ playerA: [], playerB: [] }, seed);
	state.publicZones.push(
		{ id: 'played:round-1', kind: 'played', cards: [] },
		{ id: 'initiative:round-1', kind: 'initiative', cards: [] }
	);
	return state;
}

function pick<T>(items: readonly T[], rng: Rng): T | undefined {
	if (items.length === 0) return undefined;
	return items[Math.floor(rng() * items.length) % items.length];
}

function actorForZone(zone: ZoneDescriptor, rng: Rng): SessionActor {
	if (zone.owner.kind === 'player' && rng() < 0.85) return { kind: 'player', userId: zone.owner.userId };
	if (rng() < 0.7) return GM_ACTOR;
	return { kind: 'player', userId: pick(PLAYER_IDS, rng)! };
}

interface Attempt {
	command: SessionCommand;
	actor: SessionActor;
}

const FALLBACK: Attempt = { command: { type: 'end-round' }, actor: GM_ACTOR };

const MOVE_TYPES = ['play', 'place-facedown', 'discard', 'transfer', 'select-from-discard'] as const;
const ACTION_KINDS = ['draw', 'deal', 'move', 'reveal', 'reorder-top', 'mulligan', 'procedure', 'end-round', 'apply-correction'] as const;

function chooseLegalCommand(state: SessionEngineStateV1, rng: Rng): Attempt {
	const zones = listZoneDescriptors(state);
	const kind = pick(ACTION_KINDS, rng)!;

	switch (kind) {
		case 'draw': {
			const deck = rng() < 0.5 ? 'major' : 'player';
			const destination = pick(
				zones.filter((z) => z.deck === deck || z.deck === 'both'),
				rng
			);
			if (!destination) return FALLBACK;
			return {
				command: { type: 'draw', deck, destinationZoneId: destination.id, count: 1 + Math.floor(rng() * 3) },
				actor: actorForZone(destination, rng)
			};
		}
		case 'deal': {
			const deck = rng() < 0.5 ? 'major' : 'player';
			const candidates = zones.filter((z) => z.deck === deck || z.deck === 'both');
			if (candidates.length === 0) return FALLBACK;
			const destinationCount = 1 + Math.floor(rng() * Math.min(2, candidates.length));
			const destinationZoneIds = Array.from({ length: destinationCount }, () => pick(candidates, rng)!.id);
			return { command: { type: 'deal', deck, destinationZoneIds, countPerDestination: 1 }, actor: GM_ACTOR };
		}
		case 'move': {
			const source = pick(
				zones.filter((z) => z.cards.length > 0),
				rng
			);
			const destination = pick(zones, rng);
			if (!source || !destination) return FALLBACK;
			const cardId = pick(source.cards, rng)!;
			const moveType = pick(MOVE_TYPES, rng)!;
			return {
				command: { type: moveType, sourceZoneId: source.id, cardId, destinationZoneId: destination.id } as SessionCommand,
				actor: actorForZone(source, rng)
			};
		}
		case 'reveal': {
			const zone = pick(
				zones.filter((z) => z.cards.length > 0),
				rng
			);
			if (!zone) return FALLBACK;
			const cardId = pick(zone.cards, rng)!;
			return { command: { type: 'reveal', zoneId: zone.id, cardId }, actor: actorForZone(zone, rng) };
		}
		case 'reorder-top': {
			const zone = pick(
				zones.filter((z) => z.ordered && z.cards.length > 0),
				rng
			);
			if (!zone) return FALLBACK;
			const topCount = 1 + Math.floor(rng() * Math.min(3, zone.cards.length));
			const shuffledTop = [...zone.cards.slice(0, topCount)].sort(() => rng() - 0.5);
			return { command: { type: 'reorder-top', zoneId: zone.id, cardIds: shuffledTop }, actor: actorForZone(zone, rng) };
		}
		case 'mulligan': {
			const zone = pick(
				zones.filter((z) => z.deck !== 'both'),
				rng
			);
			if (!zone) return FALLBACK;
			return { command: { type: 'mulligan', zoneId: zone.id }, actor: actorForZone(zone, rng) };
		}
		case 'procedure': {
			if (state.procedure) {
				const type = rng() < 0.5 ? 'advance-procedure' : 'complete-procedure';
				return { command: { type, procedureId: state.procedure.procedureId }, actor: GM_ACTOR };
			}
			return { command: { type: 'begin-procedure', procedureId: 'augury' }, actor: GM_ACTOR };
		}
		case 'end-round':
			return { command: { type: 'end-round' }, actor: GM_ACTOR };
		case 'apply-correction':
			return {
				command: { type: 'apply-correction', targetEventId: `evt-${Math.floor(rng() * 1000)}`, note: 'fuzz' },
				actor: GM_ACTOR
			};
	}
}

function contextFor(actor: SessionActor, catalog: TarotCardCatalog, rng: Rng): ReduceContext {
	return { actor, runtime: { catalog }, rng };
}

describe('reduceSession — conservation property', () => {
	it('conserves all 78 configured cards across 500 seeded sequences of 200 commands', () => {
		const catalog = makeSessionCatalogFixture();
		const catalogIds = Object.keys(catalog).sort();

		for (let seed = 0; seed < 500; seed += 1) {
			let state = buildStartingState(String(seed));

			for (let step = 0; step < 200; step += 1) {
				const stepRng = makeRng(`${seed}:${step}`);
				const { command, actor } = chooseLegalCommand(state, stepRng);
				const result = reduceSession(state, command, contextFor(actor, catalog, stepRng));
				if (result.ok) state = result.state;

				expect(() => assertSessionInvariants(state, catalog), `seed=${seed} step=${step}`).not.toThrow();

				const presentIds = listZoneDescriptors(state)
					.flatMap((zone) => zone.cards)
					.sort();
				expect(presentIds, `seed=${seed} step=${step}: card set drifted from the catalog`).toEqual(catalogIds);
			}
		}
	});
});
