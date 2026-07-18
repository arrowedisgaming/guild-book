import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const databasePath = process.env.DATABASE_URL ?? '.tmp/guild-book-e2e.db';
mkdirSync(dirname(databasePath), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
	rmSync(`${databasePath}${suffix}`, { force: true });
}

const sqlite = new Database(databasePath);
sqlite.pragma('foreign_keys = ON');
const migrationsDir = 'src/lib/server/db/migrations';
for (const filename of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
	const migration = readFileSync(join(migrationsDir, filename), 'utf8');
	for (const statement of migration.split('--> statement-breakpoint')) {
		if (statement.trim()) sqlite.exec(statement);
	}
}
sqlite.close();
