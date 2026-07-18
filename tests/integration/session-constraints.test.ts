import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('session persistence constraints', () => {
	let sqlite: Database.Database;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		seedFoundation(sqlite);
	});

	afterEach(() => sqlite.close());

	it('allows only one active or frozen session per campaign', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });

		expect(() =>
			insertSession(sqlite, { id: 'session-b', campaignId: 'campaign-a', sequence: 2, status: 'frozen' })
		).toThrow(/unique/i);

		sqlite.prepare("UPDATE play_sessions SET status = 'ended' WHERE id = ?").run('session-a');
		expect(() =>
			insertSession(sqlite, { id: 'session-c', campaignId: 'campaign-a', sequence: 3, status: 'active' })
		).not.toThrow();
	});

	it('rejects an unrecognized session status', () => {
		expect(() =>
			insertSession(sqlite, { id: 'session-bad-status', campaignId: 'campaign-a', sequence: 1, status: 'paused' })
		).toThrow(/check/i);
	});

	it('allows only one runtime content row per session', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });
		insertRuntimeContent(sqlite, { sessionId: 'session-a' });

		expect(() => insertRuntimeContent(sqlite, { sessionId: 'session-a' })).toThrow(/unique/i);
	});

	it('enforces runtimeContentId as a real foreign key into sessionRuntimeContents', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });

		expect(() =>
			sqlite
				.prepare('UPDATE play_sessions SET runtime_content_id = ? WHERE id = ?')
				.run('no-such-session', 'session-a')
		).toThrow(/foreign key/i);

		insertRuntimeContent(sqlite, { sessionId: 'session-a' });
		expect(() =>
			sqlite
				.prepare('UPDATE play_sessions SET runtime_content_id = ? WHERE id = ?')
				.run('session-a', 'session-a')
		).not.toThrow();

		// Deleting the runtime content row nulls the pointer rather than
		// leaving a dangling reference (onDelete: 'set null').
		sqlite.prepare('DELETE FROM session_runtime_contents WHERE session_id = ?').run('session-a');
		const row = sqlite
			.prepare('SELECT runtime_content_id AS runtimeContentId FROM play_sessions WHERE id = ?')
			.get('session-a') as { runtimeContentId: string | null };
		expect(row.runtimeContentId).toBeNull();
	});

	it('allows only one server state row per session', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });
		insertServerState(sqlite, { sessionId: 'session-a' });

		expect(() => insertServerState(sqlite, { sessionId: 'session-a' })).toThrow(/unique/i);
	});

	it('allows only one private state row per (session, recipient)', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });
		insertPrivateState(sqlite, { id: 'private-a', sessionId: 'session-a', recipientUserId: 'player-a' });

		expect(() =>
			insertPrivateState(sqlite, { id: 'private-a2', sessionId: 'session-a', recipientUserId: 'player-a' })
		).toThrow(/unique/i);

		expect(() =>
			insertPrivateState(sqlite, { id: 'private-b', sessionId: 'session-a', recipientUserId: 'player-b' })
		).not.toThrow();
	});

	it('requires a unique command id per session', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });
		insertAcceptedCommand(sqlite, {
			id: 'row-a',
			sessionId: 'session-a',
			commandId: 'a',
			expectedVersion: 1,
			resultingVersion: 2
		});

		expect(() =>
			insertAcceptedCommand(sqlite, {
				id: 'row-b',
				sessionId: 'session-a',
				commandId: 'a',
				expectedVersion: 2,
				resultingVersion: 3
			})
		).toThrow(/unique/i);

		// Same command id in a different session is fine.
		insertSession(sqlite, { id: 'session-other', campaignId: 'campaign-a', sequence: 2, status: 'ended' });
		expect(() =>
			insertAcceptedCommand(sqlite, {
				id: 'row-c',
				sessionId: 'session-other',
				commandId: 'a',
				expectedVersion: 1,
				resultingVersion: 2
			})
		).not.toThrow();
	});

	it('requires a unique accepted resulting version per session, but tolerates repeated rejections', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });
		insertAcceptedCommand(sqlite, {
			id: 'row-a',
			sessionId: 'session-a',
			commandId: 'a',
			expectedVersion: 1,
			resultingVersion: 2
		});

		expect(() =>
			insertAcceptedCommand(sqlite, {
				id: 'row-b',
				sessionId: 'session-a',
				commandId: 'b',
				expectedVersion: 1,
				resultingVersion: 2
			})
		).toThrow(/unique/i);

		expect(() =>
			insertRejectedCommand(sqlite, { id: 'row-r1', sessionId: 'session-a', commandId: 'r1', expectedVersion: 1 })
		).not.toThrow();
		expect(() =>
			insertRejectedCommand(sqlite, { id: 'row-r2', sessionId: 'session-a', commandId: 'r2', expectedVersion: 1 })
		).not.toThrow();
	});

	it('requires resultingVersion = expectedVersion + 1 for accepted commands', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });

		expect(() =>
			insertAcceptedCommand(sqlite, {
				id: 'row-c',
				sessionId: 'session-a',
				commandId: 'c',
				expectedVersion: 1,
				resultingVersion: 3
			})
		).toThrow(/check/i);
	});

	it('rejects an accepted command outcome with no resulting version', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });

		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO session_commands
						(id, session_id, command_id, actor_user_id, request_hash, command_type,
						 client_observed_version, structural_precondition_version, expected_version, resulting_version,
						 status, outcome_metadata_json, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					'row-bad-outcome',
					'session-a',
					'bad-outcome',
					'owner-a',
					'hash',
					'draw',
					1,
					null,
					1,
					null,
					'accepted',
					'{}',
					100
				)
		).toThrow(/check/i);
	});

	it('rejects a rejected command outcome that still carries a resulting version', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });

		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO session_commands
						(id, session_id, command_id, actor_user_id, request_hash, command_type,
						 client_observed_version, structural_precondition_version, expected_version, resulting_version,
						 status, outcome_metadata_json, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					'row-bad-reject',
					'session-a',
					'bad-reject',
					'owner-a',
					'hash',
					'draw',
					1,
					null,
					1,
					2,
					'rejected',
					'{}',
					100
				)
		).toThrow(/check/i);
	});

	it('allows campaign events to reference an optional session and command', () => {
		insertSession(sqlite, { id: 'session-a', campaignId: 'campaign-a', sequence: 1, status: 'active' });
		insertAcceptedCommand(sqlite, {
			id: 'row-a',
			sessionId: 'session-a',
			commandId: 'a',
			expectedVersion: 1,
			resultingVersion: 2
		});

		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO campaign_events
						(campaign_id, session_id, command_id, actor_user_id, kind, public_payload_json, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.run('campaign-a', 'session-a', 'row-a', 'owner-a', 'command-accepted', '{}', 100)
		).not.toThrow();
	});

	it('allows only one secret payload per (event, recipient)', () => {
		const eventId = sqlite
			.prepare(
				`INSERT INTO campaign_events (campaign_id, actor_user_id, kind, public_payload_json, created_at)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.run('campaign-a', 'owner-a', 'card-drawn', '{}', 100).lastInsertRowid;

		insertEventSecret(sqlite, { id: 'secret-a', eventId: Number(eventId), recipientUserId: 'player-a' });

		expect(() =>
			insertEventSecret(sqlite, { id: 'secret-a2', eventId: Number(eventId), recipientUserId: 'player-a' })
		).toThrow(/unique/i);

		expect(() =>
			insertEventSecret(sqlite, { id: 'secret-b', eventId: Number(eventId), recipientUserId: 'player-b' })
		).not.toThrow();
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
}

function insertSession(
	sqlite: Database.Database,
	options: { id: string; campaignId: string; sequence: number; status: string }
) {
	return sqlite
		.prepare(
			`INSERT INTO play_sessions
				(id, campaign_id, sequence, status, phase, content_pack_id, content_pack_version,
				 procedure_schema_version, content_digest, version, public_state_schema_version,
				 public_state_json, started_at, started_by_user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			options.id,
			options.campaignId,
			options.sequence,
			options.status,
			'crawl',
			'hmtw',
			'3.0.0',
			1,
			'0'.repeat(64),
			0,
			1,
			'{}',
			100,
			'owner-a'
		);
}

function insertRuntimeContent(sqlite: Database.Database, options: { sessionId: string }) {
	return sqlite
		.prepare(
			`INSERT INTO session_runtime_contents (session_id, schema_version, session_version, runtime_content_json, created_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(options.sessionId, 1, 0, '{}', 100);
}

function insertServerState(sqlite: Database.Database, options: { sessionId: string }) {
	return sqlite
		.prepare(
			`INSERT INTO session_server_states (session_id, schema_version, session_version, server_state_json, updated_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(options.sessionId, 1, 0, '{}', 100);
}

function insertPrivateState(
	sqlite: Database.Database,
	options: { id: string; sessionId: string; recipientUserId: string }
) {
	return sqlite
		.prepare(
			`INSERT INTO session_private_states
				(id, session_id, recipient_user_id, schema_version, session_version, private_state_json, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(options.id, options.sessionId, options.recipientUserId, 1, 0, '{}', 100);
}

function insertAcceptedCommand(
	sqlite: Database.Database,
	options: { id: string; sessionId: string; commandId: string; expectedVersion: number; resultingVersion: number }
) {
	return sqlite
		.prepare(
			`INSERT INTO session_commands
				(id, session_id, command_id, actor_user_id, request_hash, command_type,
				 client_observed_version, structural_precondition_version, expected_version, resulting_version,
				 status, outcome_metadata_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			options.id,
			options.sessionId,
			options.commandId,
			'owner-a',
			`hash-${options.commandId}`,
			'draw',
			options.expectedVersion,
			null,
			options.expectedVersion,
			options.resultingVersion,
			'accepted',
			'{}',
			100
		);
}

function insertRejectedCommand(
	sqlite: Database.Database,
	options: { id: string; sessionId: string; commandId: string; expectedVersion: number }
) {
	return sqlite
		.prepare(
			`INSERT INTO session_commands
				(id, session_id, command_id, actor_user_id, request_hash, command_type,
				 client_observed_version, structural_precondition_version, expected_version, resulting_version,
				 status, outcome_metadata_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			options.id,
			options.sessionId,
			options.commandId,
			'owner-a',
			`hash-${options.commandId}`,
			'end-round',
			options.expectedVersion,
			options.expectedVersion,
			options.expectedVersion,
			null,
			'rejected',
			'{}',
			100
		);
}

function insertEventSecret(
	sqlite: Database.Database,
	options: { id: string; eventId: number; recipientUserId: string }
) {
	return sqlite
		.prepare(
			`INSERT INTO campaign_event_secrets (id, event_id, recipient_user_id, payload_json, created_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(options.id, options.eventId, options.recipientUserId, '{}', 100);
}
