/**
 * Decides whether a user's activity columns need writing. Pure by design — no
 * DB access, no clock read of its own — so the day-boundary behaviour is
 * exhaustively testable. `auth-policy.ts` supplies `now` and applies the
 * result.
 */

export interface ActivityState {
	firstSeenAt: Date | null;
	lastSeenAt: Date | null;
	loginCount: number;
}

export interface ActivityPatch {
	firstSeenAt?: Date;
	lastSeenAt: Date;
	loginCount?: number;
}

/** UTC, not local: keeps this deterministic in tests and stable across hosts. */
export function utcDayKey(at: Date): string {
	return at.toISOString().slice(0, 10);
}

export function activityPatch(input: {
	now: Date;
	isSignIn: boolean;
	current: ActivityState;
}): ActivityPatch | null {
	const { now, isSignIn, current } = input;

	// The overwhelmingly common case: an already-signed-in user making another
	// request today. Returning null here is what caps this at one write per
	// user per day no matter how much traffic they generate.
	if (!isSignIn && current.lastSeenAt && utcDayKey(current.lastSeenAt) === utcDayKey(now)) {
		return null;
	}

	const patch: ActivityPatch = { lastSeenAt: now };
	if (!current.firstSeenAt) patch.firstSeenAt = now;
	if (isSignIn) patch.loginCount = current.loginCount + 1;
	return patch;
}
