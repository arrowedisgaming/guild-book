/**
 * The combined Challenge command surface (Increment 3 Task 6):
 * `legalChallengeCommands`/`applyChallengeCommand` in `command.ts` — the ONE
 * legality-then-dispatch entry point the HTTP layer calls, unifying every
 * base-flow procedure function (Tasks 2/3) with the seven typed modifiers
 * (Task 4).
 */
import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig, ChallengeEnemyFact } from '$lib/engine/session/procedures/challenge/types';
import { readChallengeState, type ChallengeReduceContext } from '$lib/engine/session/procedures/challenge/reducer';
import { applyPlayerAction } from '$lib/engine/session/procedures/challenge/turns';
import {
	applyChallengeCommand,
	buildChallengeModifierMaterials,
	legalChallengeBaseCommands,
	legalChallengeCommands,
	type ChallengeCommand
} from '$lib/engine/session/procedures/challenge/command';
import { challengeHandZoneId } from '$lib/engine/session/procedures/challenge/reducer';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { makeRng } from '$lib/engine/rng';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';
import type { ChallengeModifierMaterials } from '$lib/engine/session/procedures/challenge/modifiers';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };
const BOB: SessionActor = { kind: 'player', userId: 'user-bob' };
const TENURE_OWNERS: Record<string, string> = { 'tenure-1': 'user-alice', 'tenure-2': 'user-bob' };
const oneOgre: ChallengeEnemyFact[] = [{ id: 'ogre-1', size: 'human', threat: 'minion', typeIds: ['ogre'], count: 1 }];

function ctxFor(actor: SessionActor, catalog: TarotCardCatalog, config: ChallengeConfig, seed: string): ChallengeReduceContext {
	return { actor, runtime: { catalog }, rng: makeRng(seed), config };
}

function expectConserved(state: SessionEngineStateV1, catalog: TarotCardCatalog): void {
	expect(() => assertSessionInvariants(state, catalog)).not.toThrow();
}

/** Mirrors every sibling Challenge test file's `forceHand` helper. */
function forceHand(state: SessionEngineStateV1, tenureId: string, cardIds: CardId[]): SessionEngineStateV1 {
	const zoneId = challengeHandZoneId(tenureId);
	const zone = findZoneDescriptor(state, zoneId);
	if (!zone) throw new Error(`forceHand: unknown zone ${zoneId}`);

	let playerDraw = state.playerDraw.concat(zone.cards);
	let privateZones = state.privateZones.map((z) => (z.id === zoneId ? { ...z, cards: [] } : z));
	for (const cardId of cardIds) {
		if (playerDraw.includes(cardId)) playerDraw = playerDraw.filter((id) => id !== cardId);
		else privateZones = privateZones.map((z) => ({ ...z, cards: z.cards.filter((id) => id !== cardId) }));
	}
	const targetIndex = privateZones.findIndex((z) => z.id === zoneId);
	privateZones[targetIndex] = { ...privateZones[targetIndex], cards: cardIds.slice() };
	return { ...state, playerDraw, privateZones };
}

function forceGmHand(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	let majorDraw = state.majorDraw.concat(state.gmHand);
	for (const cardId of cardIds) majorDraw = majorDraw.filter((id) => id !== cardId);
	return { ...state, majorDraw, gmHand: cardIds.slice() };
}

describe('Challenge command surface (Increment 3 Task 6)', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas, modifiers } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);
	const materials: ChallengeModifierMaterials = buildChallengeModifierMaterials(modifiers, { hasBow: true, hasShield: true });

	// Branch-fix "also fix": a CORRUPT Challenge state must reject with a
	// DISTINCT message, not the misleading "not currently offered" every command
	// gets when the round is genuinely absent.
	it('rejects every command against a corrupt Challenge state with a distinct message (not the absent-round message)', () => {
		const seed = 'corrupt-state';
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begin = applyChallengeCommand(
			makeSessionFixture(seed),
			{ type: 'begin-challenge', participantTenureIds: ['tenure-1', 'tenure-2'], tenureOwners: TENURE_OWNERS, enemyFacts: oneOgre },
			materials,
			gmCtx
		);
		if (!begin.ok) throw begin;

		// Corrupt the persisted Challenge blob (unparseable gmPrivate) — the
		// procedure is still the challenge-round procedure, but its state no
		// longer validates.
		const corrupt: SessionEngineStateV1 = {
			...begin.state,
			procedure: { ...begin.state.procedure!, gmPrivate: { schemaVersion: 999, garbage: true } }
		};
		const corruptResult = applyChallengeCommand(corrupt, { type: 'deal-round' }, materials, gmCtx);
		expect(corruptResult).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('corrupt') } });

		// Discrimination: a genuinely-absent round (no procedure) rejects with a
		// DIFFERENT message — proving the corrupt path is distinguishable.
		const absent = applyChallengeCommand(makeSessionFixture('absent-round'), { type: 'deal-round' }, materials, gmCtx);
		expect(absent.ok).toBe(false);
		if (absent.ok) return;
		expect(absent.rejection.message).not.toContain('corrupt');
	});

	it('runs the full multi-context journey through applyChallengeCommand alone: begin, deal, place, reveal, take turns, GM plays, Fool paired play, cleanup', () => {
		const seed = 'command-full-journey';
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);

		const begin = applyChallengeCommand(
			state,
			{ type: 'begin-challenge', participantTenureIds: ['tenure-1', 'tenure-2'], tenureOwners: TENURE_OWNERS, enemyFacts: oneOgre },
			materials,
			gmCtx
		);
		expect(begin.ok).toBe(true);
		if (!begin.ok) return;

		const dealt = applyChallengeCommand(begin.state, { type: 'deal-round' }, materials, gmCtx);
		expect(dealt.ok).toBe(true);
		if (!dealt.ok) return;

		// Force hands so the journey is deterministic: tenure-1 holds the Fool
		// plus a pairable card, tenure-2 an ordinary hand, the GM an ordinary
		// hand, and everyone reserves a distinct Initiative card.
		let working = forceHand(dealt.state, 'tenure-1', ['wands-king', 'fool', 'cups-v', 'swords-vii']);
		working = forceHand(working, 'tenure-2', ['wands-queen', 'cups-ii', 'swords-iii', 'pentacles-iv']);
		working = forceGmHand(working, ['tower', 'star']);

		const aliceCtx = ctxFor(ALICE, catalog, config, seed);
		const bobCtx = ctxFor(BOB, catalog, config, seed);

		const placedAlice = applyChallengeCommand(working, { type: 'place-initiative', tenureId: 'tenure-1', cardId: 'wands-king' }, materials, aliceCtx);
		expect(placedAlice.ok).toBe(true);
		if (!placedAlice.ok) return;
		const placedBob = applyChallengeCommand(placedAlice.state, { type: 'place-initiative', tenureId: 'tenure-2', cardId: 'wands-queen' }, materials, bobCtx);
		expect(placedBob.ok).toBe(true);
		if (!placedBob.ok) return;
		const placedGm = applyChallengeCommand(placedBob.state, { type: 'place-gm-initiative', enemyFactId: 'ogre-1', cardId: 'tower' }, materials, gmCtx);
		expect(placedGm.ok).toBe(true);
		if (!placedGm.ok) return;

		// Once every seat has placed, `reveal-initiative` must be offered.
		expect(legalChallengeCommands(placedGm.state, GM, config, { counselMaxUsesPerRound: 1, guardianAngelMaxInstances: 1 })).toContain(
			'reveal-initiative'
		);

		const revealed = applyChallengeCommand(placedGm.state, { type: 'reveal-initiative' }, materials, gmCtx);
		expect(revealed.ok).toBe(true);
		if (!revealed.ok) return;

		const begunTurns = applyChallengeCommand(revealed.state, { type: 'begin-turns' }, materials, gmCtx);
		expect(begunTurns.ok).toBe(true);
		if (!begunTurns.ok) return;
		expectConserved(begunTurns.state, catalog);

		// Drive the turn loop to completion regardless of the seed's Initiative
		// order (king/queen/major values vary), so the assertions below hold
		// for any deterministic-but-arbitrary order this fixture produces.
		let current = begunTurns.state;
		let guard = 0;
		let playedFool = false;
		for (;;) {
			if (++guard > 20) throw new Error('turn loop did not terminate');
			const challenge = readChallengeState(current);
			if (!challenge || challenge.activeTurnIndex === null) break;
			const active = challenge.initiativeOrder[challenge.activeTurnIndex];

			if (challenge.participantTenureIds.includes(active.tenureId)) {
				const actor = TENURE_OWNERS[active.tenureId] === 'user-alice' ? aliceCtx : bobCtx;
				const hand = findZoneDescriptor(current, challengeHandZoneId(active.tenureId));
				if (!playedFool && hand?.cards.includes('fool')) {
					const pairedCardId = hand.cards.find((id) => id !== 'fool')!;
					const result = applyChallengeCommand(current, { type: 'play-fool', tenureId: active.tenureId, pairedCardId }, materials, actor);
					expect(result.ok).toBe(true);
					if (!result.ok) throw result;
					current = result.state;
					playedFool = true;
				} else if (hand && hand.cards.length > 0) {
					const played = applyChallengeCommand(current, { type: 'play-action', tenureId: active.tenureId, cardId: hand.cards[0] }, materials, actor);
					expect(played.ok).toBe(true);
					if (!played.ok) throw played;
					current = played.state;
				}
				// Every seat's turn — whether it just played (an ordinary action OR
				// the Fool's interrupt-plus-paired-action) or had nothing left to
				// play — always ends explicitly; `endTurn` never requires a play.
				const ended = applyChallengeCommand(current, { type: 'end-turn' }, materials, actor);
				expect(ended.ok).toBe(true);
				if (!ended.ok) throw ended;
				current = ended.state;
			} else {
				const gmHand = findZoneDescriptor(current, 'gmHand');
				const cardId = gmHand?.cards[0];
				if (cardId) {
					const played = applyChallengeCommand(current, { type: 'gm-play', cardId }, materials, gmCtx);
					expect(played.ok).toBe(true);
					if (!played.ok) throw played;
					current = played.state;
				}
				const ended = applyChallengeCommand(current, { type: 'end-turn' }, materials, gmCtx);
				expect(ended.ok).toBe(true);
				if (!ended.ok) throw ended;
				current = ended.state;
			}
		}
		expect(playedFool).toBe(true);
		expectConserved(current, catalog);

		const cleaned = applyChallengeCommand(current, { type: 'cleanup-round' }, materials, gmCtx);
		expect(cleaned.ok).toBe(true);
		if (!cleaned.ok) return;
		expect(readChallengeState(cleaned.state)).toMatchObject({ stage: 'deal', round: 2 });
		expectConserved(cleaned.state, catalog);
	});

	it('rejects a command absent from the derived legal set outright, before ever reaching the underlying mechanism (illegal-command)', () => {
		const seed = 'command-illegal';
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		// No active round yet — every base command except `begin-challenge` (and
		// every modifier command) must be rejected outright.
		//
		// NOTE (review round, O9): this case alone does NOT discriminate the
		// gate (`command.ts`'s `if (!legal.includes(command.type))`) from
		// `dealRound`'s OWN "no active Challenge round" guard — both reject
		// identically here, so this test still passes with the gate deleted.
		// `guard-coverage.test.ts` proves `dealRound` rejects this exact state
		// unaided. The test immediately below this one is the discriminating
		// case: it constructs a state the underlying MECHANISM would accept,
		// so only the gate's own rejection can make it pass.
		const result = applyChallengeCommand(state, { type: 'deal-round' }, materials, gmCtx);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.rejection.code).toBe('illegal-command');
	});

	it('rejects a command the underlying mechanism would ACCEPT but the derived legal set does not offer — the gate does real work, not merely mirror each command\'s own guard (O9)', () => {
		// `spendCard` (`turns.ts`) rejects a second MINOR action once
		// `actionTaken` is true, but never checks `actionTaken` for a second
		// FULL action — only the numeric cap (`cardsThisTurn >= cap`). With the
		// real content pack's `cardsPerInitiativeTurn: 1`, that gap is
		// unreachable (one card already exhausts the cap, so the cap check
		// alone would also reject a second action — no case exists where the
		// gate's `illegal-command` differs from what `spendCard` would have
		// said anyway). Raising the cap to 2 — a value the type permits even
		// though no real content uses it — makes the gap reachable: after one
		// full action, `cardsThisTurn` is 1, still under a cap of 2, so
		// `spendCard` would happily accept a SECOND full action. The
		// derivation still correctly withholds `play-action` once
		// `actionTaken` is true regardless of the cap — so only the gate
		// stands between "mechanism would accept" and "actually rejected."
		const seed = 'command-gate-not-mirrored';
		const raisedCap: ChallengeConfig = { ...config, cardsPerInitiativeTurn: 2 };
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, raisedCap, seed);
		const begun = applyChallengeCommand(
			state,
			{ type: 'begin-challenge', participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] },
			materials,
			gmCtx
		);
		if (!begun.ok) throw begun;
		const dealt = applyChallengeCommand(begun.state, { type: 'deal-round' }, materials, gmCtx);
		if (!dealt.ok) throw dealt;
		const forced = forceHand(dealt.state, 'tenure-1', ['wands-king', 'swords-vii', 'cups-ii']);
		const aliceCtx = ctxFor(ALICE, catalog, raisedCap, seed);
		const placed = applyChallengeCommand(forced, { type: 'place-initiative', tenureId: 'tenure-1', cardId: 'wands-king' }, materials, aliceCtx);
		if (!placed.ok) throw placed;
		const revealed = applyChallengeCommand(placed.state, { type: 'reveal-initiative' }, materials, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = applyChallengeCommand(revealed.state, { type: 'begin-turns' }, materials, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		// Alice takes her one full action this turn: budget becomes
		// {cardsThisTurn: 1, actionTaken: true} — still under the raised cap.
		const firstAction = applyChallengeCommand(
			begunTurns.state,
			{ type: 'play-action', tenureId: 'tenure-1', cardId: 'swords-vii' },
			materials,
			aliceCtx
		);
		if (!firstAction.ok) throw firstAction;

		// The derivation correctly withholds a second `play-action`...
		expect(legalChallengeBaseCommands(firstAction.state, ALICE, raisedCap)).not.toContain('play-action');

		// ...but calling the underlying mechanism DIRECTLY (bypassing the gate
		// entirely) for that same second action succeeds — proving this is a
		// real gap the gate alone closes, not a case every mechanism already
		// guards redundantly.
		const mechanismDirect = applyPlayerAction(firstAction.state, 'tenure-1', 'cups-ii', aliceCtx);
		expect(mechanismDirect.ok).toBe(true);

		// Through the real entry point, the SAME second action is rejected —
		// by the gate, with a message only the gate produces (never
		// `spendCard`'s own "no card budget remaining"/"cannot perform a minor
		// action..." text, since the mechanism itself never even runs).
		const secondAction = applyChallengeCommand(
			firstAction.state,
			{ type: 'play-action', tenureId: 'tenure-1', cardId: 'cups-ii' },
			materials,
			aliceCtx
		);
		expect(secondAction.ok).toBe(false);
		if (secondAction.ok) return;
		expect(secondAction.rejection.code).toBe('illegal-command');
		expect(secondAction.rejection.message).toBe('play-action is not currently offered to this actor');
	});

	describe('O1 footgun — hasBow/hasShield fail closed (must be threaded through, not merely defaulted)', () => {
		const seed = 'command-equipment';

		function readySoloTurnWithEquipment(materialsForTurn: ChallengeModifierMaterials) {
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const begun = applyChallengeCommand(
				state,
				{ type: 'begin-challenge', participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] },
				materialsForTurn,
				gmCtx
			);
			if (!begun.ok) throw begun;
			const dealt = applyChallengeCommand(begun.state, { type: 'deal-round' }, materialsForTurn, gmCtx);
			if (!dealt.ok) throw dealt;
			const forced = forceHand(dealt.state, 'tenure-1', ['wands-king', 'swords-vii', 'cups-ii']);
			const aliceCtx = ctxFor(ALICE, catalog, config, seed);
			const placed = applyChallengeCommand(forced, { type: 'place-initiative', tenureId: 'tenure-1', cardId: 'wands-king' }, materialsForTurn, aliceCtx);
			if (!placed.ok) throw placed;
			const revealed = applyChallengeCommand(placed.state, { type: 'reveal-initiative' }, materialsForTurn, gmCtx);
			if (!revealed.ok) throw revealed;
			const begunTurns = applyChallengeCommand(revealed.state, { type: 'begin-turns' }, materialsForTurn, gmCtx);
			if (!begunTurns.ok) throw begunTurns;
			return { state: begunTurns.state, aliceCtx };
		}

		it('offers aim-prepare/replace-initiative-with-shield when the caller supplies hasBow/hasShield: true', () => {
			const withEquipment = buildChallengeModifierMaterials(modifiers, { hasBow: true, hasShield: true });
			const { state, aliceCtx } = readySoloTurnWithEquipment(withEquipment);
			const legal = legalChallengeCommands(state, ALICE, config, {
				counselMaxUsesPerRound: withEquipment.counsel.maxUsesPerRound,
				guardianAngelMaxInstances: withEquipment.guardianAngel.maxInstances,
				hasBow: true,
				hasShield: true
			});
			expect(legal).toContain('aim-prepare');
			expect(legal).toContain('replace-initiative-with-shield');
			void aliceCtx;
		});

		it('hides aim-prepare/replace-initiative-with-shield when equipment is omitted — the fail-closed default (O1)', () => {
			const withoutEquipment = buildChallengeModifierMaterials(modifiers, { hasBow: false, hasShield: false });
			const { state } = readySoloTurnWithEquipment(withoutEquipment);
			const legal = legalChallengeCommands(state, ALICE, config, {
				counselMaxUsesPerRound: withoutEquipment.counsel.maxUsesPerRound,
				guardianAngelMaxInstances: withoutEquipment.guardianAngel.maxInstances
				// hasBow/hasShield omitted entirely — must fail closed, not throw.
			});
			expect(legal).not.toContain('aim-prepare');
			expect(legal).not.toContain('replace-initiative-with-shield');
		});
	});

	it('legalChallengeBaseCommands offers begin-challenge to the GM only when no procedure is already active', () => {
		const state = makeSessionFixture('command-begin-gate');
		expect(legalChallengeBaseCommands(state, GM, config)).toEqual(['begin-challenge']);
		expect(legalChallengeBaseCommands(state, ALICE, config)).toEqual([]);
	});

	it('never offers a card-spending base command once its per-turn budget is exhausted', () => {
		const seed = 'command-budget-exhausted';
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = applyChallengeCommand(
			state,
			{ type: 'begin-challenge', participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] },
			materials,
			gmCtx
		);
		if (!begun.ok) throw begun;
		const dealt = applyChallengeCommand(begun.state, { type: 'deal-round' }, materials, gmCtx);
		if (!dealt.ok) throw dealt;
		const forced = forceHand(dealt.state, 'tenure-1', ['wands-king', 'swords-vii', 'cups-ii']);
		const aliceCtx = ctxFor(ALICE, catalog, config, seed);
		const placed = applyChallengeCommand(forced, { type: 'place-initiative', tenureId: 'tenure-1', cardId: 'wands-king' }, materials, aliceCtx);
		if (!placed.ok) throw placed;
		const revealed = applyChallengeCommand(placed.state, { type: 'reveal-initiative' }, materials, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = applyChallengeCommand(revealed.state, { type: 'begin-turns' }, materials, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		expect(legalChallengeBaseCommands(begunTurns.state, ALICE, config)).toContain('play-action');
		const played = applyChallengeCommand(begunTurns.state, { type: 'play-action', tenureId: 'tenure-1', cardId: 'swords-vii' }, materials, aliceCtx);
		if (!played.ok) throw played;

		// The one-card-per-turn budget is now spent — neither a further action
		// nor a minor action should be offered.
		const legalAfter = legalChallengeBaseCommands(played.state, ALICE, config);
		expect(legalAfter).not.toContain('play-action');
		expect(legalAfter).not.toContain('play-minor-action');
		expect(legalAfter).toContain('end-turn');
	});

	it('dispatches play-minor-action, gm-minor-action, gm-discard, gm-mulligan, and cleanup-round(options) through applyChallengeCommand', () => {
		const seed = 'command-remaining-dispatch';
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = applyChallengeCommand(
			state,
			{ type: 'begin-challenge', participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: oneOgre },
			materials,
			gmCtx
		);
		if (!begun.ok) throw begun;
		const dealt = applyChallengeCommand(begun.state, { type: 'deal-round' }, materials, gmCtx);
		if (!dealt.ok) throw dealt;
		let working = forceHand(dealt.state, 'tenure-1', ['wands-king', 'cups-ii']);
		working = forceGmHand(working, ['hanged-man', 'wheel-of-fortune']);
		const aliceCtx = ctxFor(ALICE, catalog, config, seed);

		const placedAlice = applyChallengeCommand(working, { type: 'place-initiative', tenureId: 'tenure-1', cardId: 'wands-king' }, materials, aliceCtx);
		if (!placedAlice.ok) throw placedAlice;
		const placedGm = applyChallengeCommand(
			placedAlice.state,
			{ type: 'place-gm-initiative', enemyFactId: 'ogre-1', cardId: 'hanged-man' },
			materials,
			gmCtx
		);
		if (!placedGm.ok) throw placedGm;
		const revealed = applyChallengeCommand(placedGm.state, { type: 'reveal-initiative' }, materials, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = applyChallengeCommand(revealed.state, { type: 'begin-turns' }, materials, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		// Whichever seat goes first, drive both a player minor action and a GM
		// minor action, a GM discard, and a GM mulligan — all through the one
		// combined dispatcher — then close the round with an explicit
		// `enemyFacts` override on `cleanup-round`, exercising the `options`
		// parameter.
		let current = begunTurns.state;
		const firstActive = readChallengeState(current)!.initiativeOrder[0];
		if (firstActive.tenureId === 'tenure-1') {
			const minor = applyChallengeCommand(current, { type: 'play-minor-action', tenureId: 'tenure-1', cardId: 'cups-ii', actionSuit: 'cups' }, materials, aliceCtx);
			expect(minor.ok).toBe(true);
			if (!minor.ok) throw minor;
			current = minor.state;
			const ended = applyChallengeCommand(current, { type: 'end-turn' }, materials, aliceCtx);
			if (!ended.ok) throw ended;
			current = ended.state;

			const gmMinor = applyChallengeCommand(current, { type: 'gm-minor-action', cardId: 'wheel-of-fortune' }, materials, gmCtx);
			expect(gmMinor.ok).toBe(true);
			if (!gmMinor.ok) throw gmMinor;
			current = gmMinor.state;
		} else {
			const gmMinor = applyChallengeCommand(current, { type: 'gm-minor-action', cardId: 'wheel-of-fortune' }, materials, gmCtx);
			expect(gmMinor.ok).toBe(true);
			if (!gmMinor.ok) throw gmMinor;
			current = gmMinor.state;
			const ended = applyChallengeCommand(current, { type: 'end-turn' }, materials, gmCtx);
			if (!ended.ok) throw ended;
			current = ended.state;

			const minor = applyChallengeCommand(current, { type: 'play-minor-action', tenureId: 'tenure-1', cardId: 'cups-ii', actionSuit: 'cups' }, materials, aliceCtx);
			expect(minor.ok).toBe(true);
			if (!minor.ok) throw minor;
			current = minor.state;
		}

		const discarded = applyChallengeCommand(current, { type: 'gm-discard', cardId: 'wheel-of-fortune' }, materials, gmCtx);
		// May already have been spent as the GM's minor action above depending
		// on seat order — either outcome is fine; only the OTHER remaining GM
		// card is guaranteed still in hand, so fall back to it.
		const gmHandAfter = findZoneDescriptor(current, 'gmHand');
		const stillHeld = gmHandAfter?.cards[0];
		const finalDiscard = discarded.ok ? discarded : stillHeld ? applyChallengeCommand(current, { type: 'gm-discard', cardId: stillHeld }, materials, gmCtx) : discarded;
		if (finalDiscard.ok) current = finalDiscard.state;

		const mulligan = applyChallengeCommand(current, { type: 'gm-mulligan' }, materials, gmCtx);
		expect(mulligan.ok).toBe(true);
		if (!mulligan.ok) throw mulligan;
		current = mulligan.state;

		const cleaned = applyChallengeCommand(
			current,
			{ type: 'cleanup-round', options: { enemyFacts: oneOgre } },
			materials,
			gmCtx
		);
		expect(cleaned.ok).toBe(true);
		if (!cleaned.ok) throw cleaned;
		expect(readChallengeState(cleaned.state)).toMatchObject({ round: 2, enemyFacts: oneOgre });
		expectConserved(cleaned.state, catalog);
	});
});
