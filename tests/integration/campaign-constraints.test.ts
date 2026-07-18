import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('campaign persistence constraints', () => {
	let sqlite: Database.Database;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		seedFoundation(sqlite);
	});

	afterEach(() => sqlite.close());

	it('allows only one active membership per campaign user', () => {
		expect(() => insertMembership(sqlite, 'membership-a2', 'campaign-a', 'player-a')).toThrow(
			/unique/i
		);

		sqlite.prepare('UPDATE campaign_members SET left_at = ? WHERE id = ?').run(200, 'membership-a');
		expect(() =>
			insertMembership(sqlite, 'membership-a2', 'campaign-a', 'player-a')
		).not.toThrow();
	});

	it('allows only one active tenure per character across campaigns', () => {
		insertTenure(sqlite, 'tenure-a', 'campaign-a', 'membership-a', 'character-a');

		expect(() =>
			insertTenure(sqlite, 'tenure-b', 'campaign-a', 'membership-b', 'character-a')
		).toThrow(/unique/i);
	});

	it('allows only one active tenure per membership', () => {
		insertTenure(sqlite, 'tenure-a', 'campaign-a', 'membership-a', 'character-a');

		expect(() =>
			insertTenure(sqlite, 'tenure-b', 'campaign-a', 'membership-a', 'character-b')
		).toThrow(/unique/i);
	});

	it('permits a replacement after the previous tenure ends with a valid reason', () => {
		insertTenure(sqlite, 'tenure-a', 'campaign-a', 'membership-a', 'character-a');
		sqlite
			.prepare(
				"UPDATE campaign_adventurer_tenures SET ended_at = ?, end_reason = 'replaced' WHERE id = ?"
			)
			.run(200, 'tenure-a');

		expect(() =>
			insertTenure(sqlite, 'tenure-b', 'campaign-a', 'membership-a', 'character-b')
		).not.toThrow();
	});

	it('rejects tenure end reasons outside the lifecycle vocabulary', () => {
		expect(() => {
			insertTenure(sqlite, 'tenure-a', 'campaign-a', 'membership-a', 'character-a');
			sqlite
				.prepare(
					"UPDATE campaign_adventurer_tenures SET ended_at = ?, end_reason = 'retired' WHERE id = ?"
				)
				.run(200, 'tenure-a');
		}).toThrow(/check/i);
	});
});

function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
}

function seedFoundation(sqlite: Database.Database): void {
	for (const userId of ['owner-a', 'player-a', 'player-b']) {
		sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
	}
	sqlite
		.prepare(
			'INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.run('campaign-a', 'owner-a', 'The Lantern Guild', '', 100, 100);

	for (const [id, userId] of [
		['character-a', 'player-a'],
		['character-b', 'player-a']
	]) {
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run(id, userId, '{}', 100, 100);
	}

	insertMembership(sqlite, 'membership-a', 'campaign-a', 'player-a');
	insertMembership(sqlite, 'membership-b', 'campaign-a', 'player-b');
}

function insertMembership(
	sqlite: Database.Database,
	id: string,
	campaignId: string,
	userId: string
) {
	return sqlite
		.prepare(
			'INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?)'
		)
		.run(id, campaignId, userId, 100);
}

function insertTenure(
	sqlite: Database.Database,
	id: string,
	campaignId: string,
	membershipId: string,
	characterId: string
) {
	return sqlite
		.prepare(
			'INSERT INTO campaign_adventurer_tenures (id, campaign_id, membership_id, character_id, started_at, started_by_user_id) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.run(id, campaignId, membershipId, characterId, 100, 'owner-a');
}
