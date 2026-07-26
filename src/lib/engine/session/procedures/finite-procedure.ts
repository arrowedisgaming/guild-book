/**
 * The data-driven finite procedure runner (Increment 4 Task 4 Step 2).
 *
 * For procedures expressible entirely through catalog steps — the Crawl, City,
 * sorcery, and Camp-watch procedures — the runner maps the current validated
 * content step to one generic card command, enforces its actor/visibility/
 * completion mode, advances exactly one step, and rejects unsupported
 * operations. The plan's `crawl.ts`/`augury.ts`/`oracles.ts` modules collapsed
 * into this one runner deliberately: every one of those procedures IS
 * catalog-expressible, and per Step 2's own instruction procedure-specific
 * modules exist only "where the generic runner cannot express them" — none
 * did. (Challenge, Camp High Chant/leeches, and the guided tests keep their
 * own modules: budgets, private transfers, and test arithmetic are exactly
 * the things catalog steps cannot express.)
 *
 * ## What the runner enforces vs. what the GM attests
 *
 * Conditions the runner can evaluate from its own recorded state, it does:
 * `invocation-mode` (fixed at begin), `lookup-key` and `previous-result`
 * (from recorded lookup outcomes), `percent-chance` (the flat 50% manual
 * yes/no — NEVER a card draw, per the global constraint). Conditions about
 * fiction or sheet state the engine cannot see — `game-state`
 * (guild-out-of-light), `entry-state`, a cross-procedure `lookup-key` with no
 * recorded outcome — are GM-ATTESTED: beginning/advancing the procedure is the
 * GM's statement that the trigger held. Costs and resource effects (Area
 * Sense's 2 Resolve, its visions) are reported `manualConsequence: true` and
 * never applied to a sheet (spec §8.6).
 *
 * ## The Fool on a lookup step
 *
 * The Fool has no entry on any oracle table — it is the deck's reset card
 * (value 0, no suit). A Fool drawn on a lookup step is set aside in the
 * procedure zone (it reaches the discard at completion), the boundary
 * reshuffle it scheduled stays scheduled, and a replacement is drawn so the
 * lookup resolves. Non-lookup draws keep the Fool as an ordinary card.
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import { z } from 'zod';
import type { TarotLookupTable, TarotProcedureDefinition, TarotProcedureStepDefinition, TarotStepCondition } from '$lib/types/content-pack';
import type { CardId, SessionEngineStateV1, SessionEvent, SessionRejection, TarotCardCatalogEntry } from '$lib/types/session';
import type { DrawnCard } from '$lib/tarot/protocol';
import { reduceSession, type ReduceContext } from '../reducer';
import type { ReduceResult } from '../result';
import { findZoneDescriptor } from '../state';
import { FOOL_CARD_ID } from '../card-commands';
import { resolveLookup, parseOrdinal, type ResolvedCell } from '../lookup';

export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

/** Procedures with their OWN modules — the runner refuses these. */
const OWN_MODULE_PROCEDURE_IDS = new Set(['challenge-round', 'camp-high-chant', 'camp-leeches', 'test-of-fate', 'group-test']);
/** `crawl-meatgrinder`'s steps are ALTERNATIVE entry modes (ordinary room /
 * moving carefully / loud noise / questing beast oil), not a sequence — a
 * sequential runner would execute them all. Its actual card operation (one
 * major draw against the meatgrinder table) is exactly `overland-travel`'s
 * shape, which IS supported; the mode choice is GM fiction. */
const UNSUPPORTED_PROCEDURE_IDS = new Set(['crawl-meatgrinder']);

/** Whether the runner owns `procedureId` — the projection's beginnable list
 * and the service both key off this single predicate. */
export function isRunnerProcedure(procedureId: string): boolean {
	return !OWN_MODULE_PROCEDURE_IDS.has(procedureId) && !UNSUPPORTED_PROCEDURE_IDS.has(procedureId);
}

export function finiteZoneId(procedureId: string): string {
	return `finite:${procedureId}`;
}
export function finitePendingZoneId(procedureId: string): string {
	return `finite-pending:${procedureId}`;
}

export interface FiniteActorFacts {
	tenureId: string;
	userId: string;
	rosterOrder: number;
}
export interface FiniteMaterials {
	actors: FiniteActorFacts[];
}

export interface FiniteReduceContext extends ReduceContext {
	procedures: TarotProcedureDefinition[];
	lookupTables: TarotLookupTable[];
	materials: FiniteMaterials;
}

const resolvedCellSchema = z
	.object({
		columnId: z.string(),
		text: z.string(),
		resolvedText: z.string(),
		activeBranches: z.array(z.string()),
		references: z.array(z.object({ collection: z.enum(['denizens', 'alchemy', 'rules']), entryId: z.string(), label: z.string() }).strict())
	})
	.strict();

const storedOutcomeSchema = z
	.object({ tableId: z.string(), matchedKeys: z.array(z.string()), cells: z.array(resolvedCellSchema) })
	.strict();

export interface StoredOutcome {
	tableId: string;
	/** The source-numeral(s) of the resolved draw(s) — what `lookup-key`
	 * conditions match against. */
	matchedKeys: string[];
	cells: ResolvedCell[];
}

const finiteStateSchema = z
	.object({
		schemaVersion: z.literal(1),
		procedureId: z.string(),
		stepIndex: z.number().int().nonnegative(),
		actorTenureId: z.string().nullable(),
		mode: z.enum(['appropriate-realm', 'random-realm']).nullable(),
		chosenTableId: z.string().nullable(),
		draws: z.record(z.string(), z.array(z.string())),
		outcomes: z.record(z.string(), storedOutcomeSchema),
		manual: z.record(z.string(), z.string()),
		eachPlayerDone: z.array(z.string()),
		completedSteps: z.array(z.string()),
		skippedSteps: z.array(z.string()),
		completed: z.boolean()
	})
	.strict();

export type FiniteProcedureStateV1 = z.infer<typeof finiteStateSchema>;

/** Typed as the rejection variant alone, so it satisfies both
 * `SessionReduceResult` and the narrower `StepOutcome`. */
function reject(code: SessionRejection['code'], message: string): { ok: false; rejection: SessionRejection } {
	return { ok: false, rejection: { code, message } };
}

export function readFiniteProcedure(state: SessionEngineStateV1): FiniteProcedureStateV1 | undefined {
	if (!state.procedure) return undefined;
	const parsed = finiteStateSchema.safeParse(state.procedure.gmPrivate);
	if (!parsed.success) return undefined;
	return parsed.data.procedureId === state.procedure.procedureId ? parsed.data : undefined;
}

function writeFinite(state: SessionEngineStateV1, runner: FiniteProcedureStateV1): SessionEngineStateV1 {
	return {
		...state,
		procedure: { procedureId: runner.procedureId, stepIndex: runner.stepIndex, pendingZoneIds: [], gmPrivate: finiteStateSchema.parse(runner) }
	};
}

// ---------------------------------------------------------------------------
// Card facts and classification
// ---------------------------------------------------------------------------

function toDrawnCard(cardId: CardId, catalog: Record<string, TarotCardCatalogEntry>): DrawnCard {
	const entry = catalog[cardId];
	return {
		id: cardId,
		kind: entry?.deck === 'major' ? 'major' : 'minor',
		label: entry?.label ?? cardId,
		value: entry?.value ?? 0,
		...(entry?.suit !== undefined ? { suit: entry.suit } : {})
	};
}

const ROMAN_NUMERALS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];
const MINOR_COURT: Record<number, string> = { 11: 'Page', 12: 'Knight', 13: 'Queen', 14: 'King' };

/** The source's own numeral for a card — what `lookup-key` conditions name. */
function sourceNumeral(card: DrawnCard): string {
	if (card.kind === 'minor' && MINOR_COURT[card.value]) return MINOR_COURT[card.value];
	return ROMAN_NUMERALS[card.value] ?? String(card.value);
}

/**
 * Steps that are ALTERNATIVES to `step` — Augury's `accept-card`/`decline-card`.
 *
 * "Same actor and adjacent" is not enough: Augury's `private-draw` then
 * `describe-parable` are also same-actor and adjacent, and they are a SEQUENCE.
 * What makes two steps alternatives is that both resolve the same already-pending
 * card, so both must carry a card-resolution operation.
 *
 * This is the ONLY set `stepId` may target. Authorizing a skipped step proves
 * the caller owns it, not that skipping it is legitimate — without this, a
 * player could target Doomsaying's `draw-prophecy` and skip their own `pay-fee`,
 * dodging the fee the procedure exists to charge (second-pass review finding).
 */
const CARD_RESOLUTION_OPERATIONS = new Set(['reveal', 'discard', 'play', 'place-facedown']);

export function forkStepIdsFor(procedure: TarotProcedureDefinition, step: TarotProcedureStepDefinition): string[] {
	if (!CARD_RESOLUTION_OPERATIONS.has(step.operation)) return [];
	const index = procedure.steps.findIndex((candidate) => candidate.id === step.id);
	if (index === -1) return [];
	const siblings: string[] = [];
	for (let n = index + 1; n < procedure.steps.length; n += 1) {
		const candidate = procedure.steps[n];
		if (
			candidate.actor !== step.actor ||
			(candidate.conditions?.length ?? 0) > 0 ||
			!CARD_RESOLUTION_OPERATIONS.has(candidate.operation)
		) {
			break;
		}
		siblings.push(candidate.id);
	}
	return siblings.length > 0 ? [step.id, ...siblings] : [];
}

/** The Meatgrinder's own category labels, extracted from the verbatim cell
 * text — `previous-result` conditions classify by them. A cell with no
 * bracket ("Torches gutter") is a non-encounter. */
function isRandomEncounterCell(cell: ResolvedCell): boolean {
	return cell.text.startsWith('[Random encounter]');
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function outcomeForTable(runner: FiniteProcedureStateV1, tableId: string): StoredOutcome | undefined {
	return Object.values(runner.outcomes).find((outcome) => outcome.tableId === tableId);
}

function outcomeForStep(runner: FiniteProcedureStateV1, stepId: string): StoredOutcome | undefined {
	return runner.outcomes[stepId];
}

/** Whether `step` applies given what the runner has recorded. `null` means
 * "requires the flat 50% manual gate" — applicable, but only a confirm
 * resolves it. Unevaluable conditions (fiction/sheet state) are GM-attested
 * true, per the module header. */
function stepApplies(step: TarotProcedureStepDefinition, runner: FiniteProcedureStateV1): boolean {
	for (const condition of step.conditions ?? []) {
		if (!conditionHolds(condition, runner)) return false;
	}
	return true;
}

function conditionHolds(condition: TarotStepCondition, runner: FiniteProcedureStateV1): boolean {
	switch (condition.kind) {
		case 'invocation-mode':
			return runner.mode === condition.mode;
		case 'lookup-key': {
			const outcome = outcomeForTable(runner, condition.tableId);
			// A cross-procedure trigger (Signs & Portents after a City Event XXI)
			// has no recorded outcome here — the GM's decision to run the step is
			// the attestation.
			if (!outcome) return true;
			return outcome.matchedKeys.some((key) => condition.keys.includes(key));
		}
		case 'previous-result': {
			if (condition.result !== 'random-encounter' && condition.result !== 'non-encounter') return true;
			const outcome = condition.fromStepId
				? outcomeForStep(runner, condition.fromStepId)
				: Object.values(runner.outcomes).at(-1);
			if (!outcome) return true;
			const encounters = outcome.cells.filter(isRandomEncounterCell).length;
			if (condition.match === 'all') {
				const required = condition.count ?? outcome.cells.length;
				return condition.result === 'random-encounter' ? encounters >= required : encounters === 0;
			}
			return condition.result === 'random-encounter' ? encounters > 0 : encounters < outcome.cells.length;
		}
		case 'percent-chance':
			// The flat 50% gate: applicable — resolution is a manual yes/no
			// confirmation, never a draw (global constraint).
			return true;
		default:
			// game-state / entry-state / card-suit / value-range: fiction or an
			// alternate-entry discriminator the runner cannot see — GM-attested.
			return true;
	}
}

/** A choose-one step is inapplicable when NO option satisfies its reject
 * rules — Patrol with two encounters has nothing legal to choose, and the
 * both-encounters confirmation takes over. */
function chooseOneHasLegalOption(step: TarotProcedureStepDefinition, runner: FiniteProcedureStateV1): boolean {
	if (step.choice?.kind !== 'choose-one') return true;
	const outcome = outcomeForStep(runner, step.choice.fromStepId);
	if (!outcome) return true;
	const rejectsEncounters = step.choice.rejectConditions?.some(
		(rule) => rule.kind === 'previous-result' && rule.result === 'random-encounter'
	);
	if (!rejectsEncounters) return true;
	return outcome.cells.some((cell) => !isRandomEncounterCell(cell));
}

// ---------------------------------------------------------------------------
// Begin
// ---------------------------------------------------------------------------

export interface BeginFiniteProcedureInput {
	procedureId: string;
	/** The acting adventurer, for procedures with player steps. */
	actorTenureId?: string;
	/** Maleficence's invocation mode (Appendix A: cast into the appropriate
	 * far realm, or a random one). */
	mode?: 'appropriate-realm' | 'random-realm';
	/** The GM's chosen realm table when `mode` is `appropriate-realm`. */
	realmTableId?: string;
}

export function beginFiniteProcedure(
	state: SessionEngineStateV1,
	input: BeginFiniteProcedureInput,
	context: FiniteReduceContext
): SessionReduceResult {
	const procedure = context.procedures.find((candidate) => candidate.id === input.procedureId);
	if (!procedure) return reject('content-mismatch', `no procedure ${input.procedureId} in the pinned content`);
	if (OWN_MODULE_PROCEDURE_IDS.has(procedure.id)) {
		return reject('illegal-command', `${procedure.id} runs through its own dedicated surface, not the generic runner`);
	}
	if (UNSUPPORTED_PROCEDURE_IDS.has(procedure.id)) {
		return reject('illegal-command', `${procedure.id}'s steps are alternative entry modes — draw it via overland-travel-shaped invocations`);
	}
	if (state.procedure !== null) return reject('illegal-command', 'another procedure is already active');

	const actorFacts = input.actorTenureId
		? context.materials.actors.find((candidate) => candidate.tenureId === input.actorTenureId)
		: undefined;
	if (input.actorTenureId && !actorFacts) {
		return reject('illegal-command', `no adventurer at this table holds tenure ${input.actorTenureId}`);
	}
	const isGm = context.actor.kind === 'gm';
	const isOwner = actorFacts !== undefined && context.actor.kind === 'player' && context.actor.userId === actorFacts.userId;
	if (!isGm && !isOwner) return reject('not-authorized', 'only the GM or the acting adventurer may begin this procedure');

	if (input.mode === 'appropriate-realm' && !input.realmTableId) {
		return reject('illegal-command', 'the appropriate-realm invocation names its realm table');
	}

	const runner: FiniteProcedureStateV1 = {
		schemaVersion: 1,
		procedureId: procedure.id,
		stepIndex: 0,
		actorTenureId: input.actorTenureId ?? null,
		mode: input.mode ?? null,
		chosenTableId: input.realmTableId ?? null,
		draws: {},
		outcomes: {},
		manual: {},
		eachPlayerDone: [],
		completedSteps: [],
		skippedSteps: [],
		completed: false
	};

	return {
		ok: true,
		state: writeFinite(state, runner),
		events: [
			{
				kind: 'finite-procedure-begun',
				publicPayload: {
					procedureId: procedure.id,
					title: procedure.title,
					...(input.actorTenureId ? { actorTenureId: input.actorTenureId } : {}),
					...(input.mode ? { mode: input.mode } : {})
				}
			}
		]
	};
}

// ---------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------

export interface AdvanceFiniteProcedureInput {
	/** Names a LATER step to run, skipping intermediates — the accept/decline
	 * fork. Must still pass that step's own actor gate. */
	stepId?: string;
	/** Resolution of a manual-choice step (and the flat 50% gate). */
	confirm?: 'yes' | 'no';
	/** A choose-one step's selection, from the source step's draws. */
	chosenCardId?: string;
	/** A reorder-top step's new order for the top N. */
	orderedCardIds?: string[];
}

export function advanceFiniteProcedure(
	state: SessionEngineStateV1,
	input: AdvanceFiniteProcedureInput,
	context: FiniteReduceContext
): SessionReduceResult {
	const runner = readFiniteProcedure(state);
	if (!runner) return reject('illegal-command', 'no runner procedure is in progress');
	const procedure = context.procedures.find((candidate) => candidate.id === runner.procedureId);
	/* v8 ignore next -- the pinned content that began the procedure still holds it */
	if (!procedure) return reject('content-mismatch', `pinned content lost procedure ${runner.procedureId}`);

	// Walk forward from the current index to the effective step: past
	// inapplicable steps, and past intermediates when `stepId` targets a later
	// fork branch.
	let working = runner;
	let index = runner.stepIndex;
	let step: TarotProcedureStepDefinition | null = null;
	while (index < procedure.steps.length) {
		const candidate = procedure.steps[index];
		const applies = stepApplies(candidate, working) && chooseOneHasLegalOption(candidate, working);
		if (!applies) {
			working = { ...working, skippedSteps: [...working.skippedSteps, candidate.id], stepIndex: index + 1 };
			index += 1;
			continue;
		}
		if (input.stepId && candidate.id !== input.stepId) {
			// `stepId` exists for a FORK only: the actor picks which branch of a
			// mutually-exclusive pair runs, and the other is skipped. Two guards,
			// both needed (second-pass review): the skipped step must be a genuine
			// alternative of the one being targeted, AND the caller must own it.
			// Ownership alone would let a player skip their own earlier step to
			// dodge its cost; alternative-ness alone would let one actor skip
			// another's step.
			const alternatives = forkStepIdsFor(procedure, candidate);
			if (!alternatives.includes(input.stepId)) {
				return reject('illegal-command', `${candidate.id} is not an alternative branch and cannot be skipped`);
			}
			const skipAuth = authorizeStep(candidate, working, context);
			if (skipAuth) {
				return reject('not-authorized', `${candidate.id} belongs to another actor and cannot be skipped`);
			}
			working = { ...working, skippedSteps: [...working.skippedSteps, candidate.id], stepIndex: index + 1 };
			index += 1;
			continue;
		}
		step = candidate;
		break;
	}
	if (!step) return reject('illegal-command', 'every step has run — complete the procedure');

	const auth = authorizeStep(step, working, context);
	if (auth) return auth;

	const executed = executeStep(state, step, working, input, context);
	if (!executed.ok) return executed;

	// Advance past the executed step (each-player steps stay current until
	// every adventurer has acted), then auto-run system/automatic steps.
	let nextRunner = executed.runner;
	let nextState = executed.state;
	const events = [...executed.events];
	if (!(step.actor === 'each-player' && nextRunner.eachPlayerDone.length < context.materials.actors.length)) {
		nextRunner = {
			...nextRunner,
			completedSteps: [...nextRunner.completedSteps, step.id],
			stepIndex: index + 1,
			eachPlayerDone: step.actor === 'each-player' ? [] : nextRunner.eachPlayerDone
		};
		let autoIndex = index + 1;
		while (autoIndex < procedure.steps.length) {
			const candidate = procedure.steps[autoIndex];
			if (!(stepApplies(candidate, nextRunner) && chooseOneHasLegalOption(candidate, nextRunner))) {
				nextRunner = { ...nextRunner, skippedSteps: [...nextRunner.skippedSteps, candidate.id], stepIndex: autoIndex + 1 };
				autoIndex += 1;
				continue;
			}
			if (candidate.actor !== 'system' || candidate.completion !== 'automatic') break;
			nextRunner = {
				...nextRunner,
				manual: { ...nextRunner.manual, [candidate.id]: 'yes' },
				completedSteps: [...nextRunner.completedSteps, candidate.id],
				stepIndex: autoIndex + 1
			};
			events.push({ kind: 'finite-step-resolved', publicPayload: { procedureId: procedure.id, stepId: candidate.id, automatic: true } });
			autoIndex += 1;
		}
		if (nextRunner.stepIndex >= procedure.steps.length) nextRunner = { ...nextRunner, completed: true };
	}

	return { ok: true, state: writeFinite(nextState, nextRunner), events };
}

function authorizeStep(
	step: TarotProcedureStepDefinition,
	runner: FiniteProcedureStateV1,
	context: FiniteReduceContext
): SessionReduceResult | null {
	if (step.actor === 'gm' || step.actor === 'system') {
		return context.actor.kind === 'gm' ? null : { ok: false, rejection: { code: 'not-authorized', message: 'this step is the GM’s' } };
	}
	if (step.actor === 'player') {
		const facts = runner.actorTenureId
			? context.materials.actors.find((candidate) => candidate.tenureId === runner.actorTenureId)
			: undefined;
		const owns = facts !== undefined && context.actor.kind === 'player' && context.actor.userId === facts.userId;
		return owns ? null : { ok: false, rejection: { code: 'not-authorized', message: 'this step belongs to the acting adventurer' } };
	}
	// each-player
	const mine = context.actor.kind === 'player' ? context.materials.actors.find((candidate) => candidate.userId === context.actor.userId) : undefined;
	if (!mine) return { ok: false, rejection: { code: 'not-authorized', message: 'this step belongs to the attached adventurers' } };
	if (runner.eachPlayerDone.includes(mine.tenureId)) {
		return { ok: false, rejection: { code: 'illegal-command', message: 'you have already taken this step' } };
	}
	return null;
}

interface ExecutedStep {
	ok: true;
	state: SessionEngineStateV1;
	runner: FiniteProcedureStateV1;
	events: SessionEvent[];
}

/** The execute* functions never return a bare ok-without-runner, so their
 * union narrows cleanly at the call site. */
type StepOutcome = ExecutedStep | { ok: false; rejection: SessionRejection };

function executeStep(
	state: SessionEngineStateV1,
	step: TarotProcedureStepDefinition,
	runner: FiniteProcedureStateV1,
	input: AdvanceFiniteProcedureInput,
	context: FiniteReduceContext
): StepOutcome {
	switch (step.operation) {
		case 'draw':
			return executeDraw(state, step, runner, context);
		case 'consult-discard-top':
			return executeConsult(state, step, runner, context);
		case 'manual-choice':
			return executeManual(state, step, runner, input, context);
		case 'reorder-top':
			return executeReorder(state, step, runner, input, context);
		case 'reveal':
			return executeRevealOrDiscard(state, step, runner, context, 'play');
		case 'discard':
			return executeRevealOrDiscard(state, step, runner, context, 'discard');
		default:
			return reject('illegal-command', `the runner does not support the ${step.operation} operation`);
	}
}

function stepTables(step: TarotProcedureStepDefinition, runner: FiniteProcedureStateV1, context: FiniteReduceContext): { tableId: string | null; runner: FiniteProcedureStateV1 } {
	if (step.lookupTableId) return { tableId: step.lookupTableId, runner };
	if (step.lookupTableIds) {
		if (runner.chosenTableId) return { tableId: runner.chosenTableId, runner };
		// The random-realm invocation: the realm comes from the rng, recorded so
		// a retry resolves the same table.
		const pick = step.lookupTableIds[Math.floor(context.rng() * step.lookupTableIds.length) % step.lookupTableIds.length];
		return { tableId: pick, runner: { ...runner, chosenTableId: pick } };
	}
	return { tableId: null, runner };
}

function tableStateFor(state: SessionEngineStateV1, context: FiniteReduceContext) {
	const top = state.playerDiscard[0];
	return {
		minorDiscardTop: top === undefined ? null : toDrawnCard(top, context.runtime.catalog),
		adventurerCount: context.materials.actors.length
	};
}

function recordOutcome(
	runner: FiniteProcedureStateV1,
	key: string,
	tableId: string,
	matchedKeys: string[],
	cells: ResolvedCell[]
): FiniteProcedureStateV1 {
	return { ...runner, outcomes: { ...runner.outcomes, [key]: { tableId, matchedKeys, cells } } };
}

function outcomeEvent(procedureId: string, stepId: string, outcome: StoredOutcome, resultVisibility: string, gmUserId: string): SessionEvent {
	const payload = { procedureId, stepId, outcome };
	return resultVisibility === 'public'
		? { kind: 'finite-step-resolved', publicPayload: payload }
		: { kind: 'finite-step-resolved', publicPayload: { procedureId, stepId }, privatePayloads: { [gmUserId]: payload } };
}

function executeDraw(
	state: SessionEngineStateV1,
	step: TarotProcedureStepDefinition,
	runner: FiniteProcedureStateV1,
	context: FiniteReduceContext
): StepOutcome {
	if (step.draw?.kind !== 'fixed') return reject('illegal-command', `the runner draws fixed counts only (${step.id})`);
	const count = step.draw.count;
	const deck = step.deck === 'major' ? 'major' : 'player';

	const isPublic = step.visibility === 'public';
	const zoneId = isPublic ? finiteZoneId(runner.procedureId) : finitePendingZoneId(runner.procedureId);
	let working: SessionEngineStateV1 = state;
	if (isPublic && !working.publicZones.some((zone) => zone.id === zoneId)) {
		working = { ...working, publicZones: [...working.publicZones, { id: zoneId, kind: 'revealed', cards: [] }] };
	}
	if (!isPublic && !working.pendingZones.some((zone) => zone.id === zoneId)) {
		working = { ...working, pendingZones: [...working.pendingZones, { id: zoneId, deck, cards: [] }] };
	}

	const events: SessionEvent[] = [];
	const drawnCards: CardId[] = [];
	const { tableId, runner: withTable } = stepTables(step, runner, context);
	let nextRunner = withTable;
	// A lookup draw needs `count` cards WITH table entries; the Fool has none
	// and triggers one replacement per appearance (see the module header).
	let attempts = 0;
	while (drawnCards.length < count && attempts < count + 3) {
		attempts += 1;
		const before = findZoneDescriptor(working, zoneId)?.cards.length ?? 0;
		const drawn = reduceSession(working, { type: 'draw', deck, destinationZoneId: zoneId, count: 1 }, context);
		if (!drawn.ok) return drawn;
		working = drawn.state;
		events.push(...drawn.events);
		const cards = findZoneDescriptor(working, zoneId)!.cards;
		const newCard = cards[before]; // draws append
		if (tableId && newCard === FOOL_CARD_ID) continue;
		drawnCards.push(newCard);
	}
	if (drawnCards.length < count) return reject('illegal-command', `could not draw ${count} resolvable card(s) for ${step.id}`);

	const isEachPlayer = step.actor === 'each-player';
	const actorTenure =
		isEachPlayer && context.actor.kind === 'player'
			? context.materials.actors.find((candidate) => candidate.userId === context.actor.userId)!.tenureId
			: null;
	const recordKey = actorTenure ? `${step.id}:${actorTenure}` : step.id;
	nextRunner = { ...nextRunner, draws: { ...nextRunner.draws, [recordKey]: drawnCards } };
	if (actorTenure) nextRunner = { ...nextRunner, eachPlayerDone: [...nextRunner.eachPlayerDone, actorTenure] };

	if (tableId) {
		const table = context.lookupTables.find((candidate) => candidate.id === tableId);
		if (!table) return reject('content-mismatch', `pinned content has no lookup table ${tableId}`);
		const draws = drawnCards.map((cardId) => toDrawnCard(cardId, context.runtime.catalog));
		const tableState = tableStateFor(working, context);
		let cells: ResolvedCell[] = [];
		if (table.axis === 'suit-by-step') {
			const resolved = resolveLookup(table, draws, tableState);
			if (!resolved.ok) return resolved;
			cells = resolved.cells;
		} else {
			for (const draw of draws) {
				const resolved = resolveLookup(table, [draw], tableState);
				if (!resolved.ok) return resolved;
				cells.push(...resolved.cells);
			}
		}
		const matchedKeys = draws.map(sourceNumeral);
		nextRunner = recordOutcome(nextRunner, recordKey, tableId, matchedKeys, cells);
		events.push(outcomeEvent(runner.procedureId, step.id, { tableId, matchedKeys, cells }, step.resultVisibility, context.actor.userId));
	}

	return { ok: true, state: working, runner: nextRunner, events };
}

function executeConsult(
	state: SessionEngineStateV1,
	step: TarotProcedureStepDefinition,
	runner: FiniteProcedureStateV1,
	context: FiniteReduceContext
): StepOutcome {
	const pile = step.deck === 'major' ? state.majorDiscard : state.playerDiscard;
	const top = pile[0];
	if (top === undefined) {
		return reject('illegal-command', `the ${step.deck ?? 'minor'} discard pile is empty — there is no top card to consult`);
	}
	const { tableId, runner: withTable } = stepTables(step, runner, context);
	if (!tableId) {
		// A consult with NO table (camp-watch's select-watch): the top card
		// ITSELF is the answer — Ch8 reads it to see whose watch the encounter
		// falls on. Record and publish it; nothing moves.
		const draw = toDrawnCard(top, context.runtime.catalog);
		const nextRunner: FiniteProcedureStateV1 = { ...runner, draws: { ...runner.draws, [step.id]: [top] } };
		return {
			ok: true,
			state,
			runner: nextRunner,
			events: [
				{
					kind: 'finite-step-resolved',
					publicPayload: { procedureId: runner.procedureId, stepId: step.id, consultedCardId: top, consultedLabel: draw.label }
				}
			]
		};
	}
	const table = context.lookupTables.find((candidate) => candidate.id === tableId);
	if (!table) return reject('content-mismatch', `pinned content has no lookup table ${tableId}`);

	const draw = toDrawnCard(top, context.runtime.catalog);
	const resolved = resolveLookup(table, [draw], tableStateFor(state, context));
	if (!resolved.ok) return resolved;

	const nextRunner = recordOutcome(
		{ ...withTable, draws: { ...withTable.draws, [step.id]: [top] } },
		step.id,
		tableId,
		[sourceNumeral(draw)],
		resolved.cells
	);
	return {
		ok: true,
		state,
		runner: nextRunner,
		events: [outcomeEvent(runner.procedureId, step.id, nextRunner.outcomes[step.id], step.resultVisibility, context.actor.userId)]
	};
}

function executeManual(
	state: SessionEngineStateV1,
	step: TarotProcedureStepDefinition,
	runner: FiniteProcedureStateV1,
	input: AdvanceFiniteProcedureInput,
	context: FiniteReduceContext
): StepOutcome {
	// A choose-one manual step records a card selection, validated against the
	// source step's draws and the choice's own reject rules.
	if (step.choice?.kind === 'choose-one') {
		const chosen = input.chosenCardId;
		if (!chosen) return reject('illegal-command', `${step.id} chooses one of the drawn options — name a card`);
		const options = runner.draws[step.choice.fromStepId] ?? [];
		const optionIndex = options.indexOf(chosen);
		if (optionIndex === -1) return reject('illegal-command', 'that card was not among the drawn options');
		const rejectsEncounters = step.choice.rejectConditions?.some(
			(rule) => rule.kind === 'previous-result' && rule.result === 'random-encounter'
		);
		const cell = outcomeForStep(runner, step.choice.fromStepId)?.cells[optionIndex];
		if (rejectsEncounters && cell && isRandomEncounterCell(cell)) {
			return reject('illegal-command', 'a random encounter cannot be chosen here — take the other option');
		}
		const nextRunner: FiniteProcedureStateV1 = { ...runner, manual: { ...runner.manual, [step.id]: chosen } };
		return {
			ok: true,
			state,
			runner: nextRunner,
			events: [{ kind: 'finite-step-resolved', publicPayload: { procedureId: runner.procedureId, stepId: step.id, chosenCardId: chosen } }]
		};
	}

	if (input.confirm !== 'yes' && input.confirm !== 'no') {
		return reject('illegal-command', `${step.id} is a manual confirmation — answer yes or no`);
	}

	// A resource effect with a card-value amount (Area Sense's visions) is
	// computed from the recorded draw and REPORTED — never applied to a sheet.
	const resourceEffect = step.effects?.find((effect) => effect.kind === 'resource');
	let effectPayload: Record<string, unknown> = {};
	if (resourceEffect && resourceEffect.kind === 'resource') {
		const lastDraw = Object.values(runner.draws).at(-1)?.at(-1);
		const amount =
			typeof resourceEffect.amount === 'object' && 'kind' in resourceEffect.amount && resourceEffect.amount.kind === 'card-value'
				? (lastDraw !== undefined ? (context.runtime.catalog[lastDraw]?.value ?? 0) : 0)
				: resourceEffect.amount;
		effectPayload = { effect: { resource: resourceEffect.resource, amount }, manualConsequence: true };
	}
	const costs = step.costs?.length ? { costs: step.costs, manualConsequence: true } : {};

	const nextRunner: FiniteProcedureStateV1 = { ...runner, manual: { ...runner.manual, [step.id]: input.confirm } };
	return {
		ok: true,
		state,
		runner: nextRunner,
		events: [
			{
				kind: 'finite-step-resolved',
				publicPayload: { procedureId: runner.procedureId, stepId: step.id, confirm: input.confirm, ...effectPayload, ...costs }
			}
		]
	};
}

function executeReorder(
	state: SessionEngineStateV1,
	step: TarotProcedureStepDefinition,
	runner: FiniteProcedureStateV1,
	input: AdvanceFiniteProcedureInput,
	context: FiniteReduceContext
): StepOutcome {
	const count = step.draw?.kind === 'fixed' ? step.draw.count : 0;
	if (!input.orderedCardIds || input.orderedCardIds.length !== count) {
		return reject('illegal-command', `${step.id} reorders exactly the top ${count} card(s)`);
	}
	// The draw pile is a hidden zone the generic rule reserves for the GM; the
	// runner has independently authorized THIS actor for THIS step, so the call
	// is elevated while keeping the actor's own userId — the reorder's private
	// payload (the new order) then reaches exactly the acting player.
	const elevated = { ...context, actor: { kind: 'gm' as const, userId: context.actor.userId } };
	const zone = step.deck === 'major' ? 'majorDraw' : 'playerDraw';
	const reordered = reduceSession(state, { type: 'reorder-top', zoneId: zone, cardIds: input.orderedCardIds }, elevated);
	if (!reordered.ok) return reordered;
	return {
		ok: true,
		state: reordered.state,
		runner,
		events: reordered.events
	};
}

/** Augury's fork: `reveal` plays the privately-drawn card into the public
 * zone (disclosing it), `discard` routes it straight to the minor discard —
 * where its face is public anyway, exactly as the analog table would see it. */
function executeRevealOrDiscard(
	state: SessionEngineStateV1,
	step: TarotProcedureStepDefinition,
	runner: FiniteProcedureStateV1,
	context: FiniteReduceContext,
	move: 'play' | 'discard'
): StepOutcome {
	const pendingId = finitePendingZoneId(runner.procedureId);
	const pending = findZoneDescriptor(state, pendingId);
	const cardId = pending?.cards[0];
	if (cardId === undefined) return reject('illegal-command', `${step.id} has no pending card to resolve`);

	let working = state;
	if (move === 'play') {
		const publicId = finiteZoneId(runner.procedureId);
		if (!working.publicZones.some((zone) => zone.id === publicId)) {
			working = { ...working, publicZones: [...working.publicZones, { id: publicId, kind: 'revealed', cards: [] }] };
		}
		const moved = reduceSession(working, { type: 'play', sourceZoneId: pendingId, cardId, destinationZoneId: publicId }, context);
		if (!moved.ok) return moved;
		return { ok: true, state: moved.state, runner, events: moved.events };
	}
	const discarded = reduceSession(
		working,
		{ type: 'discard', sourceZoneId: pendingId, cardId, destinationZoneId: step.deck === 'major' ? 'majorDiscard' : 'playerDiscard' },
		context
	);
	if (!discarded.ok) return discarded;
	return { ok: true, state: discarded.state, runner, events: discarded.events };
}

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

export function completeFiniteProcedure(state: SessionEngineStateV1, context: FiniteReduceContext): SessionReduceResult {
	const runner = readFiniteProcedure(state);
	if (!runner) return reject('illegal-command', 'no runner procedure is in progress');

	const facts = runner.actorTenureId
		? context.materials.actors.find((candidate) => candidate.tenureId === runner.actorTenureId)
		: undefined;
	const isOwner = facts !== undefined && context.actor.kind === 'player' && context.actor.userId === facts.userId;
	if (!isOwner && context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM or the acting adventurer may finish this procedure');
	}

	let working = state;
	const events: SessionEvent[] = [];
	// Every card still in the procedure's zones goes to its deck's discard —
	// through the ordinary command, GM-elevated (the entitlement was checked
	// above), so conservation and events behave like any other discard.
	const elevated = { ...context, actor: { kind: 'gm' as const, userId: context.actor.userId } };
	for (const zoneId of [finiteZoneId(runner.procedureId), finitePendingZoneId(runner.procedureId)]) {
		for (const cardId of findZoneDescriptor(working, zoneId)?.cards.slice() ?? []) {
			const deck = context.runtime.catalog[cardId]?.deck === 'major' ? 'majorDiscard' : 'playerDiscard';
			const moved = reduceSession(working, { type: 'discard', sourceZoneId: zoneId, cardId, destinationZoneId: deck }, elevated);
			/* v8 ignore next -- a GM discarding a present card cannot be refused */
			if (!moved.ok) return moved;
			working = moved.state;
			events.push(...moved.events);
		}
	}
	working = {
		...working,
		publicZones: working.publicZones.filter((zone) => zone.id !== finiteZoneId(runner.procedureId)),
		pendingZones: working.pendingZones.filter((zone) => zone.id !== finitePendingZoneId(runner.procedureId)),
		procedure: null
	};

	return {
		ok: true,
		state: working,
		events: [...events, { kind: 'finite-procedure-completed', publicPayload: { procedureId: runner.procedureId } }]
	};
}
