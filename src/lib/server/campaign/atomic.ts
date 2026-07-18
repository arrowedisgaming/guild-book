import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { AppDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { campaignMutationReceipts } from '$lib/server/db/schema';

type D1AppDb = DrizzleD1Database<typeof schema>;

export interface CampaignAtomicStatement {
	run(): unknown;
}

/** Execute prebuilt Drizzle statements atomically on SQLite or D1. */
export async function runCampaignAtomic(
	db: AppDb,
	statements: CampaignAtomicStatement[]
): Promise<unknown[]> {
	if (isD1Database(db)) {
		const d1 = db as unknown as D1AppDb;
		return d1.batch(
			statements as unknown as Parameters<D1AppDb['batch']>[0]
		) as unknown as Promise<unknown[]>;
	}

	return db.transaction(() => statements.map((statement) => statement.run()));
}

export function isD1Database(db: AppDb): boolean {
	return typeof (db as unknown as { batch?: unknown }).batch === 'function';
}

/** Append this last so a zero-row conditional claim becomes an FK failure. */
export function mutationClaimReceipt(
	db: AppDb,
	claimId: string
): CampaignAtomicStatement {
	return db.insert(campaignMutationReceipts).values({ claimId });
}
