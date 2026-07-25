/**
 * The guided group test (Increment 4 Task 2 Step 3) — Ch1 "Group tests":
 * "the most qualified and least qualified adventurers each make a test of
 * fate", the GM totals their hits, and a configured band classifies the group's
 * result.
 *
 * ## This module sequences; it does not reimplement
 *
 * A group test is literally two COMPLETE tests of fate. So the individual
 * guided test in `./test-of-fate.ts` runs each subtest verbatim — same stage
 * machine, same authorization, same `resolveTestOfFate` call — and this module
 * only decides who tests, in what order, and what the two outcomes add up to.
 * `state.guidedTest` holds whichever subtest is open right now;
 * `state.groupTest` holds the sequencing. That is what gives each subtest its
 * own favor/disfavor, its own Resolve decision, its own push, and its own card
 * zones, with no forked copy of the individual flow to drift.
 *
 * Selection and the hit total are Increment 0.5's
 * `selectGroupTestActors`/`resolveGroupTest`. Neither the 2/1/0/-1 hit values
 * nor the outcome bands are restated here — the bands are content
 * (`resolution.groupOutcomes`), and forking the arithmetic is exactly what the
 * plan forbids.
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import { z } from 'zod';
import { SUIT_IDS, type SuitId } from '$lib/types/common';
import type { SessionEngineStateV1, SessionEvent, SessionRejection } from '$lib/types/session';
import type { OutcomeId } from '$lib/engine/tarot-resolution';
import { resolveGroupTest, selectGroupTestActors, type GroupTestCandidate, type GroupTestResult } from '$lib/engine/tarot-group-test';
import type { ReduceResult } from '../result';
import {
	completeGuidedTest,
	declareTestOfFate,
	readGuidedTest,
	type GuidedTestActorFacts,
	type GuidedTestReduceContext,
	type GuidedTestStateV1
} from './test-of-fate';

export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

/** The content pack's `group-test` procedure id. */
export const GROUP_TEST_PROCEDURE_ID = 'group-test';

/** Which subtest is open, or `complete` once both have been scored. Ch1 fixes
 * the order (most qualified first), so this doubles as the progress counter. */
export type GroupTestStage = 'most-qualified' | 'least-qualified' | 'complete';

/**
 * A finished subtest, flattened for the table log and the panel. Kept
 * alongside `outcomes` rather than derived from it because the outcome alone
 * cannot explain itself: the table needs to see that the least-qualified
 * adventurer tested with disfavor and declined a push, which is per-subtest
 * information the group's two-element outcome list has no room for.
 */
export interface GroupTestSubtestSummary {
	actorTenureId: string;
	favor: boolean;
	disfavor: boolean;
	resolveSpent: boolean;
	pushed: boolean;
	total: number;
	outcome: OutcomeId;
}

export interface GroupTestStateV1 {
	schemaVersion: 1;
	stage: GroupTestStage;
	testedSuit: SuitId;
	/** The eligible group the GM named. Retained so an override can be checked
	 * against it — the table may swap a tied adventurer in, never someone who
	 * was never in the group. */
	candidateTenureIds: string[];
	mostQualifiedTenureId: string;
	leastQualifiedTenureId: string;
	/** Ch1: "If there are apparent ties, talk it out to determine who should
	 * make the tests." True when either end was tied, so the UI can offer the
	 * override instead of presenting a stable default as a ruling. */
	requiresTableDecision: boolean;
	/** Scored subtests, in test order. Feeds `resolveGroupTest` once it holds
	 * two. */
	outcomes: OutcomeId[];
	subtestSummaries: GroupTestSubtestSummary[];
	result: GroupTestResult | null;
}

const outcomeIdSchema = z.enum(['great-success', 'success', 'failure', 'great-failure']);
const tenureIdSchema = z.string().trim().min(1).max(128);

const groupTestStateV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		stage: z.enum(['most-qualified', 'least-qualified', 'complete']),
		testedSuit: z.enum(SUIT_IDS),
		candidateTenureIds: z.array(tenureIdSchema).min(2),
		mostQualifiedTenureId: tenureIdSchema,
		leastQualifiedTenureId: tenureIdSchema,
		requiresTableDecision: z.boolean(),
		outcomes: z.array(outcomeIdSchema).max(2),
		subtestSummaries: z
			.array(
				z
					.object({
						actorTenureId: tenureIdSchema,
						favor: z.boolean(),
						disfavor: z.boolean(),
						resolveSpent: z.boolean(),
						pushed: z.boolean(),
						total: z.number().int(),
						outcome: outcomeIdSchema
					})
					.strict()
			)
			.max(2),
		result: z
			.object({
				hits: z.number().int(),
				outcome: z
					.object({
						id: z.string(),
						label: z.string(),
						from: z.number().int(),
						to: z.number().int(),
						description: z.string().optional()
					})
					.strict()
			})
			.strict()
			.nullable()
	})
	.strict();

function reject(code: SessionRejection['code'], message: string): SessionReduceResult {
	return { ok: false, rejection: { code, message } };
}

export function readGroupTest(state: SessionEngineStateV1): GroupTestStateV1 | undefined {
	if (state.groupTest === undefined || state.groupTest === null) return undefined;
	const result = groupTestStateV1Schema.safeParse(state.groupTest);
	return result.success ? (result.data as GroupTestStateV1) : undefined;
}

/** Mirrors `isGuidedTestCorrupt`: a corrupt wrapper must not read as "no group
 * test", which would let a declaration silently overwrite one in progress. */
export function isGroupTestCorrupt(state: SessionEngineStateV1): boolean {
	if (state.groupTest === undefined || state.groupTest === null) return false;
	return !groupTestStateV1Schema.safeParse(state.groupTest).success;
}

export function writeGroupTest(state: SessionEngineStateV1, group: GroupTestStateV1): SessionEngineStateV1 {
	return { ...state, groupTest: groupTestStateV1Schema.parse(group) };
}

function actorsFor(
	context: GuidedTestReduceContext,
	tenureIds: readonly string[]
): { ok: true; actors: GuidedTestActorFacts[] } | { ok: false; missing: string } {
	const actors: GuidedTestActorFacts[] = [];
	for (const tenureId of tenureIds) {
		const found = context.materials.actors.find((candidate) => candidate.tenureId === tenureId);
		if (!found) return { ok: false, missing: tenureId };
		actors.push(found);
	}
	return { ok: true, actors };
}

/** Ranks the named group by the TESTED attribute. The suit is chosen at declare
 * time, which is why `GuidedTestActorFacts` carries all four attributes rather
 * than one pre-selected number. */
function candidatesFor(actors: readonly GuidedTestActorFacts[], testedSuit: SuitId): GroupTestCandidate[] {
	return actors.map((facts) => ({
		id: facts.tenureId,
		attribute: facts.attributes[testedSuit],
		rosterOrder: facts.rosterOrder
	}));
}

/** Opens `tenureId`'s subtest by running the ordinary individual declaration —
 * the whole point of the two-slot design. */
function openSubtest(
	state: SessionEngineStateV1,
	tenureId: string,
	testedSuit: SuitId,
	context: GuidedTestReduceContext
): SessionReduceResult {
	return declareTestOfFate(state, { actorTenureId: tenureId, testedSuit }, context);
}

export interface DeclareGroupTestInput {
	testedSuit: SuitId;
	candidateTenureIds: string[];
}

/**
 * The GM names the eligible group and the tested suit; the engine proposes who
 * tests and immediately opens the most-qualified adventurer's subtest.
 *
 * A group test that has already RESOLVED may be replaced by a new declaration
 * (its wrapper is left in place only so the panel can display the result), but
 * one still in progress may not — nor may a group test start while an ad-hoc
 * individual test is open.
 */
export function declareGroupTest(
	state: SessionEngineStateV1,
	input: DeclareGroupTestInput,
	context: GuidedTestReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may call for a group test');
	if (isGroupTestCorrupt(state)) {
		return reject('illegal-command', 'the in-flight group test is corrupt and cannot be read — contact the GM');
	}

	const existing = readGroupTest(state);
	if (existing && existing.stage !== 'complete') return reject('illegal-command', 'a group test is already in progress');
	if (readGuidedTest(state)) return reject('illegal-command', 'a test of fate is already in flight');

	const distinct = new Set(input.candidateTenureIds);
	if (distinct.size < 2) return reject('illegal-command', 'a group test needs at least two distinct adventurers');

	const resolved = actorsFor(context, [...distinct]);
	if (!resolved.ok) return reject('illegal-command', `no adventurer at this table holds tenure ${resolved.missing}`);

	const selection = selectGroupTestActors(candidatesFor(resolved.actors, input.testedSuit));

	const group: GroupTestStateV1 = {
		schemaVersion: 1,
		stage: 'most-qualified',
		testedSuit: input.testedSuit,
		candidateTenureIds: [...distinct],
		mostQualifiedTenureId: selection.mostQualified.id,
		leastQualifiedTenureId: selection.leastQualified.id,
		requiresTableDecision: selection.requiresTableDecision,
		outcomes: [],
		subtestSummaries: [],
		result: null
	};

	// The wrapper is written BEFORE the subtest opens so `declareTestOfFate`'s
	// own "already in flight" guard sees a consistent world either way.
	const opened = openSubtest(writeGroupTest(state, group), selection.mostQualified.id, input.testedSuit, context);
	/* v8 ignore start -- `readGuidedTest` was just checked empty and the tenure
	 * was just resolved from materials, so this declaration cannot be refused;
	 * kept only to narrow away the rejection variant. */
	if (!opened.ok) return opened;
	/* v8 ignore stop */

	return {
		ok: true,
		state: opened.state,
		events: [
			{
				kind: 'group-test-declared',
				publicPayload: {
					procedureId: GROUP_TEST_PROCEDURE_ID,
					testedSuit: input.testedSuit,
					candidateTenureIds: group.candidateTenureIds,
					mostQualifiedTenureId: group.mostQualifiedTenureId,
					leastQualifiedTenureId: group.leastQualifiedTenureId,
					requiresTableDecision: group.requiresTableDecision
				}
			},
			...opened.events
		]
	};
}

export interface OverrideGroupTestActorsInput {
	mostQualifiedTenureId: string;
	leastQualifiedTenureId: string;
}

/**
 * Ch1: "If there are apparent ties, talk it out to determine who should make
 * the tests." `selectGroupTestActors` proposes a deterministic default and
 * flags the tie; this applies the table's decision instead.
 *
 * Legal only before the first subtest has drawn a card — after that, swapping
 * the actor would silently reassign a card someone else already pulled.
 */
export function overrideGroupTestActors(
	state: SessionEngineStateV1,
	input: OverrideGroupTestActorsInput,
	context: GuidedTestReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may record the table’s decision');
	const group = readGroupTest(state);
	if (!group) return reject('illegal-command', 'no group test is in progress');
	if (group.stage !== 'most-qualified' || group.outcomes.length > 0) {
		return reject('illegal-command', 'the group’s testers can only be changed before the first test draws');
	}

	const openTest = readGuidedTest(state);
	if (openTest?.initialCardZoneId !== null && openTest !== undefined) {
		return reject('illegal-command', 'the first test has already drawn — its tester can no longer be changed');
	}

	if (input.mostQualifiedTenureId === input.leastQualifiedTenureId) {
		return reject('illegal-command', 'a group test needs two distinct adventurers');
	}
	for (const tenureId of [input.mostQualifiedTenureId, input.leastQualifiedTenureId]) {
		if (!group.candidateTenureIds.includes(tenureId)) {
			return reject('illegal-command', `tenure ${tenureId} is not part of the declared group`);
		}
	}

	const next: GroupTestStateV1 = {
		...group,
		mostQualifiedTenureId: input.mostQualifiedTenureId,
		leastQualifiedTenureId: input.leastQualifiedTenureId
	};

	// Reopen the first subtest so the open test follows the override rather than
	// the superseded default. Safe because nothing has been drawn yet.
	const cleared = { ...state };
	delete cleared.guidedTest;
	const reopened = openSubtest(writeGroupTest(cleared, next), input.mostQualifiedTenureId, group.testedSuit, context);
	/* v8 ignore start -- the slot was just cleared and both tenures were just
	 * validated against the declared group, so this cannot be refused. */
	if (!reopened.ok) return reopened;
	/* v8 ignore stop */

	return {
		ok: true,
		state: reopened.state,
		events: [
			{
				kind: 'group-test-actors-overridden',
				publicPayload: {
					mostQualifiedTenureId: input.mostQualifiedTenureId,
					leastQualifiedTenureId: input.leastQualifiedTenureId
				}
			},
			...reopened.events
		]
	};
}

function summarize(test: GuidedTestStateV1): GroupTestSubtestSummary {
	const result = test.result!;
	return {
		actorTenureId: test.actorTenureId,
		favor: test.favor,
		disfavor: test.disfavor,
		resolveSpent: test.resolvePurchase !== null,
		pushed: result.pushed,
		total: result.total,
		outcome: result.outcome
	};
}

/**
 * Scores the resolved subtest and moves on: after the first, opens the
 * least-qualified adventurer's; after the second, totals the hits through
 * `resolveGroupTest` and publishes the band.
 *
 * Finalization of each subtest goes through `completeGuidedTest`, so a Fool
 * drawn in either one reshuffles at its own `test-resolution` boundary and both
 * cards reach the discard before the next subtest draws — behavior identical to
 * a standalone test, because it IS the same code path.
 */
export function advanceGroupTest(state: SessionEngineStateV1, context: GuidedTestReduceContext): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may advance a group test');
	const group = readGroupTest(state);
	if (!group) return reject('illegal-command', 'no group test is in progress');
	if (group.stage === 'complete') return reject('illegal-command', 'this group test has already been scored');

	const test = readGuidedTest(state);
	if (!test) return reject('illegal-command', 'no subtest is open');
	if (test.stage !== 'complete') return reject('illegal-command', `the open subtest is still at stage ${test.stage}`);

	const finalized = completeGuidedTest(state, context);
	/* v8 ignore start -- the open test was just confirmed complete and the actor
	 * is the GM, the only two things `completeGuidedTest` refuses on. */
	if (!finalized.ok) return finalized;
	/* v8 ignore stop */

	const outcomes = [...group.outcomes, test.result!.outcome];
	const subtestSummaries = [...group.subtestSummaries, summarize(test)];

	if (group.stage === 'most-qualified') {
		const next: GroupTestStateV1 = { ...group, stage: 'least-qualified', outcomes, subtestSummaries };
		const opened = openSubtest(
			writeGroupTest(finalized.state, next),
			group.leastQualifiedTenureId,
			group.testedSuit,
			context
		);
		/* v8 ignore start -- `completeGuidedTest` cleared the slot and the tenure
		 * came from a validated declaration, so this cannot be refused. */
		if (!opened.ok) return opened;
		/* v8 ignore stop */
		return { ok: true, state: opened.state, events: [...finalized.events, ...opened.events] };
	}

	// Second subtest done — total the hits. `resolveGroupTest` owns both the
	// 2/1/0/-1 hit values and the content-driven band lookup.
	const result = resolveGroupTest(context.config, outcomes);
	const next: GroupTestStateV1 = { ...group, stage: 'complete', outcomes, subtestSummaries, result };

	return {
		ok: true,
		state: writeGroupTest(finalized.state, next),
		events: [
			...finalized.events,
			{
				kind: 'group-test-resolved',
				publicPayload: {
					testedSuit: group.testedSuit,
					mostQualifiedTenureId: group.mostQualifiedTenureId,
					leastQualifiedTenureId: group.leastQualifiedTenureId,
					outcomes,
					subtests: subtestSummaries,
					hits: result.hits,
					outcomeId: result.outcome.id,
					outcomeLabel: result.outcome.label
				}
			}
		]
	};
}
