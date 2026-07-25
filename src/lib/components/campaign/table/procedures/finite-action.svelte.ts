/**
 * The finite-runner action runner (Increment 4 Task 4) — one command id per
 * user intent, disabled while in flight, id reused only on a retry of the SAME
 * intent (keyed by canonical payload; the same intent-scoping fix the
 * Challenge runner needed). No reconfirmation: nothing on this surface spends.
 */
import type { FiniteCommandInput } from '$lib/schemas/finite-command.schema';
import { COMMAND_ERROR_MESSAGE, type SendCommandResult } from '$lib/stores/campaign-session.svelte';

export interface FiniteActionRunner {
	readonly pending: boolean;
	readonly error: string | null;
	run: (command: FiniteCommandInput) => Promise<void>;
}

export function createFiniteAction(
	send: (command: FiniteCommandInput, commandId?: string) => Promise<SendCommandResult>
): FiniteActionRunner {
	let pending = $state(false);
	let error = $state<string | null>(null);
	let lastCommandId: string | null = null;
	let lastIntentKey: string | null = null;

	async function run(command: FiniteCommandInput): Promise<void> {
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
	return `finite-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
