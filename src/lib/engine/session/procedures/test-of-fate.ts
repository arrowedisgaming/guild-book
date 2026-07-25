/**
 * The guided individual test of fate (Increment 4 Task 2) — Ch1 "Tests of
 * Fate", "Favor and disfavor", "Pushing fate", "Pushing fate with the Fool".
 *
 * This module owns the STAGE MACHINE and the authorization split only. Every
 * arithmetic rule is delegated to Increment 0.5's `resolveTestOfFate`
 * (`$lib/engine/tarot-resolution`) — the threshold, the favor modifier, the
 * great-success condition, and all three Fool rules are content-driven there
 * and are deliberately NOT reimplemented here. Every card movement is an
 * ordinary `SessionCommand` run through the shared `reduceSession` pipeline, so
 * authorization, deck checks, and the card-conservation invariant apply
 * unchanged — the same composition discipline `procedures/challenge/reducer.ts`
 * established.
 *
 * ## Why a guided test is a PEER of `state.procedure`, not its occupant
 *
 * Ch7 p.120's Test Fate action: "the GM can call for a test of fate
 * mid-Challenge." Ch5's High Chant and Appendix A's Augury likewise invoke a
 * test from inside their own procedures. So a test of fate genuinely runs
 * concurrently with a host procedure, and `handleBeginProcedure`'s "a procedure
 * is already active" rejection would make all three unreachable. The in-flight
 * test therefore lives in its own additive slot,
 * `SessionEngineStateV1.guidedTest`, and this module NEVER reads or writes
 * `state.procedure` — a host procedure's stage/step is none of its business.
 *
 * ## What the client may and may not supply
 *
 * The tested attribute's value and the actor's current Resolve are read from
 * server-supplied `GuidedTestMaterials`, never from a command. A command that
 * tried to carry an attribute is rejected by the strict schema in
 * `$lib/schemas/guided-test-command.schema.ts` before reaching this module —
 * otherwise a client could test against any number it liked.
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import { z } from 'zod';
import { SUIT_IDS, type SuitId } from '$lib/types/common';
import type { TarotConfig, TarotProcedureDefinition } from '$lib/types/content-pack';
import type { CardId, SessionEngineStateV1, SessionEvent, SessionRejection } from '$lib/types/session';
import { resolveTestOfFate, type ResolutionCard, type TestOfFateResult } from '$lib/engine/tarot-resolution';
import { reduceSession, type ReduceContext } from '../reducer';
import type { ReduceResult } from '../result';
import { findZoneDescriptor } from '../state';
import { reshuffleDeck } from '../shuffle';

/** Matches the shared `reducer.ts`'s own alias so callers can treat
 * `reduceSession` and these functions interchangeably. */
export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

/** The content pack's `test-of-fate` procedure id. */
export const TEST_OF_FATE_PROCEDURE_ID = 'test-of-fate';

/**
 * Which draw a test zone holds. Two zones rather than one because
 * `resolveTestOfFate` needs to know which card was the INITIAL draw (only an
 * initial tested-suit card can great-succeed) and which came from the push
 * (only a pushed Fool is an automatic great failure). A single zone would
 * collapse that distinction into array order.
 */
export type GuidedTestDrawSlot = 'initial' | 'push';

/** A test's public, face-up card zone. Keyed by TENURE (not user id) so a
 * group test's two subtests never collide, and so a dead tenure's leftover
 * zone stays addressable separately from a replacement's — the same reasoning
 * as `challengeHandZoneId`. */
export function guidedTestZoneId(tenureId: string, slot: GuidedTestDrawSlot): string {
	return `test-of-fate:${tenureId}:${slot}`;
}

/**
 * What the test is waiting for.
 *
 * The plan's fifth stage, `declare`, is deliberately absent: "waiting for the
 * GM to declare a test" is exactly the state in which no slot exists at all
 * (`state.guidedTest` is absent), so a stored `'declare'` value would be
 * unreachable dead code. `readGuidedTest` returning `undefined` IS that stage.
 */
export type GuidedTestStage = 'favor' | 'initial-draw' | 'push-offer' | 'complete';

export interface GuidedTestStateV1 {
	schemaVersion: 1;
	stage: GuidedTestStage;
	actorTenureId: string;
	testedSuit: SuitId;
	/** Circumstantial favor — aid, a relevant motif, fictional positioning. */
	favor: boolean;
	disfavor: boolean;
	/** Set by `purchaseTestFavorWithResolve`. The engine only RECORDS the
	 * purchase; the character write itself is the server's job, spliced into
	 * the same atomic unit as the accepted command (Task 1's
	 * `buildResolveIntentStatements`). */
	resolvePurchase: null | { characterId: string; spent: 1 };
	initialCardZoneId: string | null;
	pushCardZoneId: string | null;
	result: TestOfFateResult | null;
	/**
	 * `reshuffleAtBoundary` as it stood BEFORE this test began.
	 *
	 * `test-of-fate`'s own reshuffle rule has `boundary: 'test-resolution'`,
	 * but a Challenge's has `boundary: 'end-round'` — and both can be pending
	 * at once. `handleDraw` cannot tell them apart: it sets the same two flags
	 * for any Fool draw. Without this snapshot, completing a test would either
	 * consume a Challenge's still-pending end-round reshuffle (wrong timing for
	 * the host) or leave the test's own reshuffle scheduled for an `end-round`
	 * that its boundary never mentions. Restoring these values at completion
	 * consumes exactly the test's own scheduling and no one else's.
	 */
	reshuffleBefore: { major: boolean; player: boolean };
}

/**
 * One eligible adventurer's server-read facts. All four attributes travel
 * together because the tested suit is chosen at declare time — the server
 * cannot know in advance which one the GM will call for, and a group test
 * needs to rank candidates by whichever attribute is tested.
 */
export interface GuidedTestActorFacts {
	tenureId: string;
	characterId: string;
	userId: string;
	attributes: Record<SuitId, number>;
	resolveCurrent: number;
	/**
	 * The character row's current version. The engine itself never reads this —
	 * it exists so the projection can hand the TESTING player (and only them)
	 * the second half of Task 1's reconfirmation pair, which their
	 * `purchase-test-favor` envelope must carry alongside `expectedResolveCurrent`.
	 * Without it the panel would have to fetch the sheet separately just to
	 * name a version, and a version fetched at a different moment than the
	 * Resolve value is exactly the mismatch the pair exists to detect.
	 */
	characterVersion: number;
	/** Position in the guild's roster — `selectGroupTestActors`' stable
	 * tie-break (Ch1 "Group tests"). */
	rosterOrder: number;
}

/** Every attached, living adventurer the server has read from the sheet. The
 * engine trusts nothing else about attributes or Resolve. */
export interface GuidedTestMaterials {
	actors: GuidedTestActorFacts[];
}

export interface GuidedTestReduceContext extends ReduceContext {
	config: TarotConfig;
	materials: GuidedTestMaterials;
	/** The content pack's `test-of-fate` definition — read for its steps'
	 * `reshuffle` rule rather than hardcoding which decks a Fool disturbs. */
	procedure: TarotProcedureDefinition;
}

const suitIdSchema = z.enum(SUIT_IDS);

const guidedTestStateV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		stage: z.enum(['favor', 'initial-draw', 'push-offer', 'complete']),
		actorTenureId: z.string().trim().min(1).max(128),
		testedSuit: suitIdSchema,
		favor: z.boolean(),
		disfavor: z.boolean(),
		resolvePurchase: z
			.object({ characterId: z.string().trim().min(1).max(128), spent: z.literal(1) })
			.strict()
			.nullable(),
		initialCardZoneId: z.string().nullable(),
		pushCardZoneId: z.string().nullable(),
		// `TestOfFateResult` is Increment 0.5's shape; validated structurally here
		// so a corrupt blob can never be read back as a live result.
		result: z
			.object({
				total: z.number().int(),
				modifier: z.number().int(),
				favorSources: z.array(z.enum(['circumstance', 'resolve'])),
				outcome: z.enum(['great-success', 'success', 'failure', 'great-failure']),
				outcomeLabel: z.string(),
				initialDrawMatchedTestedSuit: z.boolean(),
				pushed: z.boolean(),
				canPush: z.boolean(),
				automaticGreatFailure: z.boolean(),
				foolDrawn: z.boolean()
			})
			.strict()
			.nullable(),
		reshuffleBefore: z.object({ major: z.boolean(), player: z.boolean() }).strict()
	})
	.strict();

function reject(code: SessionRejection['code'], message: string): SessionReduceResult {
	return { ok: false, rejection: { code, message } };
}

/** Reads and validates the in-flight test. `undefined` means no test is
 * running (or a corrupt blob) — never throws, so callers can turn it into a
 * proper rejection. */
export function readGuidedTest(state: SessionEngineStateV1): GuidedTestStateV1 | undefined {
	if (state.guidedTest === undefined || state.guidedTest === null) return undefined;
	const result = guidedTestStateV1Schema.safeParse(state.guidedTest);
	return result.success ? result.data : undefined;
}

/**
 * Distinguishes a genuinely-absent test from a CORRUPT one — `readGuidedTest`
 * collapses both into `undefined`, which would present a corrupt blob as "no
 * test running" and let a second declaration silently overwrite it. Mirrors
 * `isChallengeStateCorrupt`.
 */
export function isGuidedTestCorrupt(state: SessionEngineStateV1): boolean {
	if (state.guidedTest === undefined || state.guidedTest === null) return false;
	return !guidedTestStateV1Schema.safeParse(state.guidedTest).success;
}

/** Validates `test` and writes it back to the slot. Throws on an invalid
 * shape — a reducer bug, not a rejectable user error. */
export function writeGuidedTest(state: SessionEngineStateV1, test: GuidedTestStateV1): SessionEngineStateV1 {
	return { ...state, guidedTest: guidedTestStateV1Schema.parse(test) };
}

function clearGuidedTest(state: SessionEngineStateV1): SessionEngineStateV1 {
	const next = { ...state };
	delete next.guidedTest;
	return next;
}

function findActor(context: GuidedTestReduceContext, tenureId: string): GuidedTestActorFacts | undefined {
	return context.materials.actors.find((actor) => actor.tenureId === tenureId);
}

/** The acting player is the one who OWNS the tested tenure. The GM may drive
 * neither the draw nor the push: Ch1 puts both in the player's hands ("the
 * player may opt to push fate"). */
function actorOwnsTest(context: GuidedTestReduceContext, test: GuidedTestStateV1): boolean {
	const facts = findActor(context, test.actorTenureId);
	return facts !== undefined && context.actor.kind === 'player' && context.actor.userId === facts.userId;
}

/** Builds the `ResolutionCard` `resolveTestOfFate` consumes from the pinned
 * runtime catalog. `origin: 'test-draw'` is what makes an initial tested-suit
 * card eligible for great success and a pushed Fool an automatic great
 * failure — a card that arrived any other way is `'supplied'`. */
function resolutionCard(cardId: CardId, context: GuidedTestReduceContext): ResolutionCard {
	const entry = context.runtime.catalog[cardId];
	return {
		id: cardId,
		value: entry?.value ?? 0,
		...(entry?.suit !== undefined ? { suit: entry.suit } : {}),
		origin: 'test-draw'
	};
}

/** Reads the drawn card out of a test zone. A zone holding anything other
 * than exactly one card means a reducer bug, not user input. */
function soleCardIn(state: SessionEngineStateV1, zoneId: string): CardId {
	const zone = findZoneDescriptor(state, zoneId);
	if (!zone || zone.cards.length !== 1) {
		throw new Error(`guided test zone ${zoneId} should hold exactly one card, found ${zone?.cards.length ?? 'no zone'}`);
	}
	return zone.cards[0];
}

/** Adds the public, face-up zone a test draw lands in. `kind: 'revealed'` is
 * the existing public-zone kind for "a card whose identity the table can see"
 * — `test-of-fate`'s steps are both `visibility: 'public'`/
 * `resultVisibility: 'public'` in the content pack, so no private or pending
 * zone is warranted. */
function withTestZone(state: SessionEngineStateV1, zoneId: string): SessionEngineStateV1 {
	if (state.publicZones.some((zone) => zone.id === zoneId)) return state;
	return { ...state, publicZones: [...state.publicZones, { id: zoneId, kind: 'revealed', cards: [] }] };
}

function withoutTestZones(state: SessionEngineStateV1, zoneIds: readonly string[]): SessionEngineStateV1 {
	return { ...state, publicZones: state.publicZones.filter((zone) => !zoneIds.includes(zone.id)) };
}

// ---------------------------------------------------------------------------
// Stage transitions
// ---------------------------------------------------------------------------

export interface DeclareTestOfFateInput {
	actorTenureId: string;
	testedSuit: SuitId;
}

/**
 * The GM declares the fictional test: who is testing and which suit. Ch1 puts
 * the call in the GM's hands ("the GM can call for a test of fate"), so a
 * player-issued declaration is `not-authorized`.
 */
export function declareTestOfFate(
	state: SessionEngineStateV1,
	input: DeclareTestOfFateInput,
	context: GuidedTestReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may call for a test of fate');
	if (isGuidedTestCorrupt(state)) {
		return reject('illegal-command', 'the in-flight test of fate is corrupt and cannot be read — contact the GM');
	}
	if (readGuidedTest(state)) return reject('illegal-command', 'a test of fate is already in flight');

	const facts = findActor(context, input.actorTenureId);
	if (!facts) return reject('illegal-command', `no adventurer at this table holds tenure ${input.actorTenureId}`);

	const test: GuidedTestStateV1 = {
		schemaVersion: 1,
		stage: 'favor',
		actorTenureId: input.actorTenureId,
		testedSuit: input.testedSuit,
		favor: false,
		disfavor: false,
		resolvePurchase: null,
		initialCardZoneId: null,
		pushCardZoneId: null,
		result: null,
		reshuffleBefore: { ...state.reshuffleAtBoundary }
	};

	return {
		ok: true,
		state: writeGuidedTest(state, test),
		events: [
			{
				kind: 'guided-test-declared',
				publicPayload: {
					procedureId: TEST_OF_FATE_PROCEDURE_ID,
					actorTenureId: input.actorTenureId,
					testedSuit: input.testedSuit
				}
			}
		]
	};
}

/**
 * Settles circumstantial favor/disfavor (aid, a relevant motif, fictional
 * positioning) and opens the draw. GM-adjudicated: Ch1 makes favor a GM call
 * on the fiction, not a player election. Both true is legal and cancels —
 * `resolveTestOfFate` owns that arithmetic.
 */
export function setTestFavor(
	state: SessionEngineStateV1,
	input: { favor: boolean; disfavor: boolean },
	context: GuidedTestReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may settle favor and disfavor');
	const test = readGuidedTest(state);
	if (!test) return reject('illegal-command', 'no test of fate is in flight');
	if (test.stage !== 'favor') return reject('illegal-command', `favor cannot be settled at stage ${test.stage}`);

	const next: GuidedTestStateV1 = { ...test, stage: 'initial-draw', favor: input.favor, disfavor: input.disfavor };
	return {
		ok: true,
		state: writeGuidedTest(state, next),
		events: [
			{
				kind: 'guided-test-favor-set',
				publicPayload: { actorTenureId: test.actorTenureId, favor: input.favor, disfavor: input.disfavor }
			}
		]
	};
}

/**
 * The acting player buys favor with 1 Resolve. Ch1: "You may elect to spend a
 * point of Resolve *prior* to a test of fate in order to gain favor" — so this
 * is legal ONLY at `initial-draw`, before any card is drawn, and never as a
 * push cost (pushing is free).
 *
 * Affordability is checked against server-read `resolveCurrent`. The engine
 * records the purchase; the narrow character write is the server's
 * (`buildResolveIntentStatements`), spliced into the same atomic unit so the
 * spend and the draw it paid for can never come apart.
 */
export function purchaseTestFavorWithResolve(
	state: SessionEngineStateV1,
	context: GuidedTestReduceContext
): SessionReduceResult {
	const test = readGuidedTest(state);
	if (!test) return reject('illegal-command', 'no test of fate is in flight');
	if (!actorOwnsTest(context, test)) return reject('not-authorized', 'only the testing adventurer may spend their Resolve');
	if (test.stage !== 'initial-draw') {
		return reject('illegal-command', 'Resolve buys favor only before the draw');
	}
	if (test.resolvePurchase) return reject('illegal-command', 'favor has already been bought for this test');

	const facts = findActor(context, test.actorTenureId)!;
	if (facts.resolveCurrent < 1) return reject('illegal-command', 'not enough Resolve to buy favor');

	const next: GuidedTestStateV1 = { ...test, resolvePurchase: { characterId: facts.characterId, spent: 1 } };
	return {
		ok: true,
		state: writeGuidedTest(state, next),
		events: [{ kind: 'guided-test-resolve-purchased', publicPayload: { actorTenureId: test.actorTenureId, spent: 1 } }]
	};
}

/** Runs one public test draw into `zoneId` as the acting player, through the
 * ordinary generic `draw` command so deck exhaustion, reshuffle-on-empty, and
 * the card-conservation invariant all behave exactly as they do everywhere
 * else. */
function drawIntoTestZone(
	state: SessionEngineStateV1,
	zoneId: string,
	context: GuidedTestReduceContext
): SessionReduceResult {
	const withZone = withTestZone(state, zoneId);
	return reduceSession(withZone, { type: 'draw', deck: 'player', destinationZoneId: zoneId, count: 1 }, context);
}

function resolutionEvent(test: GuidedTestStateV1, result: TestOfFateResult): SessionEvent {
	return {
		kind: 'guided-test-resolved',
		publicPayload: {
			actorTenureId: test.actorTenureId,
			testedSuit: test.testedSuit,
			total: result.total,
			modifier: result.modifier,
			favorSources: result.favorSources,
			outcome: result.outcome,
			outcomeLabel: result.outcomeLabel,
			pushed: result.pushed,
			canPush: result.canPush,
			foolDrawn: result.foolDrawn
		}
	};
}

/**
 * The initial draw. Classifies immediately and either offers the free push
 * (Ch1: "If the result of the test is a failure, the player may opt to push
 * fate") or finishes. Both the card and the outcome are public the moment they
 * exist — `test-of-fate`'s steps are `resultVisibility: 'public'`.
 */
export function drawTestCard(state: SessionEngineStateV1, context: GuidedTestReduceContext): SessionReduceResult {
	const test = readGuidedTest(state);
	if (!test) return reject('illegal-command', 'no test of fate is in flight');
	if (!actorOwnsTest(context, test)) return reject('not-authorized', 'only the testing adventurer may draw for their test');
	if (test.stage !== 'initial-draw') return reject('illegal-command', `a test card cannot be drawn at stage ${test.stage}`);

	const zoneId = guidedTestZoneId(test.actorTenureId, 'initial');
	const drawn = drawIntoTestZone(state, zoneId, context);
	if (!drawn.ok) return drawn;

	const facts = findActor(context, test.actorTenureId)!;
	const result = resolveTestOfFate(context.config, {
		attribute: facts.attributes[test.testedSuit],
		testedSuit: test.testedSuit,
		initialCard: resolutionCard(soleCardIn(drawn.state, zoneId), context),
		pushCard: null,
		favor: test.favor,
		disfavor: test.disfavor,
		resolveSpentForFavor: test.resolvePurchase !== null
	});

	const next: GuidedTestStateV1 = {
		...test,
		stage: result.canPush ? 'push-offer' : 'complete',
		initialCardZoneId: zoneId,
		result
	};

	return {
		ok: true,
		state: writeGuidedTest(drawn.state, next),
		events: [...drawn.events, resolutionEvent(next, result)]
	};
}

/**
 * The free push (Ch1 "Pushing fate"). Legal only off a failure — which is
 * exactly what stage `push-offer` means — and never costs Resolve. A pushed
 * Fool is an automatic great failure; `resolveTestOfFate` owns that rule.
 */
export function pushTestFate(state: SessionEngineStateV1, context: GuidedTestReduceContext): SessionReduceResult {
	const test = readGuidedTest(state);
	if (!test) return reject('illegal-command', 'no test of fate is in flight');
	if (!actorOwnsTest(context, test)) return reject('not-authorized', 'only the testing adventurer may push their fate');
	if (test.stage !== 'push-offer') return reject('illegal-command', 'fate can only be pushed off a failed test');

	const zoneId = guidedTestZoneId(test.actorTenureId, 'push');
	const drawn = drawIntoTestZone(state, zoneId, context);
	if (!drawn.ok) return drawn;

	const facts = findActor(context, test.actorTenureId)!;
	const result = resolveTestOfFate(context.config, {
		attribute: facts.attributes[test.testedSuit],
		testedSuit: test.testedSuit,
		initialCard: resolutionCard(soleCardIn(drawn.state, test.initialCardZoneId!), context),
		pushCard: resolutionCard(soleCardIn(drawn.state, zoneId), context),
		favor: test.favor,
		disfavor: test.disfavor,
		resolveSpentForFavor: test.resolvePurchase !== null
	});

	const next: GuidedTestStateV1 = { ...test, stage: 'complete', pushCardZoneId: zoneId, result };
	return {
		ok: true,
		state: writeGuidedTest(drawn.state, next),
		events: [...drawn.events, resolutionEvent(next, result)]
	};
}

/** The acting player declines the offered push, finishing on the original
 * failure. A distinct command rather than an implicit timeout: the offer is
 * the player's to refuse, and the table needs the refusal in the log. */
export function declineTestPush(state: SessionEngineStateV1, context: GuidedTestReduceContext): SessionReduceResult {
	const test = readGuidedTest(state);
	if (!test) return reject('illegal-command', 'no test of fate is in flight');
	if (!actorOwnsTest(context, test)) return reject('not-authorized', 'only the testing adventurer may decline their push');
	if (test.stage !== 'push-offer') return reject('illegal-command', 'no push is on offer');

	const next: GuidedTestStateV1 = { ...test, stage: 'complete', result: { ...test.result!, canPush: false } };
	return {
		ok: true,
		state: writeGuidedTest(state, next),
		events: [{ kind: 'guided-test-push-declined', publicPayload: { actorTenureId: test.actorTenureId } }]
	};
}

/** Which decks this procedure's `reshuffle` rule disturbs, read from the
 * content pack rather than hardcoded. The pack names decks `minor`/`major`;
 * the engine's flags are `player`/`major` for the same two piles. */
function reshuffleDecksFor(procedure: TarotProcedureDefinition): { major: boolean; player: boolean } {
	const decks = procedure.steps.flatMap((step) => step.reshuffle?.decks ?? []);
	return { major: decks.includes('major'), player: decks.includes('minor') };
}

/**
 * The GM finalizes: the test's cards go to the minor discard, its zones are
 * removed, and the slot is cleared.
 *
 * A Fool drawn during the test reshuffles here rather than at `end-round`,
 * because `test-of-fate`'s own reshuffle rule says `boundary:
 * 'test-resolution'`. Cards are discarded BEFORE the reshuffle so the Fool
 * itself goes back into the deck (spec §8.4: "remember to shuffle both
 * decks"). `reshuffleBefore` is then restored, so a host procedure's
 * still-pending `end-round` reshuffle survives untouched — see that field's
 * doc comment.
 */
export function completeGuidedTest(state: SessionEngineStateV1, context: GuidedTestReduceContext): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may finalize a test of fate');
	const test = readGuidedTest(state);
	if (!test) return reject('illegal-command', 'no test of fate is in flight');
	if (test.stage !== 'complete') return reject('illegal-command', `a test at stage ${test.stage} is not yet resolved`);

	const zoneIds = [test.initialCardZoneId, test.pushCardZoneId].filter((id): id is string => id !== null);

	// Discard through the ordinary generic command so the movement is audited
	// and invariant-checked exactly like any other.
	let working = state;
	const events: SessionEvent[] = [];
	for (const zoneId of zoneIds) {
		const zone = findZoneDescriptor(working, zoneId);
		for (const cardId of zone?.cards.slice() ?? []) {
			const moved = reduceSession(
				working,
				{ type: 'discard', sourceZoneId: zoneId, cardId, destinationZoneId: 'playerDiscard' },
				context
			);
			/* v8 ignore start -- a GM discarding a card that is provably present in
			 * a public zone into the minor discard has no rejectable failure mode;
			 * kept only so `working` narrows away from the rejection variant. */
			if (!moved.ok) return moved;
			/* v8 ignore stop */
			working = moved.state;
			events.push(...moved.events);
		}
	}

	working = withoutTestZones(working, zoneIds);

	if (test.result?.foolDrawn) {
		const decks = reshuffleDecksFor(context.procedure);
		if (decks.player) {
			const { drawPile, discardPile } = reshuffleDeck(working.playerDraw, working.playerDiscard, context.rng);
			working = { ...working, playerDraw: drawPile, playerDiscard: discardPile };
		}
		if (decks.major) {
			const { drawPile, discardPile } = reshuffleDeck(working.majorDraw, working.majorDiscard, context.rng);
			working = { ...working, majorDraw: drawPile, majorDiscard: discardPile };
		}
	}

	working = { ...working, reshuffleAtBoundary: { ...test.reshuffleBefore } };

	return {
		ok: true,
		state: clearGuidedTest(working),
		events: [
			...events,
			{
				kind: 'guided-test-completed',
				publicPayload: {
					actorTenureId: test.actorTenureId,
					outcome: test.result?.outcome ?? null,
					reshuffled: test.result?.foolDrawn ?? false
				}
			}
		]
	};
}
