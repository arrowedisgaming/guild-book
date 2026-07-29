import { describe, expect, it } from 'vitest';
import { CommandLedger } from '../load/lib/command-ledger.mjs';

/**
 * Regression tests for the capacity gate's "no lost accepted command"
 * accounting (Increment 5 Task 4).
 *
 * Why these exist: the 2026-07-28 23:41 staging gate run reported "2 lost"
 * against a zero threshold, and nothing in the harness could tell a genuine
 * dropped change apart from a command the run never gave anyone a chance to
 * see. The run log settled it — 2578 accepted, 5152 observations, i.e. exactly
 * 2 commands x 2 observers missing, with player-a and player-b counts
 * identical in all nine campaigns and no gap anywhere in the 30-minute
 * timeline. Both "losses" were the final command of campaigns 3 and 4,
 * accepted AFTER every poll loop had already stopped.
 *
 * Root cause: the cutoff was measured backwards from `windowEndedAt`, stamped
 * when the last async task settles. A command loop only re-checks the clock
 * after `sleep(commandIntervalMs)`, so one that entered its 5000ms sleep just
 * before `endTime` kept `Promise.all` pending for 4839ms past the point where
 * polling stopped — putting the cutoff 860ms AFTER observation had ceased.
 * Commands accepted in that dead band were counted lost with no client left
 * alive to observe them.
 *
 * The fix anchors judgement to when observation stopped. That is a correction
 * to the measurement, not a relaxation of the gate: the threshold is still
 * zero, and every command that had a real chance to be seen is still judged.
 */
describe('capacity gate lost-command accounting', () => {
	// Real timings from the 2026-07-28 23:41 run.
	const END_TIME = Date.parse('2026-07-29T00:11:56.749Z'); // poll loops stop issuing
	const WINDOW_ENDED_AT = Date.parse('2026-07-29T00:12:01.588Z'); // last task settled
	const GRACE_MS = 1000 + 150 + 2829; // pollInterval + jitter + worst propagation

	function ledgerWithCommandAt(acceptedAt: number) {
		const ledger = new CommandLedger();
		ledger.recordAccepted('session-a#42', acceptedAt);
		ledger.windowEndedAt = WINDOW_ENDED_AT;
		ledger.observationEndedAt = END_TIME;
		return ledger;
	}

	it('does not count a command accepted after polling had already stopped', () => {
		// 00:11:57.343Z — campaign 3's final command. Accepted 594ms after the
		// last poll loop exited, and 266ms before the old cutoff, so the old
		// accounting called it lost.
		const ledger = ledgerWithCommandAt(Date.parse('2026-07-29T00:11:57.343Z'));
		expect(ledger.countLostCommands(GRACE_MS)).toBe(0);
	});

	it('does not count a command accepted with less than the grace period left', () => {
		// Campaign 4's case: accepted just before polling stopped, so observers
		// existed but not for the full grace window. It cannot be judged either
		// way and must not be counted against a zero threshold.
		const ledger = ledgerWithCommandAt(END_TIME - 2000);
		expect(ledger.countLostCommands(GRACE_MS)).toBe(0);
	});

	it('still counts a genuinely unobserved command that had a full fair chance', () => {
		// Accepted well inside the window with the whole grace period to
		// propagate, and no observation recorded. This is real data loss and the
		// gate must keep failing on it — the fix must not blunt that.
		const ledger = ledgerWithCommandAt(END_TIME - GRACE_MS - 60_000);
		expect(ledger.countLostCommands(GRACE_MS)).toBe(1);
	});

	it('does not count a command that some client observed', () => {
		const ledger = ledgerWithCommandAt(END_TIME - GRACE_MS - 60_000);
		ledger.recordObserved('session-a#42');
		expect(ledger.countLostCommands(GRACE_MS)).toBe(0);
	});

	it('still flags a duplicated resulting version as a lost write', () => {
		const ledger = new CommandLedger();
		ledger.recordAccepted('session-a#7', END_TIME - 60_000);
		ledger.recordAccepted('session-a#7', END_TIME - 59_000);
		expect(ledger.duplicateResultingVersions).toBe(1);
	});

	it('reports how many accepted commands the gate actually judged', () => {
		// A run that silently stops judging commands must not look like a clean
		// run. A future change that shrank the judged set to a handful would
		// otherwise pass unnoticed.
		const ledger = new CommandLedger();
		ledger.windowEndedAt = WINDOW_ENDED_AT;
		ledger.observationEndedAt = END_TIME;
		ledger.recordAccepted('session-a#1', END_TIME - GRACE_MS - 60_000); // judged
		ledger.recordAccepted('session-a#2', END_TIME - GRACE_MS - 30_000); // judged
		ledger.recordAccepted('session-a#3', END_TIME + 600); // untestable
		ledger.recordObserved('session-a#1');
		ledger.recordObserved('session-a#2');

		expect(ledger.countJudgedCommands(GRACE_MS)).toBe(2);
		expect(ledger.countUntestableCommands(GRACE_MS)).toBe(1);
		expect(ledger.countLostCommands(GRACE_MS)).toBe(0);
	});

	it('falls back to windowEndedAt when observation end was never recorded', () => {
		// Defensive: a partially-populated ledger must not silently judge nothing.
		const ledger = new CommandLedger();
		ledger.windowEndedAt = WINDOW_ENDED_AT;
		ledger.recordAccepted('session-a#42', WINDOW_ENDED_AT - GRACE_MS - 1000);
		expect(ledger.countLostCommands(GRACE_MS)).toBe(1);
	});

	it('reproduces the 23:41 run: both dead-band commands stop being counted', () => {
		// The two real acceptance times, end to end through the same path the
		// gate uses. Before the fix this returned 2 and failed the run.
		const ledger = new CommandLedger();
		ledger.windowEndedAt = WINDOW_ENDED_AT;
		ledger.observationEndedAt = END_TIME;
		ledger.recordAccepted('c3#287', Date.parse('2026-07-29T00:11:57.343Z'));
		ledger.recordAccepted('c4#287', Date.parse('2026-07-29T00:11:56.673Z'));

		expect(ledger.countLostCommands(GRACE_MS)).toBe(0);
		expect(ledger.countUntestableCommands(GRACE_MS)).toBe(2);
	});
});
