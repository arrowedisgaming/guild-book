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
 * A failed attempt keeps its `commandId` so the NEXT call to `run` reuses it
 * — but ONLY when that next call is a genuine retry of the SAME intent (the
 * identical command payload). Review round finding: this runner is shared by
 * every control in the panel (one in-flight command across the whole panel
 * at a time), so `lastCommandId` alone — cleared only on success — was
 * sticky across DIFFERENT intents too: after any one control's command was
 * rejected, the very next click of ANY OTHER control reused that stale id,
 * the server found the persisted row with a different `requestHash` and
 * returned `command-id-reused` (itself a failure), and the id was retained
 * again — bricking the whole panel until a page reload. `lastCommandKey`
 * (a canonical stringification of the command, mirroring
 * `campaign-session.svelte.ts`'s own `canonicalCommandKey`) scopes the
 * retained id to the specific payload it was minted for: a retry of that
 * exact command reuses it (true retry-safety, per O1), but any different
 * command — even one submitted immediately after a rejection — always mints
 * a fresh id. A successful attempt clears both, so the next action (whatever
 * it is) starts fresh.
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
	let lastCommandKey: string | null = null;

	async function run(command: ChallengeCommand): Promise<void> {
		if (pending) return;
		pending = true;
		const key = canonicalCommandKey(command);
		const commandId = lastCommandKey === key && lastCommandId ? lastCommandId : randomId();
		lastCommandId = commandId;
		lastCommandKey = key;
		const result = await send(command, commandId);
		pending = false;
		if (result.ok) {
			error = null;
			lastCommandId = null;
			lastCommandKey = null;
		} else {
			error = result.message ?? COMMAND_ERROR_MESSAGE;
			// Deliberately NOT cleared: a retry of this SAME command should
			// reuse `commandId`. A different command's `run` call will see a
			// different `key` above and mint its own fresh id regardless.
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

/** Same "canonical stringification of the payload" convention as
 * `campaign-session.svelte.ts`'s `canonicalCommandKey` — every field on a
 * `ChallengeCommand` is a primitive (id/enum/string), so plain
 * `JSON.stringify` is already stable across calls built from the same object
 * literal shape; no deep key-sorting needed. */
function canonicalCommandKey(command: ChallengeCommand): string {
	return JSON.stringify(command);
}
