import { describe, expect, it } from 'vitest';
import { activityPatch, utcDayKey, type ActivityState } from '$lib/server/admin/activity';

const NEVER_SEEN: ActivityState = { firstSeenAt: null, lastSeenAt: null, loginCount: 0 };

function seenAt(iso: string, loginCount = 3): ActivityState {
	return { firstSeenAt: new Date('2026-01-01T00:00:00Z'), lastSeenAt: new Date(iso), loginCount };
}

describe('utcDayKey', () => {
	it('keys by UTC calendar day, not local time', () => {
		expect(utcDayKey(new Date('2026-07-27T00:00:00Z'))).toBe('2026-07-27');
		expect(utcDayKey(new Date('2026-07-27T23:59:59Z'))).toBe('2026-07-27');
	});
});

describe('activityPatch', () => {
	it('returns null when resuming on the same UTC day', () => {
		const now = new Date('2026-07-27T18:00:00Z');
		expect(activityPatch({ now, isSignIn: false, current: seenAt('2026-07-27T06:00:00Z') })).toBeNull();
	});

	it('returns a patch when resuming after the UTC day rolls over', () => {
		const now = new Date('2026-07-28T00:00:01Z');
		const patch = activityPatch({ now, isSignIn: false, current: seenAt('2026-07-27T23:59:59Z') });

		expect(patch).toEqual({ lastSeenAt: now });
	});

	it('does not increment loginCount when merely resuming', () => {
		const now = new Date('2026-07-28T09:00:00Z');
		const patch = activityPatch({ now, isSignIn: false, current: seenAt('2026-07-27T09:00:00Z', 5) });

		expect(patch?.loginCount).toBeUndefined();
	});

	it('increments loginCount on a sign-in even on the same day', () => {
		const now = new Date('2026-07-27T18:00:00Z');
		const patch = activityPatch({ now, isSignIn: true, current: seenAt('2026-07-27T06:00:00Z', 5) });

		expect(patch).toEqual({ lastSeenAt: now, loginCount: 6 });
	});

	it('sets firstSeenAt only when it is currently null', () => {
		const now = new Date('2026-07-27T18:00:00Z');
		const first = activityPatch({ now, isSignIn: true, current: NEVER_SEEN });
		expect(first).toEqual({ lastSeenAt: now, firstSeenAt: now, loginCount: 1 });

		const later = activityPatch({ now, isSignIn: true, current: seenAt('2026-07-27T06:00:00Z') });
		expect(later?.firstSeenAt).toBeUndefined();
	});

	it('patches a pre-migration row whose lastSeenAt is null', () => {
		const now = new Date('2026-07-27T18:00:00Z');
		const patch = activityPatch({
			now,
			isSignIn: false,
			current: { firstSeenAt: null, lastSeenAt: null, loginCount: 0 }
		});

		expect(patch).toEqual({ lastSeenAt: now, firstSeenAt: now });
	});
});
