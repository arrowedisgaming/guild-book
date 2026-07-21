/**
 * The one place every Challenge component submits a command from (Increment
 * 3 Task 6, O1): "send one UUID command id per user intent, disable it while
 * in flight, and reuse that id on retry." `ChallengePanel` owns a SINGLE
 * runner shared by every child control — only one Challenge command can be
 * in flight across the whole guided panel at a time, which keeps "disable
 * while in flight" trivially correct (every button in the panel disables
 * together) rather than needing per-button in-flight bookkeeping for a UI
 * that is inherently one-step-at-a-time anyway.
 *
 * A failed attempt keeps its `commandId` so the NEXT call to `run` (a user
 * clicking the same control again) reuses it — a genuine retry, not a fresh
 * command. A successful attempt clears it, so the next DIFFERENT action
 * mints its own fresh id.
 */
import type { ChallengeCommand } from '$lib/engine/session/procedures/challenge/command';
import { COMMAND_ERROR_MESSAGE, type SendCommandResult } from '$lib/stores/campaign-session.svelte';

export interface ChallengeActionRunner {
	readonly pending: boolean;
	readonly error: string | null;
	run: (command: ChallengeCommand) => Promise<void>;
}

export function createChallengeAction(send: (command: ChallengeCommand, commandId?: string) => Promise<SendCommandResult>): ChallengeActionRunner {
	let pending = $state(false);
	let error = $state<string | null>(null);
	let lastCommandId: string | null = null;

	async function run(command: ChallengeCommand): Promise<void> {
		if (pending) return;
		pending = true;
		const commandId = lastCommandId ?? randomId();
		lastCommandId = commandId;
		const result = await send(command, commandId);
		pending = false;
		if (result.ok) {
			error = null;
			lastCommandId = null;
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
	return `challenge-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
