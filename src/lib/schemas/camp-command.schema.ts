import { z } from 'zod';

/**
 * Zod validation for the Camp command surface (Increment 4 Task 3) —
 * `$lib/engine/session/procedures/camp-command.ts`'s `CampProcedureCommand`.
 * Mirrors the guided-test and Challenge schemas' discipline exactly: every
 * variant is `.strict()`, and the envelope reuses the same generic `{commandId,
 * observedSessionVersion, command}` shape as `SessionCommandEnvelope<C>`. A NEW,
 * parallel surface, never a change to the frozen `SessionCommand` union.
 *
 * ## What `.strict()` is load-bearing for here
 *
 * The performer's Cups — and therefore how many inspiration cards the High Chant
 * yields — is read SERVER-side from the sheet. No command below carries an
 * attribute, a count, or an allowance, so `.strict()` turns "the client should
 * not send its own Cups" into "the client cannot": an extra key is a hard parse
 * failure, not a silently-ignored field.
 *
 * Likewise nothing here carries an affliction, a charge count, or any other sheet
 * value. Leeches reports its outcome; the table applies it.
 */

const tenureId = z.string().trim().min(1).max(128);
const cardId = z.string().trim().min(1).max(128);

/** No payload: the performer is the acting player, and the allowance is their
 * Cups times the pack's multiplier — both server-known. */
const beginHighChantCommandSchema = z.object({ type: z.literal('begin-high-chant') }).strict();

/** The cards pulled from the minor discard. Bounded at 14 — the highest an
 * attribute could plausibly reach times the pack's per-Cups multiplier is far
 * below that, and the engine independently enforces the real allowance, so this
 * is only a payload-size guard, never the rule. */
const selectInspirationCommandSchema = z
	.object({ type: z.literal('select-inspiration'), cardIds: z.array(cardId).min(1).max(14) })
	.strict();

/** One card to one recipient. The recipient may be the performer's own tenure —
 * Ch5: "you may keep one for yourself." */
const completeHighChantTransferCommandSchema = z
	.object({ type: z.literal('complete-high-chant-transfer'), cardId, recipientTenureId: tenureId })
	.strict();

const beginLeechesCommandSchema = z.object({ type: z.literal('begin-leeches'), targetTenureId: tenureId }).strict();
const advanceLeechesCommandSchema = z.object({ type: z.literal('advance-leeches') }).strict();
const completeCampProcedureCommandSchema = z.object({ type: z.literal('complete-camp-procedure') }).strict();

export const campCommandSchema = z.discriminatedUnion('type', [
	beginHighChantCommandSchema,
	selectInspirationCommandSchema,
	completeHighChantTransferCommandSchema,
	beginLeechesCommandSchema,
	advanceLeechesCommandSchema,
	completeCampProcedureCommandSchema
]);

export type CampCommandInput = z.infer<typeof campCommandSchema>;

/**
 * The envelope. Deliberately carries NO reconfirmation pair: no Camp procedure
 * spends a character resource, so the shared loop refuses any envelope that
 * tries to (`spendsResolve` is omitted from the Camp adapter). Leeches' cured
 * affliction is reported, never applied.
 */
export const campCommandEnvelopeSchema = z
	.object({
		commandId: z.string().trim().min(1).max(128),
		observedSessionVersion: z.number().int().nonnegative(),
		command: campCommandSchema
	})
	.strict();
