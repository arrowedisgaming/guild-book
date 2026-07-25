/**
 * The Camp procedures' own actor-scoped projection and legal-command derivation
 * (Increment 4 Task 3). A parallel, additive slice alongside the generic
 * projection, exactly like `challenge/projection.ts` and
 * `guided-test-projection.ts`.
 *
 * ## What is withheld, and from whom
 *
 * An inspiration card's FACE reaches its holder and nobody else — not a
 * bystanding player, not the GM. That is the whole point of routing High Chant
 * through a private per-recipient zone (see `camp.ts`'s file header): every
 * viewer sees the COUNT each adventurer holds, which is what makes Ch5's "No
 * player can ever have more than one inspiration card" publicly checkable,
 * while `myInspiration` hydrates a real card only for the actor who owns it.
 *
 * A performer's undistributed selection is likewise count-only to everyone but
 * the performer: they pulled those cards from a public discard pile in the open,
 * but which of them is destined for whom is theirs to decide before they hand it
 * over.
 *
 * Leeches is entirely public — the pack's steps are `visibility: 'public'` — so
 * its drawn card and outcome are hydrated for every viewer.
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { SuitId } from '$lib/types/common';
import type { CardSlot, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';
import { hydrateVisible } from '../projection';
import { findZoneDescriptor } from '../state';
import {
	highChantSelectionZoneId,
	inspirationZoneId,
	readCampProcedure,
	type CampActorFacts,
	type CampConfig,
	type CampMaterials,
	type HighChantStage,
	type LeechesOutcome,
	type LeechesStage
} from './camp';

export type CampControl =
	| 'begin-high-chant'
	| 'select-inspiration'
	| 'complete-high-chant-transfer'
	| 'begin-leeches'
	| 'advance-leeches'
	| 'complete-camp-procedure';

/** How many inspiration cards one adventurer holds. Public for every viewer —
 * counts, never faces. */
export interface InspirationHoldingView {
	tenureId: string;
	count: number;
	/** At most one per the pack's cap; carried so a panel can render the cap
	 * without restating it. */
	atCap: boolean;
}

export interface HighChantView {
	stage: HighChantStage;
	performerTenureId: string;
	allowance: number;
	/** True when the viewer is the performer. */
	isMine: boolean;
	/** Count of cards pulled but not yet handed over — public. */
	undistributedCount: number;
	/** The performer's own undistributed cards, hydrated. Empty for every other
	 * viewer. */
	mySelection: CardSlot[];
	assignments: Array<{ recipientTenureId: string }>;
}

export interface LeechesView {
	stage: LeechesStage;
	actorTenureId: string;
	targetTenureId: string;
	isMine: boolean;
	/** Public: the pack makes every leeches step `visibility: 'public'`. */
	drawnCard: CardSlot | null;
	outcome: LeechesOutcome | null;
	/** The two suit sets, straight from content, so the panel can explain the
	 * rule before the draw without restating it. */
	noEffectSuits: SuitId[];
	cureSuits: SuitId[];
}

export interface CampProjection {
	highChant: HighChantView | null;
	leeches: LeechesView | null;
	/** Every adventurer's inspiration count — visible to all, faces to none. */
	inspiration: InspirationHoldingView[];
	/** The viewer's OWN inspiration card, hydrated. `null` when they hold none or
	 * are the GM (who holds no adventurer). */
	myInspiration: CardSlot | null;
	controls: CampControl[];
}

function factsFor(materials: CampMaterials, tenureId: string): CampActorFacts | undefined {
	return materials.actors.find((actor) => actor.tenureId === tenureId);
}

function actingTenure(actor: SessionActor, materials: CampMaterials): CampActorFacts | undefined {
	if (actor.kind !== 'player') return undefined;
	return materials.actors.find((candidate) => candidate.userId === actor.userId);
}

function ownsTenure(actor: SessionActor, materials: CampMaterials, tenureId: string): boolean {
	const facts = factsFor(materials, tenureId);
	return facts !== undefined && actor.kind === 'player' && actor.userId === facts.userId;
}

function cardsIn(state: SessionEngineStateV1, zoneId: string): string[] {
	return findZoneDescriptor(state, zoneId)?.cards ?? [];
}

/**
 * The Camp command types `actor` may attempt right now — coarse, role + stage
 * based, exactly like `legalChallengeCommands`. Never promises a specific
 * instance would be accepted.
 */
export function legalCampCommands(
	state: SessionEngineStateV1,
	actor: SessionActor,
	materials: CampMaterials,
	config: CampConfig
): CampControl[] {
	const camp = readCampProcedure(state);

	if (!camp) {
		// Nothing running. Only an adventurer at the table may start a Camp
		// action, and only when no OTHER procedure holds the slot (a Challenge
		// round, say) — the same gate the transitions themselves enforce.
		if (state.procedure !== null) return [];
		const mine = actingTenure(actor, materials);
		if (!mine) return [];
		// Leeches needs somebody else to apply them to (Ch9: "another
		// adventurer"), so it is not offered at a table of one.
		const others = materials.actors.filter((candidate) => candidate.tenureId !== mine.tenureId);
		return others.length > 0 ? ['begin-high-chant', 'begin-leeches'] : ['begin-high-chant'];
	}

	if (camp.kind === 'high-chant') {
		const isPerformer = ownsTenure(actor, materials, camp.performerTenureId);
		if (isPerformer && camp.stage === 'select') return ['select-inspiration'];
		if (camp.stage === 'distribute') {
			const undistributed = camp.selectedCardIds.filter(
				(cardId) => !camp.assignments.some((assignment) => assignment.cardId === cardId)
			);
			const controls: CampControl[] = [];
			// Only offer a hand-over when the performer holds a card AND somebody is
			// still under the cap to receive it — otherwise the only move left is to
			// finish and return the remainder.
			const someoneCanReceive = materials.actors.some(
				(candidate) => cardsIn(state, inspirationZoneId(candidate.tenureId)).length < config.maxInspirationPerPlayer
			);
			if (isPerformer && undistributed.length > 0 && someoneCanReceive) controls.push('complete-high-chant-transfer');
			if (isPerformer || actor.kind === 'gm') controls.push('complete-camp-procedure');
			return controls;
		}
		return isPerformer || actor.kind === 'gm' ? ['complete-camp-procedure'] : [];
	}

	// Leeches.
	const isApplier = ownsTenure(actor, materials, camp.actorTenureId);
	if (camp.stage === 'draw') return isApplier ? ['advance-leeches'] : [];
	return isApplier || actor.kind === 'gm' ? ['complete-camp-procedure'] : [];
}

/** Builds the Camp slice `actor` is authorized to see. */
export function projectCampForActor(
	state: SessionEngineStateV1,
	actor: SessionActor,
	catalog: TarotCardCatalog,
	materials: CampMaterials,
	config: CampConfig
): CampProjection {
	const camp = readCampProcedure(state);
	const mine = actingTenure(actor, materials);

	const inspiration: InspirationHoldingView[] = materials.actors.map((candidate) => {
		const count = cardsIn(state, inspirationZoneId(candidate.tenureId)).length;
		return { tenureId: candidate.tenureId, count, atCap: count >= config.maxInspirationPerPlayer };
	});

	const myInspirationCardId = mine ? cardsIn(state, inspirationZoneId(mine.tenureId))[0] : undefined;

	let highChant: HighChantView | null = null;
	let leeches: LeechesView | null = null;

	if (camp?.kind === 'high-chant') {
		const isMine = ownsTenure(actor, materials, camp.performerTenureId);
		const undistributed = camp.selectedCardIds.filter(
			(cardId) => !camp.assignments.some((assignment) => assignment.cardId === cardId)
		);
		highChant = {
			stage: camp.stage,
			performerTenureId: camp.performerTenureId,
			allowance: camp.allowance,
			isMine,
			undistributedCount: undistributed.length,
			// Hydrated from the performer's own staging zone, and only for them.
			mySelection: isMine
				? cardsIn(state, highChantSelectionZoneId(camp.performerTenureId)).map((cardId) => hydrateVisible(cardId, catalog))
				: [],
			// Who received one is public (the transfer event says so); WHAT they
			// received is not.
			assignments: camp.assignments.map((assignment) => ({ recipientTenureId: assignment.recipientTenureId }))
		};
	}

	if (camp?.kind === 'leeches') {
		leeches = {
			stage: camp.stage,
			actorTenureId: camp.actorTenureId,
			targetTenureId: camp.targetTenureId,
			isMine: ownsTenure(actor, materials, camp.actorTenureId),
			drawnCard: camp.drawnCardId ? hydrateVisible(camp.drawnCardId, catalog) : null,
			outcome: camp.outcome,
			noEffectSuits: [...config.leechesNoEffectSuits],
			cureSuits: [...config.leechesCureSuits]
		};
	}

	return {
		highChant,
		leeches,
		inspiration,
		myInspiration: myInspirationCardId === undefined ? null : hydrateVisible(myInspirationCardId, catalog),
		controls: legalCampCommands(state, actor, materials, config)
	};
}
