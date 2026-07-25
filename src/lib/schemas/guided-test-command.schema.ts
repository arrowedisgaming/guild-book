import { z } from 'zod';
import { SUIT_IDS } from '$lib/types/common';

/**
 * Zod validation for the guided test-of-fate command surface (Increment 4
 * Task 2) — `$lib/engine/session/procedures/test-of-fate.ts`'s transitions.
 * Mirrors `challenge-command.schema.ts`'s discipline exactly: every variant is
 * `.strict()`, and the envelope reuses the SAME generic `{commandId,
 * observedSessionVersion, command}` shape as `SessionCommandEnvelope<C>`. This
 * is a NEW, parallel command surface, never a change to the frozen
 * `sessionCommandEnvelopeSchema`/`SessionCommand` union.
 *
 * ## What `.strict()` is load-bearing for here
 *
 * The tested attribute's value and the actor's current Resolve are read
 * SERVER-side into `GuidedTestMaterials`. Every command below is therefore
 * deliberately narrow — `declare-test-of-fate` names a tenure and a suit, and
 * nothing carries a number the engine will do arithmetic with. `.strict()` is
 * what turns "the client should not send an attribute" into "the client
 * cannot": an `attribute`/`resolveCurrent`/`total` key is a hard parse
 * failure, not a silently-ignored extra field, so the engine is structurally
 * guaranteed to be testing against the sheet rather than a client's claim.
 */

const tenureId = z.string().trim().min(1).max(128);
const suitId = z.enum(SUIT_IDS);

const declareTestOfFateCommandSchema = z
	.object({ type: z.literal('declare-test-of-fate'), actorTenureId: tenureId, testedSuit: suitId })
	.strict();

/** GM-adjudicated circumstantial favor (aid, a relevant motif, fictional
 * positioning). Both `true` is legal and cancels — `resolveTestOfFate` owns
 * that arithmetic, so the schema does not forbid the combination. */
const setTestFavorCommandSchema = z
	.object({ type: z.literal('set-test-favor'), favor: z.boolean(), disfavor: z.boolean() })
	.strict();

/** No payload at all: the spend is always exactly 1 Resolve (Ch1) from the
 * acting player's own character, both of which the server already knows. */
const purchaseTestFavorCommandSchema = z.object({ type: z.literal('purchase-test-favor') }).strict();

const drawTestCardCommandSchema = z.object({ type: z.literal('draw-test-card') }).strict();
const pushTestFateCommandSchema = z.object({ type: z.literal('push-test-fate') }).strict();
const declineTestPushCommandSchema = z.object({ type: z.literal('decline-test-push') }).strict();
const completeGuidedTestCommandSchema = z.object({ type: z.literal('complete-guided-test') }).strict();

/** The GM names the eligible group; the engine picks the most- and
 * least-qualified from server-read attributes (`selectGroupTestActors`), so no
 * ranking or attribute travels with the command. */
const declareGroupTestCommandSchema = z
	.object({
		type: z.literal('declare-group-test'),
		testedSuit: suitId,
		candidateTenureIds: z.array(tenureId).min(2).max(20)
	})
	.strict();

/** Scores the resolved subtest and either opens the second one or totals the
 * hits. No payload: which subtest is open and what it scored are both already
 * in `state.groupTest`/`state.guidedTest`. */
const advanceGroupTestCommandSchema = z.object({ type: z.literal('advance-group-test') }).strict();

/** Ch1: "If there are apparent ties, talk it out to determine who should make
 * the tests." When `selectGroupTestActors` reports a tie, the GM may override
 * the stable default with the table's decision. */
const overrideGroupTestActorsCommandSchema = z
	.object({
		type: z.literal('override-group-test-actors'),
		mostQualifiedTenureId: tenureId,
		leastQualifiedTenureId: tenureId
	})
	.strict();

export const guidedTestCommandSchema = z.discriminatedUnion('type', [
	declareTestOfFateCommandSchema,
	setTestFavorCommandSchema,
	purchaseTestFavorCommandSchema,
	drawTestCardCommandSchema,
	pushTestFateCommandSchema,
	declineTestPushCommandSchema,
	completeGuidedTestCommandSchema,
	declareGroupTestCommandSchema,
	advanceGroupTestCommandSchema,
	overrideGroupTestActorsCommandSchema
]);

export type GuidedTestCommandInput = z.infer<typeof guidedTestCommandSchema>;

/**
 * The envelope. Unlike `challengeCommandEnvelopeSchema`, this one DOES carry
 * Task 1's two reconfirmation numbers: `purchase-test-favor` is the one guided
 * test command that causes a character write, and Ch1 makes it a pre-draw
 * purchase, so the player must be able to agree to a specific Resolve value.
 * The pair is required together for exactly the reason
 * `sessionCommandEnvelopeSchema` documents — `observedCharacterVersion` alone
 * cannot detect a Resolve change, and `expectedResolveCurrent` alone gives the
 * server no version to write against.
 */
export const guidedTestCommandEnvelopeSchema = z
	.object({
		commandId: z.string().trim().min(1).max(128),
		observedSessionVersion: z.number().int().nonnegative(),
		observedCharacterVersion: z.number().int().nonnegative().optional(),
		expectedResolveCurrent: z.number().int().nonnegative().max(99).optional(),
		command: guidedTestCommandSchema
	})
	.strict()
	.refine((envelope) => (envelope.observedCharacterVersion === undefined) === (envelope.expectedResolveCurrent === undefined), {
		message: 'observedCharacterVersion and expectedResolveCurrent must be sent together on a resource-spend command',
		path: ['expectedResolveCurrent']
	});
