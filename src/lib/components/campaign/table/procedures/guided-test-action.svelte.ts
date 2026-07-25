/**
 * The one place every guided-test component submits a command from (Increment 4
 * Task 2) — the same discipline as `challenge/challenge-action.svelte.ts`: send
 * one command id per user intent, disable it while in flight, and reuse that id
 * on a genuine retry of the SAME intent.
 *
 * The retained id is scoped to a `lastIntentKey` (the canonical stringification
 * of the command AND its reconfirmation numbers), not just "the last failure".
 * A single runner is shared by every control in the panel, so an id retained
 * across DIFFERENT intents would be reused by the next control clicked, the
 * server would find a persisted row with a different `requestHash`, and return
 * `command-id-reused` — bricking the panel until reload. That exact defect was
 * found and fixed in the Challenge runner; this one is built with the fix.
 *
 * Why the reconfirmation numbers are part of the key: a purchase refused because
 * Resolve moved is followed by the player reconfirming against the NEW value.
 * That is a different request, not a retry of the refused one, so it must mint a
 * fresh command id — otherwise the server replays nothing (the refusal is
 * deliberately not persisted) but the client would be reusing an id tied to
 * different numbers.
 */
import type { GuidedTestCommand } from '$lib/engine/session/procedures/guided-test-command';
import { COMMAND_ERROR_MESSAGE, type ResolveReconfirmation, type SendCommandResult } from '$lib/stores/campaign-session.svelte';

export interface GuidedTestActionRunner {
	readonly pending: boolean;
	readonly error: string | null;
	run: (command: GuidedTestCommand, reconfirmation?: ResolveReconfirmation) => Promise<void>;
}

export function createGuidedTestAction(
	send: (command: GuidedTestCommand, commandId?: string, reconfirmation?: ResolveReconfirmation) => Promise<SendCommandResult>
): GuidedTestActionRunner {
	let pending = $state(false);
	let error = $state<string | null>(null);
	let lastCommandId: string | null = null;
	let lastIntentKey: string | null = null;

	async function run(command: GuidedTestCommand, reconfirmation?: ResolveReconfirmation): Promise<void> {
		if (pending) return;
		pending = true;
		const key = intentKey(command, reconfirmation);
		const commandId = lastIntentKey === key && lastCommandId ? lastCommandId : randomId();
		lastCommandId = commandId;
		lastIntentKey = key;
		const result = await send(command, commandId, reconfirmation);
		pending = false;
		if (result.ok) {
			error = null;
			lastCommandId = null;
			lastIntentKey = null;
		} else {
			error = result.message ?? COMMAND_ERROR_MESSAGE;
			// Deliberately NOT cleared: a retry of this SAME intent reuses
			// `commandId`. Any different intent mints its own id above.
		}
	}

	return {
		get pending() {
			return pending;
		},
		get error() {
			return error;
		},
		run
	};
}

function randomId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	return `guided-test-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Every field on a `GuidedTestCommand` and a `ResolveReconfirmation` is a
 * primitive, so plain `JSON.stringify` is already stable across calls built from
 * the same object-literal shape — no deep key-sorting needed. */
function intentKey(command: GuidedTestCommand, reconfirmation?: ResolveReconfirmation): string {
	return `${JSON.stringify(command)}|${JSON.stringify(reconfirmation ?? null)}`;
}
