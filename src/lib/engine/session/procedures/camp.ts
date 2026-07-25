/**
 * The Camp tarot procedures (Increment 4 Task 3) — the two Camp Actions whose
 * mechanics are genuinely card operations:
 *
 * **High Chant** (Ch5 `paths-high-chant`): "you may select a number of cards
 * from the minor arcana discard pile equal to your Cups. These are called
 * inspiration cards. Distribute the cards to other players—you may keep one for
 * yourself. No player can ever have more than one inspiration card. … Inspiration
 * cards last until used or until the end of the session."
 *
 * **Leeches** (Ch9 `city-leeches`, reached in Camp via "Use an Item"): "You can
 * apply leeches to another adventurer … draw a card. If you draw a Swords or
 * Pentacles card, nothing happens. If you draw a Cups or Wands card, the leeched
 * adventurer counts as having burned 2 charges to cure an affliction."
 *
 * ## What is content and what is code
 *
 * Every number and suit set here comes from the content pack via
 * `buildCampConfig`: the per-Cups multiplier from the `high-chant-selection`
 * formula, the one-per-player cap from the `camp-high-chant` modifier's
 * `maxHeldPerPlayer`, and both leech suit sets plus the charge count from the
 * `camp-leeches` steps' own conditions and effects. Nothing is restated as a
 * TypeScript literal.
 *
 * ## What this deliberately does NOT do
 *
 * It never touches a character sheet. A cured affliction is reported as a public
 * outcome flagged `manualConsequence` — afflictions, charges, and every other
 * sheet field stay the table's to adjudicate (spec §8.6, and the plan's "No Camp
 * resource outside the modeled card procedure is auto-mutated"). The app supplies
 * the rule's answer; the players apply it.
 *
 * ## Where inspiration cards live, and why they are private
 *
 * Each holder gets their OWN private zone (`inspirationZoneId`). Two reasons,
 * and the first is decisive: the session's single shared public `inspiration`
 * zone has no owner, so it cannot express "no player can ever have more than one
 * inspiration card" at all. Second, the pack's `distribute-inspiration` step is
 * `visibility: 'recipient-private'`, and the plan requires that a player-to-player
 * transferred face not reach bystanders or the GM. The zone's `kind` is
 * `'player-prepared'`, which gives every viewer a card-BACK projection — so the
 * table can verify the one-per-player cap by counting, without seeing a face.
 * (Reusing an existing zone kind for a distinct game concept, addressed by a
 * distinct zone id, is the same pattern Challenge uses for its three different
 * `player-facedown` zones.)
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import { z } from 'zod';
import { SUIT_IDS, type SuitId } from '$lib/types/common';
import type {
	InspirationDistributionParams,
	SessionModifierDefinition,
	TarotFormulaDefinition,
	TarotProcedureDefinition
} from '$lib/types/content-pack';
import type { CardId, SessionEngineStateV1, SessionEvent, SessionRejection } from '$lib/types/session';
import { reduceSession, type ReduceContext } from '../reducer';
import type { ReduceResult } from '../result';
import { findZoneDescriptor } from '../state';
import { performPrivateTransfer } from '../private-transfer';

export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

export const CAMP_HIGH_CHANT_PROCEDURE_ID = 'camp-high-chant';
export const CAMP_LEECHES_PROCEDURE_ID = 'camp-leeches';
/** The content pack's `camp-high-chant` modifier (`inspiration-distribution`
 * behaviorId) — the source of the one-per-player cap. */
export const CAMP_HIGH_CHANT_MODIFIER_ID = 'camp-high-chant';
/** The `high-chant-selection` formula — the source of the per-Cups multiplier. */
export const HIGH_CHANT_SELECTION_FORMULA_ID = 'high-chant-selection';

/** A performer's own staging zone: cards pulled from the minor discard and not
 * yet handed out. Private to the performer (they chose them) with a public card
 * back, and emptied at completion — anything left goes back to the discard. */
export function highChantSelectionZoneId(tenureId: string): string {
	return `high-chant-selection:${tenureId}`;
}

/** One holder's inspiration card. Keyed by TENURE, so a dead adventurer's
 * leftover inspiration stays addressable separately from a replacement's — the
 * same reasoning as `challengeHandZoneId`. */
export function inspirationZoneId(tenureId: string): string {
	return `inspiration:${tenureId}`;
}

// ---------------------------------------------------------------------------
// Content-hydrated configuration
// ---------------------------------------------------------------------------

export interface CampConfig {
	schemaVersion: 1;
	/** `high-chant-selection.params.perCups` — cards selectable per point of
	 * Cups. */
	inspirationPerCups: number;
	/** `camp-high-chant.params.maxHeldPerPlayer` — Ch5's "No player can ever
	 * have more than one inspiration card." */
	maxInspirationPerPlayer: number;
	/** The `camp-leeches` `no-effect` step's `card-suit` condition. */
	leechesNoEffectSuits: SuitId[];
	/** The `cure-affliction` step's `card-suit` condition. */
	leechesCureSuits: SuitId[];
	/** That step's `affliction-cure.charges`. */
	leechesCureCharges: number;
}

function findStep(procedure: TarotProcedureDefinition, stepId: string) {
	const step = procedure.steps.find((candidate) => candidate.id === stepId);
	if (!step) throw new Error(`buildCampConfig: ${procedure.id} is missing its ${stepId} step`);
	return step;
}

function suitsFromCondition(procedure: TarotProcedureDefinition, stepId: string): SuitId[] {
	const condition = findStep(procedure, stepId).conditions?.find((candidate) => candidate.kind === 'card-suit');
	if (!condition || condition.kind !== 'card-suit') {
		throw new Error(`buildCampConfig: ${procedure.id}'s ${stepId} step has no card-suit condition`);
	}
	return [...condition.suits];
}

/**
 * Hydrates `CampConfig` from the pinned content. Throws on missing content — a
 * pack that cannot describe these procedures is a content bug, not a rejectable
 * user error, and the same discipline `buildChallengeConfig` follows.
 */
export function buildCampConfig(
	procedures: readonly TarotProcedureDefinition[],
	formulas: readonly TarotFormulaDefinition[],
	modifiers: readonly SessionModifierDefinition[]
): CampConfig {
	const leeches = procedures.find((procedure) => procedure.id === CAMP_LEECHES_PROCEDURE_ID);
	if (!leeches) throw new Error(`buildCampConfig: content is missing the ${CAMP_LEECHES_PROCEDURE_ID} procedure`);

	const formula = formulas.find((candidate) => candidate.id === HIGH_CHANT_SELECTION_FORMULA_ID);
	if (!formula) throw new Error(`buildCampConfig: content is missing the ${HIGH_CHANT_SELECTION_FORMULA_ID} formula`);
	const perCups = z.object({ perCups: z.number().int().positive() }).parse(formula.params).perCups;

	const modifier = modifiers.find((candidate) => candidate.id === CAMP_HIGH_CHANT_MODIFIER_ID);
	if (!modifier || modifier.behaviorId !== 'inspiration-distribution') {
		throw new Error(`buildCampConfig: content is missing the ${CAMP_HIGH_CHANT_MODIFIER_ID} inspiration-distribution modifier`);
	}
	const maxHeld = (modifier.params as InspirationDistributionParams).maxHeldPerPlayer;

	const cureEffect = findStep(leeches, 'cure-affliction').effects?.find((effect) => effect.kind === 'affliction-cure');
	if (!cureEffect || cureEffect.kind !== 'affliction-cure') {
		throw new Error(`buildCampConfig: ${CAMP_LEECHES_PROCEDURE_ID}'s cure-affliction step has no affliction-cure effect`);
	}

	return {
		schemaVersion: 1,
		inspirationPerCups: perCups,
		maxInspirationPerPlayer: maxHeld,
		leechesNoEffectSuits: suitsFromCondition(leeches, 'no-effect'),
		leechesCureSuits: suitsFromCondition(leeches, 'cure-affliction'),
		leechesCureCharges: cureEffect.charges
	};
}

// ---------------------------------------------------------------------------
// Server-read facts
// ---------------------------------------------------------------------------

/** One eligible adventurer's server-read facts. All four attributes travel
 * together for the same reason `GuidedTestActorFacts` carries them all: the
 * relevant one depends on the procedure (High Chant reads Cups). */
export interface CampActorFacts {
	tenureId: string;
	characterId: string;
	userId: string;
	attributes: Record<SuitId, number>;
	rosterOrder: number;
}

export interface CampMaterials {
	actors: CampActorFacts[];
}

export interface CampReduceContext extends ReduceContext {
	config: CampConfig;
	materials: CampMaterials;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type HighChantStage = 'select' | 'distribute' | 'complete';

export interface HighChantStateV1 {
	schemaVersion: 1;
	kind: 'high-chant';
	stage: HighChantStage;
	performerTenureId: string;
	/** Cups × `inspirationPerCups`, fixed when the procedure began so a
	 * mid-procedure sheet edit cannot change how many cards are already held. */
	allowance: number;
	selectedCardIds: CardId[];
	assignments: Array<{ cardId: CardId; recipientTenureId: string }>;
}

export type LeechesStage = 'draw' | 'complete';

export interface LeechesOutcome {
	effect: 'no-effect' | 'cure-affliction';
	/** Charges the target counts as having burned, or `null` for no effect. */
	charges: number | null;
	targetTenureId: string;
}

export interface LeechesStateV1 {
	schemaVersion: 1;
	kind: 'leeches';
	stage: LeechesStage;
	actorTenureId: string;
	targetTenureId: string;
	drawnCardId: CardId | null;
	drawnCardZoneId: string | null;
	outcome: LeechesOutcome | null;
}

export type CampProcedureStateV1 = HighChantStateV1 | LeechesStateV1;

const tenureIdSchema = z.string().trim().min(1).max(128);
const cardIdSchema = z.string().trim().min(1).max(128);

const highChantStateSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal('high-chant'),
		stage: z.enum(['select', 'distribute', 'complete']),
		performerTenureId: tenureIdSchema,
		allowance: z.number().int().nonnegative(),
		selectedCardIds: z.array(cardIdSchema),
		assignments: z.array(z.object({ cardId: cardIdSchema, recipientTenureId: tenureIdSchema }).strict())
	})
	.strict();

const leechesStateSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal('leeches'),
		stage: z.enum(['draw', 'complete']),
		actorTenureId: tenureIdSchema,
		targetTenureId: tenureIdSchema,
		drawnCardId: cardIdSchema.nullable(),
		drawnCardZoneId: z.string().nullable(),
		outcome: z
			.object({
				effect: z.enum(['no-effect', 'cure-affliction']),
				charges: z.number().int().nonnegative().nullable(),
				targetTenureId: tenureIdSchema
			})
			.strict()
			.nullable()
	})
	.strict();

const campProcedureStateSchema = z.discriminatedUnion('kind', [highChantStateSchema, leechesStateSchema]);

const CAMP_PROCEDURE_IDS: Record<CampProcedureStateV1['kind'], string> = {
	'high-chant': CAMP_HIGH_CHANT_PROCEDURE_ID,
	leeches: CAMP_LEECHES_PROCEDURE_ID
};

function reject(code: SessionRejection['code'], message: string): SessionReduceResult {
	return { ok: false, rejection: { code, message } };
}

/** Reads and validates the active Camp procedure from
 * `state.procedure.gmPrivate`. `undefined` when no Camp procedure is running (or
 * its blob does not parse) — never throws, so callers can turn it into a proper
 * rejection. Mirrors `readChallengeState`. */
export function readCampProcedure(state: SessionEngineStateV1): CampProcedureStateV1 | undefined {
	if (!state.procedure) return undefined;
	const isCamp = Object.values(CAMP_PROCEDURE_IDS).includes(state.procedure.procedureId);
	if (!isCamp) return undefined;
	const parsed = campProcedureStateSchema.safeParse(state.procedure.gmPrivate);
	return parsed.success ? (parsed.data as CampProcedureStateV1) : undefined;
}

/** True only when a Camp procedure is active but its state does not parse —
 * distinguishing corrupt from absent, so a corrupt blob surfaces its own
 * rejection instead of presenting as "no Camp procedure". */
export function isCampProcedureCorrupt(state: SessionEngineStateV1): boolean {
	if (!state.procedure) return false;
	if (!Object.values(CAMP_PROCEDURE_IDS).includes(state.procedure.procedureId)) return false;
	return !campProcedureStateSchema.safeParse(state.procedure.gmPrivate).success;
}

function writeCampProcedure(state: SessionEngineStateV1, camp: CampProcedureStateV1): SessionEngineStateV1 {
	const validated = campProcedureStateSchema.parse(camp);
	return {
		...state,
		procedure: {
			procedureId: CAMP_PROCEDURE_IDS[camp.kind],
			stepIndex: state.procedure?.procedureId === CAMP_PROCEDURE_IDS[camp.kind] ? (state.procedure.stepIndex ?? 0) : 0,
			pendingZoneIds: state.procedure?.pendingZoneIds ?? [],
			gmPrivate: validated
		}
	};
}

function clearCampProcedure(state: SessionEngineStateV1): SessionEngineStateV1 {
	return { ...state, procedure: null };
}

function actorFacts(context: CampReduceContext, tenureId: string): CampActorFacts | undefined {
	return context.materials.actors.find((actor) => actor.tenureId === tenureId);
}

/** The tenure the acting player is currently playing, resolved through
 * `materials` — a tenure id is never compared against a user id directly. */
function actingTenure(context: CampReduceContext): CampActorFacts | undefined {
	if (context.actor.kind !== 'player') return undefined;
	return context.materials.actors.find((actor) => actor.userId === context.actor.userId);
}

/** Adds a private zone for `ownerUserId` if it does not exist yet. `kind` is
 * `'player-prepared'` so the zone gets a public card-BACK projection — see the
 * file header on why inspiration is private-with-a-visible-count. */
function ensurePrivateZone(state: SessionEngineStateV1, zoneId: string, ownerUserId: string): SessionEngineStateV1 {
	if (state.privateZones.some((zone) => zone.id === zoneId)) return state;
	return {
		...state,
		privateZones: [...state.privateZones, { id: zoneId, kind: 'player-prepared', ownerUserId, cards: [] }]
	};
}

function withoutPrivateZone(state: SessionEngineStateV1, zoneId: string): SessionEngineStateV1 {
	return { ...state, privateZones: state.privateZones.filter((zone) => zone.id !== zoneId) };
}

function withoutPublicZone(state: SessionEngineStateV1, zoneId: string): SessionEngineStateV1 {
	return { ...state, publicZones: state.publicZones.filter((zone) => zone.id !== zoneId) };
}

// ---------------------------------------------------------------------------
// High Chant
// ---------------------------------------------------------------------------

/**
 * A player with the High Chant talent performs it. The allowance is their Cups
 * times the pack's per-Cups multiplier, read from the sheet server-side.
 *
 * Whether the performer actually HAS the talent is sheet state this engine does
 * not adjudicate (the same boundary every other talent-gated action observes) —
 * the GM adjudicates that at the table, exactly as they do for who may Use an
 * Item.
 */
export function beginHighChant(state: SessionEngineStateV1, context: CampReduceContext): SessionReduceResult {
	if (isCampProcedureCorrupt(state)) {
		return reject('illegal-command', 'the active Camp procedure is corrupt and cannot be read — contact the GM');
	}
	if (state.procedure !== null) return reject('illegal-command', 'another procedure is already active');

	const performer = actingTenure(context);
	if (!performer) return reject('illegal-command', 'only an adventurer at this table may perform the High Chant');

	const allowance = performer.attributes.cups * context.config.inspirationPerCups;
	const camp: HighChantStateV1 = {
		schemaVersion: 1,
		kind: 'high-chant',
		stage: 'select',
		performerTenureId: performer.tenureId,
		allowance,
		selectedCardIds: [],
		assignments: []
	};

	return {
		ok: true,
		state: writeCampProcedure(state, camp),
		events: [
			{
				kind: 'camp-high-chant-begun',
				publicPayload: { procedureId: CAMP_HIGH_CHANT_PROCEDURE_ID, performerTenureId: performer.tenureId, allowance }
			}
		]
	};
}

function readHighChant(state: SessionEngineStateV1): HighChantStateV1 | undefined {
	const camp = readCampProcedure(state);
	return camp?.kind === 'high-chant' ? camp : undefined;
}

/**
 * The performer takes up to `allowance` cards out of the minor discard.
 *
 * Each pull goes through the ordinary generic `select-from-discard` command, so
 * card conservation, deck checks, and zone authorization all behave exactly as
 * they do everywhere else — the discard pile is `public-top` (physically
 * inspectable, spec §8.2) and the destination is the performer's own private
 * zone, a move the generic rule already permits without any special layer.
 */
export function selectInspiration(
	state: SessionEngineStateV1,
	input: { cardIds: CardId[] },
	context: CampReduceContext
): SessionReduceResult {
	const camp = readHighChant(state);
	if (!camp) return reject('illegal-command', 'no High Chant is in progress');
	if (camp.stage !== 'select') return reject('illegal-command', `cards cannot be selected at stage ${camp.stage}`);

	const performer = actorFacts(context, camp.performerTenureId);
	if (!performer || context.actor.kind !== 'player' || context.actor.userId !== performer.userId) {
		return reject('not-authorized', 'only the performing adventurer may select inspiration cards');
	}

	if (input.cardIds.length === 0) return reject('illegal-command', 'select at least one inspiration card');
	if (input.cardIds.length > camp.allowance) {
		return reject('illegal-command', `the High Chant allows ${camp.allowance} card(s), not ${input.cardIds.length}`);
	}
	if (new Set(input.cardIds).size !== input.cardIds.length) {
		return reject('illegal-command', 'the same card cannot be selected twice');
	}

	const zoneId = highChantSelectionZoneId(camp.performerTenureId);
	let working = ensurePrivateZone(state, zoneId, performer.userId);
	const events: SessionEvent[] = [];

	for (const cardId of input.cardIds) {
		const moved = reduceSession(
			working,
			{ type: 'select-from-discard', sourceZoneId: 'playerDiscard', cardId, destinationZoneId: zoneId },
			context
		);
		// A card the performer named that is not actually in the discard rejects
		// here, and because nothing has been committed yet the whole selection is
		// abandoned rather than partially applied.
		if (!moved.ok) return moved;
		working = moved.state;
		events.push(...moved.events);
	}

	const next: HighChantStateV1 = { ...camp, stage: 'distribute', selectedCardIds: [...input.cardIds] };
	return {
		ok: true,
		state: writeCampProcedure(working, next),
		events: [
			...events,
			{
				kind: 'camp-inspiration-selected',
				// Count only: the faces are the performer's to know until they hand
				// one over, and the private payloads of the moves above already told
				// them which.
				publicPayload: { performerTenureId: camp.performerTenureId, count: input.cardIds.length }
			}
		]
	};
}

/**
 * Hands one selected card to a recipient's inspiration zone. Ch5 allows the
 * performer to keep one, so the recipient may be the performer's own tenure.
 *
 * The one-per-player cap is enforced against the recipient's CURRENT zone
 * contents rather than a counter, so it stays correct across a reload and cannot
 * drift from the cards actually held.
 */
export function completeHighChantTransfer(
	state: SessionEngineStateV1,
	input: { cardId: CardId; recipientTenureId: string },
	context: CampReduceContext
): SessionReduceResult {
	const camp = readHighChant(state);
	if (!camp) return reject('illegal-command', 'no High Chant is in progress');
	if (camp.stage !== 'distribute') return reject('illegal-command', `inspiration cannot be handed over at stage ${camp.stage}`);

	const performer = actorFacts(context, camp.performerTenureId);
	if (!performer || context.actor.kind !== 'player' || context.actor.userId !== performer.userId) {
		return reject('not-authorized', 'only the performing adventurer may distribute their own selection');
	}

	const undistributed = camp.selectedCardIds.filter(
		(cardId) => !camp.assignments.some((assignment) => assignment.cardId === cardId)
	);
	if (!undistributed.includes(input.cardId)) {
		return reject('illegal-command', 'that card is not part of the undistributed selection');
	}

	const recipient = actorFacts(context, input.recipientTenureId);
	if (!recipient) return reject('illegal-command', `no adventurer at this table holds tenure ${input.recipientTenureId}`);

	const recipientZoneId = inspirationZoneId(input.recipientTenureId);
	const held = findZoneDescriptor(state, recipientZoneId)?.cards.length ?? 0;
	if (held >= context.config.maxInspirationPerPlayer) {
		return reject(
			'illegal-command',
			`${input.recipientTenureId} already holds ${held} inspiration card(s); no player may hold more than ${context.config.maxInspirationPerPlayer}`
		);
	}

	const withZone = ensurePrivateZone(state, recipientZoneId, recipient.userId);
	const transferred = performPrivateTransfer(
		withZone,
		{
			senderUserId: performer.userId,
			recipientUserId: recipient.userId,
			senderZoneId: highChantSelectionZoneId(camp.performerTenureId),
			recipientZoneId,
			cardId: input.cardId,
			eventKind: 'camp-inspiration-granted',
			reason: 'high-chant',
			// Tenures and a count only — never the card id (see
			// `private-transfer.ts`'s privacy note).
			publicExtra: { performerTenureId: camp.performerTenureId, recipientTenureId: input.recipientTenureId }
		},
		context.runtime
	);
	if (!transferred.ok) return transferred;

	const next: HighChantStateV1 = {
		...camp,
		assignments: [...camp.assignments, { cardId: input.cardId, recipientTenureId: input.recipientTenureId }]
	};
	return { ok: true, state: writeCampProcedure(transferred.state, next), events: transferred.events };
}

// ---------------------------------------------------------------------------
// Leeches
// ---------------------------------------------------------------------------

/** The public zone the leeches draw lands in. `kind: 'revealed'` — the pack's
 * steps are `visibility: 'public'`, so the card is face-up from the moment it is
 * drawn. */
function leechesZoneId(tenureId: string): string {
	return `camp-leeches:${tenureId}`;
}

/**
 * Applies leeches to ANOTHER adventurer (Ch9's wording is explicit, so
 * self-application is rejected rather than silently allowed).
 *
 * Whether the actor actually carries a jar of leeches is inventory state this
 * engine does not model — the GM adjudicates the item, exactly as they do for
 * every other Use an Item action.
 */
export function beginLeeches(
	state: SessionEngineStateV1,
	input: { targetTenureId: string },
	context: CampReduceContext
): SessionReduceResult {
	if (isCampProcedureCorrupt(state)) {
		return reject('illegal-command', 'the active Camp procedure is corrupt and cannot be read — contact the GM');
	}
	if (state.procedure !== null) return reject('illegal-command', 'another procedure is already active');

	const actor = actingTenure(context);
	if (!actor) return reject('illegal-command', 'only an adventurer at this table may apply leeches');
	if (actor.tenureId === input.targetTenureId) {
		return reject('illegal-command', 'leeches are applied to another adventurer, never to yourself');
	}
	if (!actorFacts(context, input.targetTenureId)) {
		return reject('illegal-command', `no adventurer at this table holds tenure ${input.targetTenureId}`);
	}

	const camp: LeechesStateV1 = {
		schemaVersion: 1,
		kind: 'leeches',
		stage: 'draw',
		actorTenureId: actor.tenureId,
		targetTenureId: input.targetTenureId,
		drawnCardId: null,
		drawnCardZoneId: null,
		outcome: null
	};

	return {
		ok: true,
		state: writeCampProcedure(state, camp),
		events: [
			{
				kind: 'camp-leeches-begun',
				publicPayload: {
					procedureId: CAMP_LEECHES_PROCEDURE_ID,
					actorTenureId: actor.tenureId,
					targetTenureId: input.targetTenureId
				}
			}
		]
	};
}

function readLeeches(state: SessionEngineStateV1): LeechesStateV1 | undefined {
	const camp = readCampProcedure(state);
	return camp?.kind === 'leeches' ? camp : undefined;
}

/**
 * Draws the card and classifies it against the pack's two suit sets.
 *
 * A card in neither set — the Fool, which is a major card with no suit — is no
 * effect: the rule names only the four suits, so anything without one cannot
 * satisfy the cure condition. Derived from the content's own sets rather than a
 * hardcoded suit list, so a pack that reassigned these suits would change the
 * behavior with no code change.
 */
export function advanceLeeches(state: SessionEngineStateV1, context: CampReduceContext): SessionReduceResult {
	const camp = readLeeches(state);
	if (!camp) return reject('illegal-command', 'no leeches application is in progress');
	if (camp.stage !== 'draw') return reject('illegal-command', `leeches cannot be drawn for at stage ${camp.stage}`);

	const actor = actorFacts(context, camp.actorTenureId);
	if (!actor || context.actor.kind !== 'player' || context.actor.userId !== actor.userId) {
		return reject('not-authorized', 'only the applying adventurer may resolve their leeches');
	}

	const zoneId = leechesZoneId(camp.actorTenureId);
	const withZone: SessionEngineStateV1 = state.publicZones.some((zone) => zone.id === zoneId)
		? state
		: { ...state, publicZones: [...state.publicZones, { id: zoneId, kind: 'revealed', cards: [] }] };

	const drawn = reduceSession(withZone, { type: 'draw', deck: 'player', destinationZoneId: zoneId, count: 1 }, context);
	if (!drawn.ok) return drawn;

	const cardId = findZoneDescriptor(drawn.state, zoneId)!.cards.at(-1)!;
	const suit = context.runtime.catalog[cardId]?.suit;
	const cures = suit !== undefined && context.config.leechesCureSuits.includes(suit);

	const outcome: LeechesOutcome = cures
		? { effect: 'cure-affliction', charges: context.config.leechesCureCharges, targetTenureId: camp.targetTenureId }
		: { effect: 'no-effect', charges: null, targetTenureId: camp.targetTenureId };

	const next: LeechesStateV1 = { ...camp, stage: 'complete', drawnCardId: cardId, drawnCardZoneId: zoneId, outcome };

	return {
		ok: true,
		state: writeCampProcedure(drawn.state, next),
		events: [
			...drawn.events,
			{
				kind: 'camp-leeches-resolved',
				publicPayload: {
					actorTenureId: camp.actorTenureId,
					targetTenureId: camp.targetTenureId,
					cardId,
					...(suit !== undefined ? { suit } : {}),
					effect: outcome.effect,
					charges: outcome.charges,
					/** The app supplies the rule's answer and never applies it: burning
					 * charges and clearing an affliction are sheet edits the table makes
					 * (spec §8.6). Flagged so the panel says so rather than implying the
					 * app already did it. */
					manualConsequence: true
				}
			}
		]
	};
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Finalizes whichever Camp procedure is running. The performer (or the GM, for a
 * procedure a player abandoned) may finish it.
 *
 * High Chant: any undistributed selection returns to the minor discard it came
 * from, and the staging zone is removed. Distributed inspiration is deliberately
 * left in place — Ch5: "Inspiration cards last until used or until the end of
 * the session, whichever comes first."
 *
 * Leeches: the drawn card goes to the minor discard and its public zone is
 * removed. Note what is NOT here: no reshuffle. `camp-leeches`'s steps carry no
 * `reshuffle` rule, unlike `test-of-fate`'s `boundary: 'test-resolution'`, so a
 * Fool drawn during leeches stays scheduled for `end-round` exactly as the
 * generic `handleDraw` left it. Content decides the boundary, not this function.
 */
export function completeCampProcedure(state: SessionEngineStateV1, context: CampReduceContext): SessionReduceResult {
	const camp = readCampProcedure(state);
	if (!camp) return reject('illegal-command', 'no Camp procedure is in progress');

	const ownerTenureId = camp.kind === 'high-chant' ? camp.performerTenureId : camp.actorTenureId;
	const owner = actorFacts(context, ownerTenureId);
	const isOwner = owner !== undefined && context.actor.kind === 'player' && context.actor.userId === owner.userId;
	if (!isOwner && context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the acting adventurer or the GM may finish a Camp procedure');
	}

	if (camp.kind === 'leeches' && camp.stage !== 'complete') {
		return reject('illegal-command', 'the leeches draw has not been resolved yet');
	}

	let working = state;
	const events: SessionEvent[] = [];

	const returnZoneId =
		camp.kind === 'high-chant' ? highChantSelectionZoneId(camp.performerTenureId) : (camp.drawnCardZoneId ?? null);

	if (returnZoneId) {
		for (const cardId of findZoneDescriptor(working, returnZoneId)?.cards.slice() ?? []) {
			const moved = reduceSession(
				working,
				{ type: 'discard', sourceZoneId: returnZoneId, cardId, destinationZoneId: 'playerDiscard' },
				// Discarding out of a zone the acting player may not own (the GM
				// finishing an abandoned procedure) needs GM authority; the ownership
				// check above already established the actor is entitled to finish.
				{ ...context, actor: { kind: 'gm', userId: context.actor.userId } }
			);
			/* v8 ignore start -- the card was just read out of the zone it is being
			 * moved from, and a GM actor may access every zone, so this cannot be
			 * refused; kept only to narrow away the rejection variant. */
			if (!moved.ok) return moved;
			/* v8 ignore stop */
			working = moved.state;
			events.push(...moved.events);
		}
		working = camp.kind === 'high-chant' ? withoutPrivateZone(working, returnZoneId) : withoutPublicZone(working, returnZoneId);
	}

	return {
		ok: true,
		state: clearCampProcedure(working),
		events: [
			...events,
			{
				kind: 'camp-procedure-completed',
				publicPayload: {
					procedureId: CAMP_PROCEDURE_IDS[camp.kind],
					...(camp.kind === 'high-chant'
						? { performerTenureId: camp.performerTenureId, granted: camp.assignments.length }
						: { actorTenureId: camp.actorTenureId, effect: camp.outcome?.effect ?? null })
				}
			}
		]
	};
}

/** Every suit the pack recognizes for leeches, for a panel that wants to explain
 * the rule before drawing. Exported so the UI never restates the suit sets. */
export function leechesSuitSummary(config: CampConfig): { noEffect: SuitId[]; cure: SuitId[] } {
	return { noEffect: [...config.leechesNoEffectSuits], cure: [...config.leechesCureSuits] };
}

/** Guard used by the schema-driven tests: every suit named by the pack must be a
 * real suit id. */
export function isSuitId(value: string): value is SuitId {
	return (SUIT_IDS as readonly string[]).includes(value);
}
