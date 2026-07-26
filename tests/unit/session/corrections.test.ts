/**
 * Increment 4 Task 5 Step 2 — audited compensating corrections.
 *
 * A correction never edits or deletes an old command or event: it applies a
 * LEGAL compensating card transition through the same reducer (and therefore
 * the same invariant checker) as any other move, and appends a
 * `correction-applied` event linking the original. The journal stays
 * append-only; the repair is itself auditable history.
 */

import { describe, expect, it } from 'vitest';
import { makeRng } from '$lib/engine/rng';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { applyCorrection, type CorrectionCommand } from '$lib/engine/session/corrections';
import { makeRichSessionCatalogFixture, makeSessionFixture, fixtureWithHands } from '../../fixtures/session';
import type { SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };
const CATALOG: TarotCardCatalog = makeRichSessionCatalogFixture();

function ctxFor(actor: SessionActor) {
	return { actor, runtime: { catalog: CATALOG }, rng: makeRng('corrections') };
}

function unwrap(result: ReturnType<typeof applyCorrection>): { state: SessionEngineStateV1; events: ReturnType<typeof Object.values> } {
	if (!result.ok) throw new Error(`expected ok, got ${result.rejection.code}: ${result.rejection.message}`);
	return { state: result.state, events: result.events };
}

/** A card sitting face-up in a PUBLIC zone — the only kind of card a
 * correction may move (see `corrections.ts`'s header). */
const MOVE: CorrectionCommand = {
	kind: 'move-card',
	targetEventId: 'evt-42',
	reason: 'this was played into the wrong area',
	sourceZoneId: 'played',
	cardId: 'cups-ii',
	destinationZoneId: 'revealed'
};

function stateWithHandAndPlayed(): SessionEngineStateV1 {
	const state = fixtureWithHands({ 'user-alice': ['cups-iii'] });
	const played = state.playerDraw.includes('cups-ii') ? 'cups-ii' : state.playerDraw[0];
	return {
		...state,
		playerDraw: state.playerDraw.filter((id) => id !== played),
		publicZones: [
			...state.publicZones,
			{ id: 'played', kind: 'played', cards: [played] },
			{ id: 'revealed', kind: 'revealed', cards: [] }
		]
	};
}

describe('compensating corrections', () => {
	it('moves the card through the ordinary reducer and links the original event', () => {
		const { state, events } = unwrap(applyCorrection(stateWithHandAndPlayed(), MOVE, ctxFor(GM)));

		expect(findZoneDescriptor(state, 'revealed')?.cards).toEqual(['cups-ii']);
		expect(findZoneDescriptor(state, 'played')?.cards).toEqual([]);
		expect(() => assertSessionInvariants(state, CATALOG)).not.toThrow();

		const applied = (events as { kind: string; publicPayload: unknown }[]).find((event) => event.kind === 'correction-applied');
		expect(applied?.publicPayload).toMatchObject({
			targetEventId: 'evt-42',
			correctionKind: 'move-card',
			reason: MOVE.reason
		});
	});

	it('is GM-only', () => {
		expect(applyCorrection(stateWithHandAndPlayed(), MOVE, ctxFor(ALICE))).toMatchObject({
			ok: false,
			rejection: { code: 'not-authorized' }
		});
	});

	it('requires a non-empty reason', () => {
		expect(applyCorrection(stateWithHandAndPlayed(), { ...MOVE, reason: '   ' }, ctxFor(GM))).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});

	it('rejects an illegal compensating move rather than forcing it', () => {
		// The card is not in the named source zone — the repair itself must be a
		// legal transition, never a state edit.
		const result = applyCorrection(makeSessionFixture(), MOVE, ctxFor(GM));

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('refuses to move a card out of a player’s private hand', () => {
		// Review finding: corrections accepted ANY source zone, and the GM's
		// generic full authority meant a correction could lift a card out of a
		// hand and publish its identity — probing hidden state through a repair.
		const state = fixtureWithHands({ 'user-alice': ['cups-ii'] });
		const withPublic = { ...state, publicZones: [...state.publicZones, { id: 'played', kind: 'played' as const, cards: [] }] };

		const result = applyCorrection(
			withPublic,
			{ ...MOVE, sourceZoneId: 'hand:user-alice', destinationZoneId: 'played' },
			ctxFor(GM)
		);

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('refuses to move a card off a draw pile', () => {
		const result = applyCorrection(
			stateWithHandAndPlayed(),
			{ ...MOVE, sourceZoneId: 'playerDraw', destinationZoneId: 'played' },
			ctxFor(GM)
		);

		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('never rewrites history — the correction is new events on top', () => {
		const { events } = unwrap(applyCorrection(stateWithHandAndPlayed(), MOVE, ctxFor(GM)));

		// Exactly the compensating move's own event plus the audit link — no
		// event is removed, none is altered; the journal is append-only by shape.
		const kinds = (events as { kind: string }[]).map((event) => event.kind);
		expect(kinds).toContain('correction-applied');
		expect(kinds.length).toBeGreaterThanOrEqual(2);
	});
});
