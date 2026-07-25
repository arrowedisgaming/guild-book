/**
 * Increment 4 Task 2 Step 1 — the two contracts around the guided test that
 * the stage-machine tests cannot see:
 *
 * 1. The strict command schema. The tested attribute and the actor's Resolve
 *    are SERVER-read facts (`GuidedTestMaterials`); a command that tries to
 *    carry either must be rejected before it reaches the engine, or a client
 *    could test against any number it liked.
 * 2. The persistence round trip. `state.guidedTest` is a new field on the
 *    engine state, and `splitEngineState`'s fragments are `.strict()` — an
 *    unwired field is silently DROPPED rather than erroring, so a test of fate
 *    mid-flight would vanish on the next command's reload.
 */

import { describe, expect, it } from 'vitest';
import { guidedTestCommandEnvelopeSchema, guidedTestCommandSchema } from '$lib/schemas/guided-test-command.schema';
import { reassembleEngineState, splitEngineState } from '$lib/server/session/repository';
import { readGuidedTest, writeGuidedTest, type GuidedTestStateV1 } from '$lib/engine/session/procedures/test-of-fate';
import { readGroupTest, writeGroupTest, type GroupTestStateV1 } from '$lib/engine/session/procedures/group-test';
import { makeSessionFixture } from '../../../fixtures/session';

const IN_FLIGHT: GuidedTestStateV1 = {
	schemaVersion: 1,
	stage: 'push-offer',
	actorTenureId: 'tenure-1',
	testedSuit: 'swords',
	favor: true,
	disfavor: false,
	resolvePurchase: { characterId: 'char-alice', spent: 1 },
	initialCardZoneId: 'test-of-fate:tenure-1:initial',
	pushCardZoneId: null,
	result: {
		total: 8,
		modifier: 3,
		favorSources: ['circumstance', 'resolve'],
		outcome: 'failure',
		outcomeLabel: 'Failure',
		initialDrawMatchedTestedSuit: false,
		pushed: false,
		canPush: true,
		automaticGreatFailure: false,
		foolDrawn: false
	},
	reshuffleBefore: { major: false, player: false }
};

const IN_FLIGHT_GROUP: GroupTestStateV1 = {
	schemaVersion: 1,
	stage: 'least-qualified',
	testedSuit: 'swords',
	candidateTenureIds: ['tenure-1', 'tenure-2', 'tenure-3'],
	mostQualifiedTenureId: 'tenure-1',
	leastQualifiedTenureId: 'tenure-2',
	requiresTableDecision: false,
	outcomes: ['great-success'],
	subtestSummaries: [
		{
			actorTenureId: 'tenure-1',
			favor: false,
			disfavor: false,
			resolveSpent: false,
			pushed: false,
			total: 14,
			outcome: 'great-success'
		}
	],
	result: null
};

describe('guided test command schema', () => {
	it('accepts a bare declaration naming only the tenure and suit', () => {
		const parsed = guidedTestCommandSchema.safeParse({
			type: 'declare-test-of-fate',
			actorTenureId: 'tenure-1',
			testedSuit: 'swords'
		});

		expect(parsed.success).toBe(true);
	});

	it('rejects a client-supplied attribute value', () => {
		const parsed = guidedTestCommandSchema.safeParse({
			type: 'declare-test-of-fate',
			actorTenureId: 'tenure-1',
			testedSuit: 'swords',
			attribute: 99
		});

		expect(parsed.success).toBe(false);
	});

	it('rejects a client-supplied Resolve value on the purchase command', () => {
		const parsed = guidedTestCommandSchema.safeParse({ type: 'purchase-test-favor', resolveCurrent: 99 });

		expect(parsed.success).toBe(false);
	});

	it('rejects an unknown suit', () => {
		const parsed = guidedTestCommandSchema.safeParse({
			type: 'declare-test-of-fate',
			actorTenureId: 'tenure-1',
			testedSuit: 'coins'
		});

		expect(parsed.success).toBe(false);
	});

	it('reuses the generic envelope shape rather than the frozen session envelope', () => {
		const parsed = guidedTestCommandEnvelopeSchema.safeParse({
			commandId: 'cmd-1',
			observedSessionVersion: 7,
			command: { type: 'draw-test-card' }
		});

		expect(parsed.success).toBe(true);
	});

	it('carries the two Resolve reconfirmation numbers together or not at all', () => {
		const onlyOne = guidedTestCommandEnvelopeSchema.safeParse({
			commandId: 'cmd-1',
			observedSessionVersion: 7,
			expectedResolveCurrent: 3,
			command: { type: 'purchase-test-favor' }
		});
		const both = guidedTestCommandEnvelopeSchema.safeParse({
			commandId: 'cmd-1',
			observedSessionVersion: 7,
			observedCharacterVersion: 4,
			expectedResolveCurrent: 3,
			command: { type: 'purchase-test-favor' }
		});

		expect(onlyOne.success).toBe(false);
		expect(both.success).toBe(true);
	});
});

describe('guided test persistence', () => {
	it('survives a split/reassemble round trip', () => {
		const state = writeGuidedTest(makeSessionFixture(), IN_FLIGHT);

		const { publicFragment, serverFragment, privateFragmentsByRecipient } = splitEngineState(
			state,
			'seed-hex',
			'gm-1',
			['gm-1', 'user-alice']
		);
		const reloaded = reassembleEngineState({
			sessionId: state.sessionId,
			version: state.version,
			phase: state.phase,
			publicFragment,
			serverFragment,
			privateFragmentsByRecipient,
			gmUserId: 'gm-1'
		});

		expect(readGuidedTest(reloaded)).toEqual(IN_FLIGHT);
	});

	it('rides the public fragment — a test of fate holds no secrets', () => {
		const state = writeGuidedTest(makeSessionFixture(), IN_FLIGHT);

		const { publicFragment } = splitEngineState(state, 'seed-hex', 'gm-1', ['gm-1']);

		expect(publicFragment.guidedTest).toEqual(IN_FLIGHT);
	});

	it('carries the group test wrapper through the same round trip', () => {
		const state = writeGroupTest(makeSessionFixture(), IN_FLIGHT_GROUP);

		const { publicFragment, serverFragment, privateFragmentsByRecipient } = splitEngineState(state, 'seed-hex', 'gm-1', ['gm-1']);
		const reloaded = reassembleEngineState({
			sessionId: state.sessionId,
			version: state.version,
			phase: state.phase,
			publicFragment,
			serverFragment,
			privateFragmentsByRecipient,
			gmUserId: 'gm-1'
		});

		expect(readGroupTest(reloaded)).toEqual(IN_FLIGHT_GROUP);
	});

	it('reassembles a session that never had a test of fate with no slot at all', () => {
		const state = makeSessionFixture();

		const { publicFragment, serverFragment, privateFragmentsByRecipient } = splitEngineState(state, 'seed-hex', 'gm-1', ['gm-1']);
		const reloaded = reassembleEngineState({
			sessionId: state.sessionId,
			version: state.version,
			phase: state.phase,
			publicFragment,
			serverFragment,
			privateFragmentsByRecipient,
			gmUserId: 'gm-1'
		});

		expect(readGuidedTest(reloaded)).toBeUndefined();
	});
});
