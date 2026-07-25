import { z } from 'zod';

/**
 * Zod validation for the finite-runner command surface (Increment 4 Task 4).
 * Same discipline as every other parallel surface: `.strict()` variants, the
 * generic envelope shape, never a change to the frozen `SessionCommand` union.
 * No command carries a lookup result, a table row, or an attribute — outcomes
 * are resolved server-side from the pinned content, and `.strict()` makes a
 * client-supplied outcome a parse failure rather than an ignored field.
 */

const id = z.string().trim().min(1).max(128);

const beginSchema = z
	.object({
		type: z.literal('begin-finite-procedure'),
		procedureId: id,
		actorTenureId: id.optional(),
		mode: z.enum(['appropriate-realm', 'random-realm']).optional(),
		realmTableId: id.optional()
	})
	.strict();

const advanceSchema = z
	.object({
		type: z.literal('advance-finite-procedure'),
		stepId: id.optional(),
		confirm: z.enum(['yes', 'no']).optional(),
		chosenCardId: id.optional(),
		orderedCardIds: z.array(id).min(1).max(10).optional()
	})
	.strict();

const completeSchema = z.object({ type: z.literal('complete-finite-procedure') }).strict();

export const finiteCommandSchema = z.discriminatedUnion('type', [beginSchema, advanceSchema, completeSchema]);
export type FiniteCommandInput = z.infer<typeof finiteCommandSchema>;

/** No reconfirmation pair: no runner procedure spends a character resource —
 * Area Sense's Resolve cost is reported for the sheet, never written. */
export const finiteCommandEnvelopeSchema = z
	.object({ commandId: id, observedSessionVersion: z.number().int().nonnegative(), command: finiteCommandSchema })
	.strict();
