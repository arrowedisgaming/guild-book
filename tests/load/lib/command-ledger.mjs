/**
 * Accepted-command integrity accounting for the Increment 5 Task 4 capacity
 * gate (`tests/load/session-polling.mjs`).
 *
 * This lives in its own module, typed and unit-tested, because it decides a
 * ZERO-threshold gate — "no lost or duplicated accepted command" — and a
 * miscount here is indistinguishable, from the gate's output alone, from real
 * data loss. That is not hypothetical: the 2026-07-28 23:41 staging run
 * reported "2 lost" and cost two investigations before the log showed both
 * were commands the run had never given anyone a chance to see. See
 * `tests/unit/load-harness-accounting.test.ts` and the "2 lost observations"
 * section of `docs/operations/campaign-capacity.md`.
 *
 * Two clocks matter and they are NOT the same instant:
 *
 * - `observationEndedAt` — when the poll loops stop issuing polls (`endTime`).
 *   The last moment any accepted change could still be observed.
 * - `windowEndedAt` — when the last async task settles. A command loop only
 *   re-checks the clock after `sleep(commandIntervalMs)`, so one that entered
 *   its 5000ms sleep just before `endTime` keeps `Promise.all` pending for
 *   nearly 5s longer. Measured at endTime+4839ms in the 23:41 run.
 *
 * Judgement is anchored to the first. Anchoring it to the second put the
 * cutoff 860ms *after* polling had stopped, so commands accepted into that
 * dead band were counted lost with no client alive to observe them.
 */
export class CommandLedger {
	/**
	 * Accepted command key -> acceptance time (epoch ms). Keyed
	 * `${sessionId}#${resultingVersion}`.
	 * @type {Map<string, number>}
	 */
	acceptedCommandKeys = new Map();

	/**
	 * Keys some client demonstrably saw. One observer is enough — this gate asks
	 * whether a change reached anybody, not whether it reached everybody.
	 * @type {Set<string>}
	 */
	observedCommandKeys = new Set();

	/**
	 * (sessionId, resultingVersion) pairs already claimed. Two accepted commands
	 * claiming the same resulting version means the version claim is not
	 * exclusive — a lost write, not a slow one.
	 * @type {Set<string>}
	 */
	claimedVersions = new Set();

	duplicateResultingVersions = 0;

	/** @type {number | null} */
	observationEndedAt = null;

	/** @type {number | null} */
	windowEndedAt = null;

	/**
	 * @param {string} key
	 * @param {number} acceptedAt
	 */
	recordAccepted(key, acceptedAt) {
		if (this.claimedVersions.has(key)) this.duplicateResultingVersions += 1;
		else this.claimedVersions.add(key);
		this.acceptedCommandKeys.set(key, acceptedAt);
	}

	/** @param {string} key */
	recordObserved(key) {
		this.observedCommandKeys.add(key);
	}

	/**
	 * The latest acceptance time a command can have and still be judged.
	 *
	 * Falls back to `windowEndedAt` only when observation end was never
	 * recorded, so a partially-populated ledger still judges something rather
	 * than silently judging nothing.
	 *
	 * @param {number} graceMs
	 * @returns {number}
	 */
	commandJudgementCutoff(graceMs) {
		const observationEnd = this.observationEndedAt ?? this.windowEndedAt ?? Date.now();
		return observationEnd - graceMs;
	}

	/**
	 * A command is only "lost" if the run gave every other client a fair chance
	 * to see it and none did. Commands accepted in the final moments are
	 * unobserved because observation stopped, not because anything was dropped.
	 *
	 * The caller's grace period is one full poll cycle plus the WORST
	 * propagation the run actually demonstrated: if a change had longer than the
	 * slowest observed propagation and still reached nobody, it is genuinely
	 * lost. (An earlier version used a fixed 2000ms — the budget — which is
	 * unsound whenever a run's tail exceeds the budget.)
	 *
	 * Both corrections are fixes to the measurement, NOT relaxations of the
	 * gate. The threshold is still zero.
	 *
	 * @param {number} graceMs
	 * @returns {number}
	 */
	countLostCommands(graceMs) {
		const cutoff = this.commandJudgementCutoff(graceMs);
		let lost = 0;
		for (const [key, acceptedAt] of this.acceptedCommandKeys) {
			if (acceptedAt <= cutoff && !this.observedCommandKeys.has(key)) lost += 1;
		}
		return lost;
	}

	/**
	 * Accepted commands this run actually held to the zero-loss threshold.
	 * @param {number} graceMs
	 * @returns {number}
	 */
	countJudgedCommands(graceMs) {
		const cutoff = this.commandJudgementCutoff(graceMs);
		let judged = 0;
		for (const acceptedAt of this.acceptedCommandKeys.values()) {
			if (acceptedAt <= cutoff) judged += 1;
		}
		return judged;
	}

	/**
	 * Accepted commands excluded because they were accepted too late to be
	 * fairly observed. Reported out loud by the gate: a run that judged only a
	 * handful of its commands must not be able to look like a clean run.
	 *
	 * @param {number} graceMs
	 * @returns {number}
	 */
	countUntestableCommands(graceMs) {
		return this.acceptedCommandKeys.size - this.countJudgedCommands(graceMs);
	}
}
