/**
 * Increment 4 Task 3 Step 1 — the Camp tarot procedures.
 *
 * Two procedures with genuinely different shapes:
 *
 * **High Chant** (Ch5, `paths-high-chant`): "you may select a number of cards
 * from the minor arcana discard pile equal to your Cups … Distribute the cards
 * to other players—you may keep one for yourself. No player can ever have more
 * than one inspiration card." So the count is content-driven from the
 * performer's Cups, the distribution is a cross-owner private transfer, and the
 * one-per-player cap is a real, stated rule the engine enforces.
 *
 * **Leeches** (Ch9, `city-leeches`): "You can apply leeches to another
 * adventurer … draw a card. If you draw a Swords or Pentacles card, nothing
 * happens. If you draw a Cups or Wands card, the leeched adventurer counts as
 * having burned 2 charges to cure an affliction." The app reports that outcome
 * and never applies it — afflictions are sheet state this engine does not touch
 * (spec §8.6, and the plan's "No Camp resource outside the modeled card
 * procedure is auto-mutated").
 *
 * The privacy assertions are the sharpest requirement here: an inspiration
 * card's face reaches its holder and the performer who handed it over, and
 * nobody else — not a bystanding player, not the GM.
 */

import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { makeRng } from '$lib/engine/rng';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import {
	advanceLeeches,
	beginHighChant,
	beginLeeches,
	buildCampConfig,
	completeCampProcedure,
	completeHighChantTransfer,
	highChantSelectionZoneId,
	inspirationZoneId,
	readCampProcedure,
	selectInspiration,
	type CampConfig,
	type CampMaterials,
	type CampReduceContext
} from '$lib/engine/session/procedures/camp';
import { readGuidedTest } from '$lib/engine/session/procedures/test-of-fate';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, SessionEvent, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };
const BOB: SessionActor = { kind: 'player', userId: 'user-bob' };
const CAROL: SessionActor = { kind: 'player', userId: 'user-carol' };

const CATALOG: TarotCardCatalog = makeRichSessionCatalogFixture();

/** Alice is the bard: Cups 3, so the pack's `perCups: 1` gives her three
 * inspiration cards. Bob and Carol are recipients. */
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

function ctxFor(actor: SessionActor, seed = 'camp', materials: CampMaterials = MATERIALS): CampReduceContext {
	return { actor, runtime: { catalog: CATALOG }, rng: makeRng(seed), config: CONFIG, materials };
}

function unwrap(result: ReturnType<typeof beginHighChant>): SessionEngineStateV1 {
	if (!result.ok) throw new Error(`expected ok, got ${result.rejection.code}: ${result.rejection.message}`);
	return result.state;
}

function eventsOf(result: ReturnType<typeof beginHighChant>): SessionEvent[] {
	if (!result.ok) throw new Error(`expected ok, got ${result.rejection.code}`);
	return result.events;
}

/** Moves `cardIds` out of the minor draw pile into the minor discard, so a
 * High Chant has something to select from. */
function withMinorDiscard(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const playerDraw = state.playerDraw.filter((id) => !cardIds.includes(id));
	if (playerDraw.length !== state.playerDraw.length - cardIds.length) {
		throw new Error('withMinorDiscard: every card must start in the minor draw pile');
	}
	return { ...state, playerDraw, playerDiscard: [...state.playerDiscard, ...cardIds] };
}

function withTopOfPlayerDraw(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	const rest = state.playerDraw.filter((id) => !cardIds.includes(id));
	return { ...state, playerDraw: [...cardIds, ...rest] };
}

const DISCARD = ['cups-ii', 'cups-iii', 'cups-iv', 'swords-v'];

/** Alice begins and selects her three cards. */
function selected(cards: CardId[] = ['cups-ii', 'cups-iii', 'cups-iv']): SessionEngineStateV1 {
	let state = withMinorDiscard(makeSessionFixture(), DISCARD);
	state = unwrap(beginHighChant(state, ctxFor(ALICE)));
	state = unwrap(selectInspiration(state, { cardIds: cards }, ctxFor(ALICE)));
	return state;
}

describe('camp — High Chant selection', () => {
	it('sets the allowance from the performer’s Cups and the pack’s per-Cups formula', () => {
		const state = unwrap(beginHighChant(withMinorDiscard(makeSessionFixture(), DISCARD), ctxFor(ALICE)));

		expect(readCampProcedure(state)).toMatchObject({
			kind: 'high-chant',
			stage: 'select',
			performerTenureId: 'tenure-1',
			allowance: 3
		});
	});

	it('rejects selecting more cards than the allowance', () => {
		const state = unwrap(beginHighChant(withMinorDiscard(makeSessionFixture(), DISCARD), ctxFor(ALICE)));

		const result = selectInspiration(state, { cardIds: ['cups-ii', 'cups-iii', 'cups-iv', 'swords-v'] }, ctxFor(ALICE));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects selecting a card that is not in the minor discard', () => {
		const state = unwrap(beginHighChant(withMinorDiscard(makeSessionFixture(), DISCARD), ctxFor(ALICE)));

		const result = selectInspiration(state, { cardIds: ['wands-ix'] }, ctxFor(ALICE));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('moves the selection out of the discard into the performer’s own private zone', () => {
		const state = selected();

		expect(state.playerDiscard).toEqual(['swords-v']);
		const zone = findZoneDescriptor(state, highChantSelectionZoneId('tenure-1'));
		expect(zone?.cards).toEqual(['cups-ii', 'cups-iii', 'cups-iv']);
		expect(zone?.visibility).toBe('private');
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('only the performer may select', () => {
		const state = unwrap(beginHighChant(withMinorDiscard(makeSessionFixture(), DISCARD), ctxFor(ALICE)));

		expect(selectInspiration(state, { cardIds: ['cups-ii'] }, ctxFor(BOB))).toMatchObject({
			ok: false,
			rejection: { code: 'not-authorized' }
		});
	});

	it('a player with no adventurer at the table cannot perform it', () => {
		const state = withMinorDiscard(makeSessionFixture(), DISCARD);

		expect(beginHighChant(state, ctxFor({ kind: 'player', userId: 'user-nobody' }))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});

	it('refuses a second Camp procedure while one is in flight', () => {
		const state = unwrap(beginHighChant(withMinorDiscard(makeSessionFixture(), DISCARD), ctxFor(ALICE)));

		expect(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(BOB))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});
});

describe('camp — High Chant distribution and privacy', () => {
	it('hands a card to another player’s inspiration zone', () => {
		const state = unwrap(completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-2' }, ctxFor(ALICE)));

		expect(findZoneDescriptor(state, inspirationZoneId('tenure-2'))?.cards).toEqual(['cups-ii']);
		expect(findZoneDescriptor(state, highChantSelectionZoneId('tenure-1'))?.cards).toEqual(['cups-iii', 'cups-iv']);
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('the public event names tenures and a count, never the card', () => {
		const events = eventsOf(completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-2' }, ctxFor(ALICE)));

		const transferred = events.find((event) => event.kind === 'camp-inspiration-granted');
		expect(transferred?.publicPayload).toMatchObject({
			performerTenureId: 'tenure-1',
			recipientTenureId: 'tenure-2',
			count: 1
		});
		expect(JSON.stringify(transferred?.publicPayload)).not.toContain('cups-ii');
	});

	it('only the performer and the recipient privately learn the face — never the GM', () => {
		const events = eventsOf(completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-2' }, ctxFor(ALICE)));

		const transferred = events.find((event) => event.kind === 'camp-inspiration-granted');
		expect(Object.keys(transferred?.privatePayloads ?? {}).sort()).toEqual(['user-alice', 'user-bob']);
		expect(transferred?.privatePayloads?.['user-bob']).toMatchObject({ cardId: 'cups-ii' });
		expect(transferred?.privatePayloads?.['gm-1']).toBeUndefined();
	});

	it('a bystanding player sees only a card back, never the identity', () => {
		const state = unwrap(completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-2' }, ctxFor(ALICE)));

		// The zone is private to Bob; Carol and the GM reach it through the
		// card-back projection only, which is what makes the one-per-player cap
		// publicly checkable without exposing the face.
		const zone = findZoneDescriptor(state, inspirationZoneId('tenure-2'));
		expect(zone?.visibility).toBe('private');
		expect(zone?.owner).toEqual({ kind: 'player', userId: 'user-bob' });
	});

	it('enforces the pack’s one-inspiration-per-player cap', () => {
		let state = unwrap(completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-2' }, ctxFor(ALICE)));

		const second = completeHighChantTransfer(state, { cardId: 'cups-iii', recipientTenureId: 'tenure-2' }, ctxFor(ALICE));

		expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		// The refused transfer changed nothing.
		expect(findZoneDescriptor(state, inspirationZoneId('tenure-2'))?.cards).toEqual(['cups-ii']);
	});

	it('the performer may keep one for themselves', () => {
		const state = unwrap(completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-1' }, ctxFor(ALICE)));

		expect(findZoneDescriptor(state, inspirationZoneId('tenure-1'))?.cards).toEqual(['cups-ii']);
	});

	it('rejects handing over a card that is not in the selection', () => {
		const result = completeHighChantTransfer(selected(), { cardId: 'swords-v', recipientTenureId: 'tenure-2' }, ctxFor(ALICE));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a recipient who is not at the table', () => {
		const result = completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-absent' }, ctxFor(ALICE));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('only the performer may distribute their own selection', () => {
		const result = completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-2' }, ctxFor(BOB));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('returns undistributed selections to the minor discard on completion', () => {
		let state = unwrap(completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-2' }, ctxFor(ALICE)));

		// Alice hands one to Bob and one to Carol; the third has nowhere legal to
		// go (everyone already holds one), so it goes back to the pile it came from
		// rather than vanishing.
		state = unwrap(completeHighChantTransfer(state, { cardId: 'cups-iii', recipientTenureId: 'tenure-3' }, ctxFor(ALICE)));
		state = unwrap(completeCampProcedure(state, ctxFor(ALICE)));

		expect(state.playerDiscard).toEqual(expect.arrayContaining(['swords-v', 'cups-iv']));
		expect(findZoneDescriptor(state, highChantSelectionZoneId('tenure-1'))).toBeUndefined();
		expect(readCampProcedure(state)).toBeUndefined();
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('leaves distributed inspiration in place after the procedure ends', () => {
		let state = unwrap(completeHighChantTransfer(selected(), { cardId: 'cups-ii', recipientTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(completeCampProcedure(state, ctxFor(ALICE)));

		// Ch5: "Inspiration cards last until used or until the end of the session."
		expect(findZoneDescriptor(state, inspirationZoneId('tenure-2'))?.cards).toEqual(['cups-ii']);
	});
});

describe('camp — leeches', () => {
	it('must be applied to another adventurer', () => {
		const state = makeSessionFixture();

		expect(beginLeeches(state, { targetTenureId: 'tenure-1' }, ctxFor(ALICE))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});

	it('rejects a target who is not at the table', () => {
		expect(beginLeeches(makeSessionFixture(), { targetTenureId: 'tenure-absent' }, ctxFor(ALICE))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});

	it('a Swords draw does nothing', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['swords-v']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(advanceLeeches(state, ctxFor(ALICE)));

		expect(readCampProcedure(state)).toMatchObject({
			kind: 'leeches',
			stage: 'complete',
			drawnCardId: 'swords-v',
			outcome: { effect: 'no-effect', charges: null }
		});
	});

	it('a Pentacles draw also does nothing', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['pentacles-ix']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(advanceLeeches(state, ctxFor(ALICE)));

		expect(readCampProcedure(state)).toMatchObject({ outcome: { effect: 'no-effect' } });
	});

	it('a Cups draw cures an affliction with the pack’s charge count', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(advanceLeeches(state, ctxFor(ALICE)));

		expect(readCampProcedure(state)).toMatchObject({
			outcome: { effect: 'cure-affliction', charges: 2, targetTenureId: 'tenure-2' }
		});
	});

	it('a Wands draw cures too', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['wands-ix']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(advanceLeeches(state, ctxFor(ALICE)));

		expect(readCampProcedure(state)).toMatchObject({ outcome: { effect: 'cure-affliction', charges: 2 } });
	});

	it('publishes the drawn card and the outcome — leeches is public', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		const result = advanceLeeches(state, ctxFor(ALICE));

		const resolved = eventsOf(result).find((event) => event.kind === 'camp-leeches-resolved');
		expect(resolved?.publicPayload).toMatchObject({
			actorTenureId: 'tenure-1',
			targetTenureId: 'tenure-2',
			cardId: 'cups-iv',
			effect: 'cure-affliction',
			charges: 2
		});
		expect(resolved?.privatePayloads).toBeUndefined();
	});

	it('never auto-mutates a character resource — the outcome is reported for the table', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		const result = advanceLeeches(state, ctxFor(ALICE));

		// The whole surface of this engine is card state — there is no character
		// field it could write, and the outcome carries `manualConsequence` so the
		// panel says so rather than implying the app applied it.
		expect(eventsOf(result).find((event) => event.kind === 'camp-leeches-resolved')?.publicPayload).toMatchObject({
			manualConsequence: true
		});
	});

	it('discards the drawn card on completion', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(advanceLeeches(state, ctxFor(ALICE)));
		state = unwrap(completeCampProcedure(state, ctxFor(ALICE)));

		expect(state.playerDiscard).toContain('cups-iv');
		expect(readCampProcedure(state)).toBeUndefined();
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();
	});

	it('completing before the draw is rejected', () => {
		const state = unwrap(beginLeeches(makeSessionFixture(), { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));

		expect(completeCampProcedure(state, ctxFor(ALICE))).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('leaves a Fool draw scheduled for the round boundary — leeches configures no reshuffle', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['fool']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(advanceLeeches(state, ctxFor(ALICE)));
		state = unwrap(completeCampProcedure(state, ctxFor(ALICE)));

		// Unlike `test-of-fate`, the `camp-leeches` steps carry no `reshuffle`
		// rule, so the flags the Fool set stay pending for `end-round` rather than
		// being consumed here. Content-driven, not a hardcoded boundary.
		expect(state.reshuffleAtBoundary).toEqual({ major: true, player: true });
	});

	it('the Fool is a major card with no suit, so it cures nothing', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['fool']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(advanceLeeches(state, ctxFor(ALICE)));

		expect(readCampProcedure(state)).toMatchObject({ outcome: { effect: 'no-effect' } });
	});

	it('only the applying player may advance it', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));

		expect(advanceLeeches(state, ctxFor(CAROL))).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('the GM may finalize a Camp procedure the player abandoned', () => {
		let state = withTopOfPlayerDraw(makeSessionFixture(), ['cups-iv']);
		state = unwrap(beginLeeches(state, { targetTenureId: 'tenure-2' }, ctxFor(ALICE)));
		state = unwrap(advanceLeeches(state, ctxFor(ALICE)));

		expect(completeCampProcedure(state, ctxFor(GM))).toMatchObject({ ok: true });
	});
});

describe('camp — independence from a guided test', () => {
	it('does not disturb an in-flight test of fate', () => {
		// A test of fate is a PEER of `state.procedure`; a Camp procedure occupies
		// the procedure slot. Neither may clobber the other.
		let state = withMinorDiscard(makeSessionFixture(), DISCARD);
		state = { ...state, guidedTest: { schemaVersion: 1, stage: 'favor', actorTenureId: 'tenure-2', testedSuit: 'swords', favor: false, disfavor: false, resolvePurchase: null, initialCardZoneId: null, pushCardZoneId: null, result: null, reshuffleBefore: { major: false, player: false } } };

		state = unwrap(beginHighChant(state, ctxFor(ALICE)));

		expect(readCampProcedure(state)?.kind).toBe('high-chant');
		expect(readGuidedTest(state)).toMatchObject({ stage: 'favor', actorTenureId: 'tenure-2' });
	});
});
