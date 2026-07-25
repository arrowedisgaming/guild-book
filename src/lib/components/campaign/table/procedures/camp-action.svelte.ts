/**
 * The one place every Camp control submits a command from (Increment 4 Task 3) —
 * identical discipline to `guided-test-action.svelte.ts`: one command id per user
 * intent, disabled while in flight, and that id reused on a genuine retry of the
 * SAME intent.
 *
 * The retained id is scoped to the canonical stringification of the command, not
 * merely "the last failure". One runner is shared by every control in the panel,
 * so an id retained across DIFFERENT intents would be reused by the next control
 * clicked, the server would find a persisted row with a different `requestHash`,
 * and return `command-id-reused` — bricking the panel until reload. That defect
 * was found in the Challenge runner; this one is built with the fix.
 *
 * No reconfirmation parameter: no Camp command spends a character resource.
 */
import type { CampProcedureCommand } from '$lib/engine/session/procedures/camp-command';
import { COMMAND_ERROR_MESSAGE, type SendCommandResult } from '$lib/stores/campaign-session.svelte';

export interface CampActionRunner {
	readonly pending: boolean;
	readonly error: string | null;
	run: (command: CampProcedureCommand) => Promise<void>;
}

export function createCampAction(
	send: (command: CampProcedureCommand, commandId?: string) => Promise<SendCommandResult>
): CampActionRunner {
	let pending = $state(false);
	let error = $state<string | null>(null);
	let lastCommandId: string | null = null;
	let lastIntentKey: string | null = null;

	async function run(command: CampProcedureCommand): Promise<void> {
		if (pending) return;
		pending = true;
		const key = JSON.stringify(command);
		const commandId = lastIntentKey === key && lastCommandId ? lastCommandId : randomId();
		lastCommandId = commandId;
		lastIntentKey = key;
		const result = await send(command, commandId);
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
	return `camp-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
