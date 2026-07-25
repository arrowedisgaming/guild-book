/**
 * The finite runner's actor-scoped projection and legal-command derivation
 * (Increment 4 Task 4). Same parallel-slice discipline as the Challenge, guided
 * test, and Camp projectors: `state.procedure.gmPrivate` is opaque to the
 * generic engine, and this is the only door out.
 *
 * The one per-actor disclosure: a `reorder-top` step's acting player sees the
 * top N of the draw pile (`peekTop`) — they cannot put the cards back "in any
 * order" without seeing them, and the step is `actor-private` in the pack.
 * Nobody else gets it, the GM included: the reorder is the player's reading.
 * Outcomes recorded under a non-public `resultVisibility` reach the GM alone.
 */

import type { CardSlot, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';
import type { TarotProcedureDefinition, TarotProcedureStepDefinition } from '$lib/types/content-pack';
import { hydrateVisible } from '../projection';
import { findZoneDescriptor } from '../state';
import {
	finiteZoneId,
	isRunnerProcedure,
	readFiniteProcedure,
	type FiniteMaterials,
	type FiniteProcedureStateV1,
	type StoredOutcome
} from './finite-procedure';

export type FiniteControl = 'begin-finite-procedure' | 'advance-finite-procedure' | 'complete-finite-procedure';

export interface FiniteStepView {
	stepId: string;
	operation: TarotProcedureStepDefinition['operation'];
	actor: TarotProcedureStepDefinition['actor'];
	/** What `advance` needs from the actor right now. */
	needs: 'nothing' | 'confirm' | 'chosen-card' | 'ordered-cards';
	/** choose-one options (card ids from the source step's draws). */
	options: string[];
}

export interface FiniteProcedureView {
	procedureId: string;
	title: string;
	actorTenureId: string | null;
	currentStep: FiniteStepView | null;
	/** Public outcomes, in recorded order. GM-private ones are omitted for
	 * players and included for the GM. */
	outcomes: Array<{ stepId: string; outcome: StoredOutcome }>;
	manual: Record<string, string>;
	completedSteps: string[];
	skippedSteps: string[];
	completed: boolean;
	/** Cards face-up in the procedure's public zone. */
	tableCards: CardSlot[];
	/** The reorder step's private peek — acting player only. */
	peekTop: CardSlot[];
}

export interface FiniteProjection {
	procedure: FiniteProcedureView | null;
	/** Procedure ids the viewer may begin right now (empty while one runs). */
	beginnable: string[];
	controls: FiniteControl[];
}

function actingFacts(actor: SessionActor, materials: FiniteMaterials, tenureId: string | null) {
	if (!tenureId) return undefined;
	return materials.actors.find((candidate) => candidate.tenureId === tenureId);
}

function ownsStep(step: TarotProcedureStepDefinition, runner: FiniteProcedureStateV1, actor: SessionActor, materials: FiniteMaterials): boolean {
	if (step.actor === 'gm' || step.actor === 'system') return actor.kind === 'gm';
	if (step.actor === 'player') {
		const facts = actingFacts(actor, materials, runner.actorTenureId);
		return facts !== undefined && actor.kind === 'player' && actor.userId === facts.userId;
	}
	// each-player: any attached player who has not yet acted.
	if (actor.kind !== 'player') return false;
	const mine = materials.actors.find((candidate) => candidate.userId === actor.userId);
	return mine !== undefined && !runner.eachPlayerDone.includes(mine.tenureId);
}

/** Mirrors the runner's own skip walk (conditions + choose-one legality are
 * re-evaluated server-side on advance; this is display-only). */
function currentStepOf(procedure: TarotProcedureDefinition, runner: FiniteProcedureStateV1): TarotProcedureStepDefinition | null {
	for (let index = runner.stepIndex; index < procedure.steps.length; index += 1) {
		const step = procedure.steps[index];
		if (runner.skippedSteps.includes(step.id) || runner.completedSteps.includes(step.id)) continue;
		return step;
	}
	return null;
}

function needsOf(step: TarotProcedureStepDefinition): FiniteStepView['needs'] {
	if (step.operation === 'manual-choice') return step.choice?.kind === 'choose-one' ? 'chosen-card' : 'confirm';
	if (step.operation === 'reorder-top') return 'ordered-cards';
	return 'nothing';
}

export function legalFiniteCommands(
	state: SessionEngineStateV1,
	actor: SessionActor,
	materials: FiniteMaterials,
	procedures: readonly TarotProcedureDefinition[]
): FiniteControl[] {
	const runner = readFiniteProcedure(state);
	if (!runner) {
		if (state.procedure !== null) return [];
		// The GM may begin any runner procedure; a player may begin one for their
		// own adventurer (the begin command names the tenure).
		if (actor.kind === 'gm') return ['begin-finite-procedure'];
		return materials.actors.some((candidate) => candidate.userId === actor.userId) ? ['begin-finite-procedure'] : [];
	}
	const procedure = procedures.find((candidate) => candidate.id === runner.procedureId);
	if (!procedure) return [];
	const step = currentStepOf(procedure, runner);
	const controls: FiniteControl[] = [];
	if (step && ownsStep(step, runner, actor, materials)) controls.push('advance-finite-procedure');
	const facts = actingFacts(actor, materials, runner.actorTenureId);
	const isOwner = facts !== undefined && actor.kind === 'player' && actor.userId === facts.userId;
	if (actor.kind === 'gm' || isOwner) controls.push('complete-finite-procedure');
	return controls;
}

export function projectFiniteForActor(
	state: SessionEngineStateV1,
	actor: SessionActor,
	catalog: TarotCardCatalog,
	materials: FiniteMaterials,
	procedures: readonly TarotProcedureDefinition[]
): FiniteProjection {
	const runner = readFiniteProcedure(state);
	const controls = legalFiniteCommands(state, actor, materials, procedures);

	if (!runner) {
		const beginnable = controls.includes('begin-finite-procedure')
			? procedures.filter((candidate) => isRunnerProcedure(candidate.id)).map((candidate) => candidate.id)
			: [];
		return { procedure: null, beginnable, controls };
	}
	const procedure = procedures.find((candidate) => candidate.id === runner.procedureId);
	if (!procedure) return { procedure: null, beginnable: [], controls: [] };

	const step = currentStepOf(procedure, runner);
	const stepView: FiniteStepView | null = step
		? {
				stepId: step.id,
				operation: step.operation,
				actor: step.actor,
				needs: needsOf(step),
				options: step.choice?.kind === 'choose-one' ? (runner.draws[step.choice.fromStepId] ?? []) : []
			}
		: null;

	// GM-private outcomes reach the GM alone; the pack marks everything else
	// public, so a player sees exactly the public record.
	const outcomes = Object.entries(runner.outcomes)
		.filter(([stepId]) => {
			const definition = procedure.steps.find((candidate) => stepId === candidate.id || stepId.startsWith(`${candidate.id}:`));
			return definition?.resultVisibility === 'public' || actor.kind === 'gm';
		})
		.map(([stepId, outcome]) => ({ stepId, outcome }));

	// The reorder peek: acting player only, only while the reorder is current.
	let peekTop: CardSlot[] = [];
	if (step?.operation === 'reorder-top' && step.draw?.kind === 'fixed' && ownsStep(step, runner, actor, materials) && actor.kind === 'player') {
		const pile = step.deck === 'major' ? state.majorDraw : state.playerDraw;
		peekTop = pile.slice(0, step.draw.count).map((cardId) => hydrateVisible(cardId, catalog));
	}

	return {
		procedure: {
			procedureId: runner.procedureId,
			title: procedure.title,
			actorTenureId: runner.actorTenureId,
			currentStep: stepView,
			outcomes,
			manual: runner.manual,
			completedSteps: runner.completedSteps,
			skippedSteps: runner.skippedSteps,
			completed: runner.completed,
			tableCards: (findZoneDescriptor(state, finiteZoneId(runner.procedureId))?.cards ?? []).map((cardId) => hydrateVisible(cardId, catalog)),
			peekTop
		},
		beginnable: [],
		controls
	};
}
