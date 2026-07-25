/**
 * The guided test's OWN actor-scoped projection and legal-command derivation
 * (Increment 4 Task 2 Step 4). A parallel, additive slice alongside the generic
 * `SessionPlayerProjection`/`SessionGmProjection` (`../projection.ts`) — this
 * module changes NOTHING about those types, exactly like
 * `procedures/challenge/projection.ts`.
 *
 * `state.guidedTest`/`state.groupTest` are `unknown` to the generic engine by
 * design, so nothing about a test reaches any actor without a projector of its
 * own. This is that projector.
 *
 * Same allowlist-copy discipline as `../projection.ts`: builds a brand-new
 * object and copies only approved fields, never clones-then-deletes.
 *
 * ## The one thing scoped per actor
 *
 * `resolveCurrent` is the acting adventurer's own sheet value. It is reported
 * ONLY to the player who owns the tested tenure — a spectator learning what
 * another player can afford is a sheet leak through a session channel, and the
 * GM does not need it to adjudicate (they settle favor, not the purchase).
 * Everything else about a test of fate is public by rule: `test-of-fate`'s
 * steps are `visibility: 'public'`/`resultVisibility: 'public'` in the content
 * pack, and Ch1's group test announces its two chosen adventurers to the table
 * before either draws.
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { SuitId } from '$lib/types/common';
import type { CardSlot, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';
import type { OutcomeId, TestOfFateResult } from '$lib/engine/tarot-resolution';
import type { GroupTestResult } from '$lib/engine/tarot-group-test';
import { hydrateVisible } from '../projection';
import { findZoneDescriptor } from '../state';
import {
	guidedTestZoneId,
	readGuidedTest,
	type GuidedTestActorFacts,
	type GuidedTestMaterials,
	type GuidedTestStage,
	type GuidedTestStateV1
} from './test-of-fate';
import { readGroupTest, type GroupTestStage, type GroupTestSubtestSummary } from './group-test';

/** Every guided-test command a panel can render a control for — the union of
 * the individual and group surfaces validated by
 * `$lib/schemas/guided-test-command.schema.ts`. */
export type GuidedTestControl =
	| 'declare-test-of-fate'
	| 'set-test-favor'
	| 'purchase-test-favor'
	| 'draw-test-card'
	| 'push-test-fate'
	| 'decline-test-push'
	| 'complete-guided-test'
	| 'declare-group-test'
	| 'override-group-test-actors'
	| 'advance-group-test';

export interface GuidedTestView {
	stage: GuidedTestStage;
	actorTenureId: string;
	testedSuit: SuitId;
	favor: boolean;
	disfavor: boolean;
	/** True when the viewing actor owns the tested tenure — what the panel keys
	 * "your test" affordances off, rather than comparing ids itself. */
	isMine: boolean;
	resolveSpent: boolean;
	/** The acting adventurer's current Resolve, or `null` for every other
	 * viewer. See the module header. */
	resolveCurrent: number | null;
	/** Whether the acting adventurer can afford the 1-Resolve favor purchase.
	 * Reported (not just implied by `controls`) so the panel can say *why* the
	 * button is absent instead of silently omitting it. `null` for viewers who
	 * are not the tester. */
	resolveAffordable: boolean | null;
	/** The other half of Task 1's reconfirmation pair, for the tester only —
	 * their `purchase-test-favor` envelope must send this alongside
	 * `expectedResolveCurrent`, both read at the same moment. `null` for every
	 * other viewer. */
	characterVersion: number | null;
	initialCard: CardSlot | null;
	pushCard: CardSlot | null;
	result: TestOfFateResult | null;
}

export interface GroupTestView {
	stage: GroupTestStage;
	testedSuit: SuitId;
	candidateTenureIds: string[];
	mostQualifiedTenureId: string;
	leastQualifiedTenureId: string;
	requiresTableDecision: boolean;
	outcomes: OutcomeId[];
	subtestSummaries: GroupTestSubtestSummary[];
	result: GroupTestResult | null;
}

export interface GuidedTestProjection {
	test: GuidedTestView | null;
	group: GroupTestView | null;
	controls: GuidedTestControl[];
}

function factsFor(materials: GuidedTestMaterials, tenureId: string): GuidedTestActorFacts | undefined {
	return materials.actors.find((actor) => actor.tenureId === tenureId);
}

/** Whether `actor` is the player who owns the tested tenure. Resolved through
 * `materials` — a tenure id is never compared against a user id directly. */
function ownsTest(actor: SessionActor, materials: GuidedTestMaterials, tenureId: string): boolean {
	const facts = factsFor(materials, tenureId);
	return facts !== undefined && actor.kind === 'player' && actor.userId === facts.userId;
}

function cardIn(state: SessionEngineStateV1, zoneId: string | null, catalog: TarotCardCatalog): CardSlot | null {
	if (!zoneId) return null;
	const cardId = findZoneDescriptor(state, zoneId)?.cards[0];
	return cardId === undefined ? null : hydrateVisible(cardId, catalog);
}

function buildTestView(
	state: SessionEngineStateV1,
	test: GuidedTestStateV1,
	actor: SessionActor,
	catalog: TarotCardCatalog,
	materials: GuidedTestMaterials
): GuidedTestView {
	const isMine = ownsTest(actor, materials, test.actorTenureId);
	const facts = factsFor(materials, test.actorTenureId);
	return {
		stage: test.stage,
		actorTenureId: test.actorTenureId,
		testedSuit: test.testedSuit,
		favor: test.favor,
		disfavor: test.disfavor,
		isMine,
		resolveSpent: test.resolvePurchase !== null,
		resolveCurrent: isMine ? (facts?.resolveCurrent ?? null) : null,
		resolveAffordable: isMine ? (facts?.resolveCurrent ?? 0) >= 1 : null,
		characterVersion: isMine ? (facts?.characterVersion ?? null) : null,
		initialCard: cardIn(state, test.initialCardZoneId ?? guidedTestZoneId(test.actorTenureId, 'initial'), catalog),
		pushCard: cardIn(state, test.pushCardZoneId, catalog),
		result: test.result
	};
}

/**
 * The command types `actor` may attempt right now. Coarse and role+stage based,
 * exactly like `legalChallengeCommands`: it never promises a specific instance
 * would be accepted, only that offering the control is not guaranteed to fail.
 *
 * The Resolve purchase is deliberately withheld from an actor who cannot afford
 * it — the "don't offer a button guaranteed to fail" rule — while
 * `GuidedTestView.resolveAffordable` still carries the reason.
 */
export function legalGuidedTestCommands(
	state: SessionEngineStateV1,
	actor: SessionActor,
	materials: GuidedTestMaterials
): GuidedTestControl[] {
	const test = readGuidedTest(state);
	const group = readGroupTest(state);

	if (!test) {
		// Nothing open. Only the GM starts a test, and only when no group test is
		// mid-flight waiting on its next subtest.
		if (actor.kind !== 'gm') return [];
		if (group && group.stage !== 'complete') return [];
		return ['declare-test-of-fate', 'declare-group-test'];
	}

	const inGroup = group !== undefined && group.stage !== 'complete';
	const isMine = ownsTest(actor, materials, test.actorTenureId);
	const facts = factsFor(materials, test.actorTenureId);

	if (actor.kind === 'gm') {
		if (test.stage === 'favor') {
			// A group whose selection was a tie can still be re-cast, but only
			// before the first card is drawn — the same window
			// `overrideGroupTestActors` itself enforces.
			const override: GuidedTestControl[] =
				inGroup && group.requiresTableDecision && group.stage === 'most-qualified' && group.outcomes.length === 0
					? ['override-group-test-actors']
					: [];
			return ['set-test-favor', ...override];
		}
		if (test.stage === 'complete') return inGroup ? ['advance-group-test'] : ['complete-guided-test'];
		return [];
	}

	if (!isMine) return [];

	if (test.stage === 'initial-draw') {
		const controls: GuidedTestControl[] = ['draw-test-card'];
		if (test.resolvePurchase === null && (facts?.resolveCurrent ?? 0) >= 1) controls.push('purchase-test-favor');
		return controls;
	}
	if (test.stage === 'push-offer') return ['push-test-fate', 'decline-test-push'];
	return [];
}

/** Builds the guided-test slice `actor` is authorized to see, plus the controls
 * they may currently attempt. */
export function projectGuidedTestForActor(
	state: SessionEngineStateV1,
	actor: SessionActor,
	catalog: TarotCardCatalog,
	materials: GuidedTestMaterials
): GuidedTestProjection {
	const test = readGuidedTest(state);
	const group = readGroupTest(state);

	return {
		test: test ? buildTestView(state, test, actor, catalog, materials) : null,
		group: group
			? {
					stage: group.stage,
					testedSuit: group.testedSuit,
					candidateTenureIds: group.candidateTenureIds,
					mostQualifiedTenureId: group.mostQualifiedTenureId,
					leastQualifiedTenureId: group.leastQualifiedTenureId,
					requiresTableDecision: group.requiresTableDecision,
					outcomes: group.outcomes,
					subtestSummaries: group.subtestSummaries,
					result: group.result
				}
			: null,
		controls: legalGuidedTestCommands(state, actor, materials)
	};
}
