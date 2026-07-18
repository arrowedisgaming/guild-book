import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	ensureUser: vi.fn(),
	getEnv: vi.fn(
		(event: { platform?: { env?: Record<string, string> } }, key: string) =>
			event.platform?.env?.[key]
	)
}));

vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/auth', () => ({ ensureUser: mocks.ensureUser, getEnv: mocks.getEnv }));

import {
	campaignHeaders,
	requireCampaignAccess,
	requireCampaignReadAccess
} from '$lib/server/campaign/access';
import { canAccessCampaignFeature } from '$lib/server/campaign/config';

describe('campaign feature configuration', () => {
	it('allows global enablement or an explicit pilot user only', () => {
		expect(
			canAccessCampaignFeature({ enabled: true, pilotUserIds: new Set() }, 'unlisted')
		).toBe(true);
		expect(
			canAccessCampaignFeature({ enabled: false, pilotUserIds: new Set(['pilot']) }, 'pilot')
		).toBe(true);
		expect(
			canAccessCampaignFeature({ enabled: false, pilotUserIds: new Set(['pilot']) }, 'unlisted')
		).toBe(false);
	});

	it('uses private no-store response headers', () => {
		expect(campaignHeaders()).toEqual({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' });
	});
});

describe('requireCampaignAccess', () => {
	let sqlite: Database.Database;
	let db: AppDb;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(`
			CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
			CREATE TABLE campaigns (
				id TEXT PRIMARY KEY NOT NULL,
				owner_user_id TEXT NOT NULL REFERENCES users(id),
				archived_at INTEGER
			);
			CREATE TABLE campaign_members (
				id TEXT PRIMARY KEY NOT NULL,
				campaign_id TEXT NOT NULL REFERENCES campaigns(id),
				user_id TEXT NOT NULL REFERENCES users(id),
				left_at INTEGER,
				removed_at INTEGER
			);
		`);
		for (const id of ['owner', 'member', 'former', 'removed', 'unrelated']) {
			sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(id);
		}
		sqlite
			.prepare('INSERT INTO campaigns (id, owner_user_id) VALUES (?, ?)')
			.run('campaign-a', 'owner');
		sqlite
			.prepare(
				'INSERT INTO campaign_members (id, campaign_id, user_id, left_at, removed_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run('membership-active', 'campaign-a', 'member', null, null);
		sqlite
			.prepare(
				'INSERT INTO campaign_members (id, campaign_id, user_id, left_at, removed_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run('membership-former', 'campaign-a', 'former', 200, null);
		sqlite
			.prepare(
				'INSERT INTO campaign_members (id, campaign_id, user_id, left_at, removed_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run('membership-removed', 'campaign-a', 'removed', null, 200);
		db = drizzle(sqlite, { schema });
		mocks.getDb.mockResolvedValue(db);
	});

	afterEach(() => {
		vi.clearAllMocks();
		sqlite.close();
	});

	it.each([
		['owner', { kind: 'gm', userId: 'owner', campaignId: 'campaign-a' }],
		[
			'member',
			{
				kind: 'player',
				userId: 'member',
				campaignId: 'campaign-a',
				membershipId: 'membership-active'
			}
		]
	] as const)('returns the scoped role for %s', async (userId, role) => {
		mocks.ensureUser.mockResolvedValue(userId);
		await expect(requireCampaignAccess(enabledEvent(), 'campaign-a')).resolves.toEqual(role);
	});

	it.each(['former', 'removed', 'unrelated'])('returns the same 404 for denied user %s', async (userId) => {
		mocks.ensureUser.mockResolvedValue(userId);
		await expect(requireCampaignAccess(enabledEvent(), 'campaign-a')).rejects.toMatchObject({
			status: 404,
			body: { message: 'Campaign not found' }
		});
	});

	it('returns 404 when the feature is disabled', async () => {
		mocks.ensureUser.mockResolvedValue('owner');
		const setHeaders = vi.fn();
		await expect(
			requireCampaignAccess(
				eventWithEnv({ CAMPAIGNS_ENABLED: 'false' }, setHeaders),
				'campaign-a'
			)
		).rejects.toMatchObject({
			status: 404
		});
		expect(setHeaders).toHaveBeenCalledWith({
			'Cache-Control': 'private, no-store',
			Vary: 'Cookie'
		});
	});

	it('allows an explicit pilot while globally disabled', async () => {
		mocks.ensureUser.mockResolvedValue('owner');
		await expect(requireCampaignAccess(pilotEvent('owner'), 'campaign-a')).resolves.toMatchObject({
			kind: 'gm'
		});
	});

	it('keeps archived campaigns readable for the GM and active member but not mutable', async () => {
		sqlite.prepare('UPDATE campaigns SET archived_at = 300 WHERE id = ?').run('campaign-a');
		for (const userId of ['owner', 'member']) {
			mocks.ensureUser.mockResolvedValue(userId);
			await expect(requireCampaignReadAccess(enabledEvent(), 'campaign-a')).resolves.toMatchObject({
				campaignId: 'campaign-a'
			});
			await expect(requireCampaignAccess(enabledEvent(), 'campaign-a')).rejects.toMatchObject({
				status: 404
			});
		}
	});

	it('turns authentication failure into the same resource 404', async () => {
		mocks.ensureUser.mockRejectedValue({ status: 401 });
		await expect(requireCampaignAccess(enabledEvent(), 'campaign-a')).rejects.toMatchObject({
			status: 404,
			body: { message: 'Campaign not found' }
		});
	});

	it('does not hide unexpected authentication infrastructure failures', async () => {
		const outage = new Error('session database unavailable');
		mocks.ensureUser.mockRejectedValue(outage);
		await expect(requireCampaignAccess(enabledEvent(), 'campaign-a')).rejects.toBe(outage);
	});
});

function enabledEvent() {
	return eventWithEnv({ CAMPAIGNS_ENABLED: 'true' });
}

function disabledEvent() {
	return eventWithEnv({ CAMPAIGNS_ENABLED: 'false' });
}

function pilotEvent(userId: string) {
	return eventWithEnv({ CAMPAIGNS_ENABLED: 'false', CAMPAIGNS_PILOT_USER_IDS: userId });
}

function eventWithEnv(env: Record<string, string>, setHeaders?: (headers: Record<string, string>) => void) {
	return { platform: { env }, setHeaders } as unknown as Parameters<typeof requireCampaignAccess>[0];
}
