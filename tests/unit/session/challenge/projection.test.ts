/**
 * `projectChallengeForActor` (Increment 3 Task 6) — the Challenge procedure's
 * own actor-scoped projection, additive alongside the generic
 * `SessionPlayerProjection`/`SessionGmProjection`. Covers the two footguns
 * the brief names explicitly: O4's double-render hazard (the Fool's extra
 * turn shares its `cardZoneId` with the entry it clones) and O3's tie
 * surfacing (a tie must be visible, never auto-resolved).
 */
import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig, ChallengeEnemyFact } from '$lib/engine/session/procedures/challenge/types';
import { challengeHandZoneId, readChallengeState, writeChallengeState, CHALLENGE_GUARDIAN_ANGEL_ID, type ChallengeReduceContext } from '$lib/engine/session/procedures/challenge/reducer';
import { applyChallengeCommand, buildChallengeModifierMaterials } from '$lib/engine/session/procedures/challenge/command';
import { projectChallengeForActor, type ChallengeGmProjection, type ChallengePlayerProjection } from '$lib/engine/session/procedures/challenge/projection';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { makeRng } from '$lib/engine/rng';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';
import type { ChallengeModifierMaterials } from '$lib/engine/session/procedures/challenge/modifiers';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };
const BOB: SessionActor = { kind: 'player', userId: 'user-bob' };
const TENURE_OWNERS: Record<string, string> = { 'tenure-1': 'user-alice', 'tenure-2': 'user-bob' };

function ctxFor(actor: SessionActor, catalog: TarotCardCatalog, config: ChallengeConfig, seed: string): ChallengeReduceContext {
	return { actor, runtime: { catalog }, rng: makeRng(seed), config };
}

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

describe('projectChallengeForActor (Increment 3 Task 6)', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas, modifiers } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);
	const materials: ChallengeModifierMaterials = buildChallengeModifierMaterials(modifiers, { hasBow: false, hasShield: false });
	const modifierCaps = { counselMaxUsesPerRound: materials.counsel.maxUsesPerRound, guardianAngelMaxInstances: materials.guardianAngel.maxInstances };

	it('returns null when no Challenge round is active', () => {
		const state = makeSessionFixture('projection-none');
		expect(projectChallengeForActor(state, GM, catalog, config, modifierCaps)).toBeNull();
	});

	it('O4 — the Fool grants a genuinely duplicate-hazardous entry, and index is the only key that stays unique', () => {
		const seed = 'projection-fool-double-render';
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
		const forced = forceHand(dealt.state, 'tenure-1', ['wands-king', 'fool', 'cups-v']);
		const aliceCtx = ctxFor(ALICE, catalog, config, seed);
		const placed = applyChallengeCommand(forced, { type: 'place-initiative', tenureId: 'tenure-1', cardId: 'wands-king' }, materials, aliceCtx);
		if (!placed.ok) throw placed;
		const revealed = applyChallengeCommand(placed.state, { type: 'reveal-initiative' }, materials, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = applyChallengeCommand(revealed.state, { type: 'begin-turns' }, materials, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		const fooled = applyChallengeCommand(begunTurns.state, { type: 'play-fool', tenureId: 'tenure-1', pairedCardId: 'cups-v' }, materials, aliceCtx);
		if (!fooled.ok) throw fooled;

		const projection = projectChallengeForActor(fooled.state, GM, catalog, config, modifierCaps) as ChallengeGmProjection;
		expect(projection).not.toBeNull();
		expect(projection.initiativeOrder).toHaveLength(2);

		// The hazard, proven directly: a naive key on tenureId+cardId+cardZoneId
		// COLLIDES for these two entries (they really do share every one of
		// those fields — `fool.ts`'s clone) ...
		const naiveKeys = projection.initiativeOrder.map((entry) => `${entry.tenureId}|${entry.card?.hidden ? 'hidden' : entry.card?.id}`);
		expect(new Set(naiveKeys).size).toBeLessThan(projection.initiativeOrder.length);

		// ... while `index` never does — this is what a component must key on.
		const indices = projection.initiativeOrder.map((entry) => entry.index);
		expect(new Set(indices).size).toBe(projection.initiativeOrder.length);
		expect(projection.initiativeOrder[1]).toMatchObject({ turnKind: 'fool-extra', tenureId: 'tenure-1' });
	});

	it('O3 — a tie is surfaced (tied: true, tiedGroups populated) and never auto-resolved into a decided order', () => {
		const seed = 'projection-tie';
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = applyChallengeCommand(
			state,
			{ type: 'begin-challenge', participantTenureIds: ['tenure-1', 'tenure-2'], tenureOwners: TENURE_OWNERS, enemyFacts: [] },
			materials,
			gmCtx
		);
		if (!begun.ok) throw begun;
		const dealt = applyChallengeCommand(begun.state, { type: 'deal-round' }, materials, gmCtx);
		if (!dealt.ok) throw dealt;
		// Same value (V), different suit — a genuine tie, not a coincidence of
		// identical cards (impossible; each card id is unique).
		let working = forceHand(dealt.state, 'tenure-1', ['wands-v']);
		working = forceHand(working, 'tenure-2', ['cups-v']);
		const aliceCtx = ctxFor(ALICE, catalog, config, seed);
		const bobCtx = ctxFor(BOB, catalog, config, seed);
		const placedAlice = applyChallengeCommand(working, { type: 'place-initiative', tenureId: 'tenure-1', cardId: 'wands-v' }, materials, aliceCtx);
		if (!placedAlice.ok) throw placedAlice;
		const placedBob = applyChallengeCommand(placedAlice.state, { type: 'place-initiative', tenureId: 'tenure-2', cardId: 'cups-v' }, materials, bobCtx);
		if (!placedBob.ok) throw placedBob;
		const revealed = applyChallengeCommand(placedBob.state, { type: 'reveal-initiative' }, materials, gmCtx);
		if (!revealed.ok) throw revealed;

		const projection = projectChallengeForActor(revealed.state, GM, catalog, config, modifierCaps) as ChallengeGmProjection;
		expect(projection.tiedGroups).toEqual([expect.arrayContaining(['tenure-1', 'tenure-2'])]);
		expect(projection.initiativeOrder.every((entry) => entry.tied)).toBe(true);
		// Surfaced, not decided: nothing about the projection picks a winner —
		// there is no field naming who "goes first" among the tied pair beyond
		// their (practical-default) array order, and `tiedGroups` itself is the
		// signal a component must render as a table decision.
	});

	it('strips a modifier instance`s cardId from the projection for every actor, including the owner and target (the real card lives in their own private zone view instead)', () => {
		// I7: this test previously created NO modifier instance and asserted
		// `modifiers === []` — vacuously true even if the projection leaked
		// cardId. Now it actually plants a Guardian Angel ward (a
		// `ChallengeModifierState` WITH a cardId — the branch's central privacy
		// contract) and proves the cardId is stripped for every viewer.
		const seed = 'projection-modifier-cardid';
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = applyChallengeCommand(
			state,
			{ type: 'begin-challenge', participantTenureIds: ['tenure-1', 'tenure-2'], tenureOwners: TENURE_OWNERS, enemyFacts: [] },
			materials,
			gmCtx
		);
		if (!begun.ok) throw begun;

		const challenge = readChallengeState(begun.state)!;
		const secretCardId = 'wands-v';
		const withWard = writeChallengeState(begun.state, {
			...challenge,
			modifiers: [
				{
					instanceId: `${CHALLENGE_GUARDIAN_ANGEL_ID}:tenure-1:1:0`,
					modifierId: CHALLENGE_GUARDIAN_ANGEL_ID,
					ownerTenureId: 'tenure-1',
					targetTenureId: 'tenure-2',
					status: 'active',
					cardId: secretCardId
				}
			]
		});

		// The cardId must be absent from the projected modifier view for EVERY
		// actor — the caster (owner), the ward's target, and the GM alike.
		for (const actor of [GM, ALICE, BOB]) {
			const projection = projectChallengeForActor(withWard, actor, catalog, config, modifierCaps);
			expect(projection).not.toBeNull();
			expect(projection!.modifiers).toHaveLength(1);
			const view = projection!.modifiers[0];
			// The bookkeeping fields ARE present...
			expect(view).toMatchObject({ modifierId: CHALLENGE_GUARDIAN_ANGEL_ID, ownerTenureId: 'tenure-1', targetTenureId: 'tenure-2', status: 'active' });
			// ...but the secret card identity is NOT, on any channel of this view.
			expect('cardId' in view).toBe(false);
			expect(JSON.stringify(view)).not.toContain(secretCardId);
		}
	});

	it('O1 — projection.legalCommands is EXACTLY the set the actor may issue in a given state (render buttons only from this list)', () => {
		const seed = 'projection-legal-commands';
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = applyChallengeCommand(
			state,
			{ type: 'begin-challenge', participantTenureIds: ['tenure-1', 'tenure-2'], tenureOwners: TENURE_OWNERS, enemyFacts: [] },
			materials,
			gmCtx
		);
		if (!begun.ok) throw begun;

		// Fresh 'deal' stage: the GM may deal the round, record a Stun, or apply
		// Black Honey — and NOTHING else (no place/reveal/turn/cleanup yet).
		const gmProjection = projectChallengeForActor(begun.state, GM, catalog, config, modifierCaps)!;
		expect([...gmProjection.legalCommands].sort()).toEqual(['apply-black-honey', 'apply-stun', 'deal-round']);

		// A player at 'deal' stage may ONLY Counsel (which the book allows "any
		// time during the challenge") — no placement/turn commands yet, no
		// pending Stun, no ward to resolve, no bow/shield in these materials.
		const playerProjection = projectChallengeForActor(begun.state, ALICE, catalog, config, modifierCaps)!;
		expect(playerProjection.legalCommands).toEqual(['counsel-transfer']);
	});

	it('gives the GM enemyFacts but never the player (players get actingTenureId instead)', () => {
		const seed = 'projection-role-scope';
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const enemyFacts: ChallengeEnemyFact[] = [{ id: 'ogre-1', size: 'human', threat: 'minion', typeIds: ['ogre'], count: 1 }];
		const begun = applyChallengeCommand(
			state,
			{ type: 'begin-challenge', participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts },
			materials,
			gmCtx
		);
		if (!begun.ok) throw begun;

		const gmView = projectChallengeForActor(begun.state, GM, catalog, config, modifierCaps) as ChallengeGmProjection;
		expect(gmView.enemyFacts).toEqual(enemyFacts);

		const playerView = projectChallengeForActor(begun.state, ALICE, catalog, config, modifierCaps) as ChallengePlayerProjection;
		expect((playerView as unknown as ChallengeGmProjection).enemyFacts).toBeUndefined();
		expect(playerView.actingTenureId).toBe('tenure-1');
	});
});
