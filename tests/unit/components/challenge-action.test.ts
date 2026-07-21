import { describe, expect, it } from 'vitest';
import { createChallengeAction } from '$lib/components/campaign/table/challenge/challenge-action.svelte';
import type { ChallengeCommand } from '$lib/engine/session/procedures/challenge/command';
import type { SendCommandResult } from '$lib/stores/campaign-session.svelte';

/**
 * Review round finding: `lastCommandId` was previously cleared only on
 * success, so after ANY rejected command the runner's NEXT `run` call — even
 * for a totally different control's command — reused the stale id. The
 * server would find the persisted row under a different `requestHash` and
 * reject with `command-id-reused` (itself a failure), so the id was
 * retained again: every subsequent Challenge action failed until reload.
 * These two tests are the discriminating pair O1 calls for: retry-safety
 * for the SAME intent must survive, but a DIFFERENT intent must never
 * inherit another command's id.
 */
describe('createChallengeAction', () => {
	it('reuses the same commandId when the SAME command is retried after a rejection', async () => {
		const seenCommandIds: (string | undefined)[] = [];
		let callCount = 0;
		const send = async (_command: ChallengeCommand, commandId?: string): Promise<SendCommandResult> => {
			seenCommandIds.push(commandId);
			callCount += 1;
			if (callCount === 1) return { ok: false, message: 'rejected' };
			return { ok: true };
		};

		const runner = createChallengeAction(send);
		await runner.run({ type: 'end-turn' });
		expect(runner.error).toBe('rejected');
		await runner.run({ type: 'end-turn' });

		expect(seenCommandIds).toHaveLength(2);
		expect(seenCommandIds[0]).toBeTruthy();
		expect(seenCommandIds[1]).toBe(seenCommandIds[0]);
		expect(runner.error).toBeNull();
	});

	it('mints a FRESH commandId for a DIFFERENT command submitted after a rejection — never bricking the panel', async () => {
		const seenCommandIds: (string | undefined)[] = [];
		const send = async (_command: ChallengeCommand, commandId?: string): Promise<SendCommandResult> => {
			seenCommandIds.push(commandId);
			// Every call fails here — mirrors the server's real behavior for a
			// reused id against a DIFFERENT payload: `command-id-reused`, a
			// failure, which is exactly the condition that used to keep the
			// stale id sticky forever.
			return { ok: false, message: 'command-id-reused' };
		};

		const runner = createChallengeAction(send);
		await runner.run({ type: 'end-turn' });
		await runner.run({ type: 'deal-round' });
		await runner.run({ type: 'gm-mulligan' });

		expect(seenCommandIds).toHaveLength(3);
		const unique = new Set(seenCommandIds);
		expect(unique.size).toBe(3);
	});
});
