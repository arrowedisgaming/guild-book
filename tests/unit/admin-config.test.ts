import { describe, expect, it } from 'vitest';
import { getAdminConfig, isAdminEmail } from '$lib/server/admin/config';
import type { RequestEvent } from '@sveltejs/kit';

/** `getEnv` reads `event.platform.env` first, which is all these tests need. */
function eventWith(env: Record<string, string>): RequestEvent {
	return { platform: { env } } as unknown as RequestEvent;
}

describe('getAdminConfig', () => {
	it('yields an empty set when ADMIN_EMAILS is unset', () => {
		expect(getAdminConfig(eventWith({})).adminEmails.size).toBe(0);
	});

	it('yields an empty set when ADMIN_EMAILS is blank or only separators', () => {
		expect(getAdminConfig(eventWith({ ADMIN_EMAILS: '   ' })).adminEmails.size).toBe(0);
		expect(getAdminConfig(eventWith({ ADMIN_EMAILS: ',,' })).adminEmails.size).toBe(0);
	});

	it('splits, trims, and lowercases entries', () => {
		const config = getAdminConfig(eventWith({ ADMIN_EMAILS: ' Owner@Example.Test , two@example.test' }));

		expect([...config.adminEmails].sort()).toEqual(['owner@example.test', 'two@example.test']);
	});
});

describe('isAdminEmail', () => {
	const config = getAdminConfig(eventWith({ ADMIN_EMAILS: 'owner@example.test' }));

	it('matches regardless of casing or surrounding whitespace', () => {
		expect(isAdminEmail(config, 'Owner@Example.Test')).toBe(true);
		expect(isAdminEmail(config, ' owner@example.test ')).toBe(true);
	});

	it('rejects a null, undefined, or empty email', () => {
		expect(isAdminEmail(config, null)).toBe(false);
		expect(isAdminEmail(config, undefined)).toBe(false);
		expect(isAdminEmail(config, '')).toBe(false);
	});

	it('rejects a substring or superstring of an admin address', () => {
		expect(isAdminEmail(config, 'owner@example.tes')).toBe(false);
		expect(isAdminEmail(config, 'notowner@example.test')).toBe(false);
		expect(isAdminEmail(config, 'owner@example.test.evil.test')).toBe(false);
	});

	it('fails closed against an empty allowlist', () => {
		const empty = getAdminConfig(eventWith({}));
		expect(isAdminEmail(empty, 'owner@example.test')).toBe(false);
	});
});
