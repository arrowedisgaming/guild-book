import type { Page, TestInfo } from '@playwright/test';

interface SyncDiagnosticRecord {
	actor: string;
	path: string;
	status: number;
	requestId: string | null;
	recipientUserId: string | null;
	cursor: number | null;
	sessionVersion: number | null;
}

interface SyncBodyLike {
	recipientUserId?: unknown;
	cursor?: unknown;
	session?: { sessionVersion?: unknown } | null;
}

interface Collector {
	records: SyncDiagnosticRecord[];
	pending: Set<Promise<void>>;
}

const collectorsByTest = new WeakMap<TestInfo, Collector>();

export function captureSyncDiagnostics(page: Page, testInfo: TestInfo, actor: string): void {
	const collector = collectorFor(testInfo);
	page.on('response', (response) => {
		const parsedUrl = new URL(response.url());
		if (!/^\/api\/campaigns\/[^/]+\/sync$/.test(parsedUrl.pathname)) return;

		const pending = (async () => {
			let body: SyncBodyLike | null = null;
			if (response.status() !== 204) {
				body = (await response.json().catch(() => null)) as SyncBodyLike | null;
			}
			collector.records.push({
				actor,
				path: parsedUrl.pathname,
				status: response.status(),
				requestId: response.headers()['x-request-id'] ?? null,
				recipientUserId:
					typeof body?.recipientUserId === 'string' ? body.recipientUserId : null,
				cursor: typeof body?.cursor === 'number' ? body.cursor : null,
				sessionVersion:
					typeof body?.session?.sessionVersion === 'number'
						? body.session.sessionVersion
						: null
			});
		})().finally(() => collector.pending.delete(pending));
		collector.pending.add(pending);
	});
}

export async function attachSyncDiagnostics(testInfo: TestInfo): Promise<void> {
	const collector = collectorsByTest.get(testInfo);
	if (!collector) return;
	await Promise.allSettled([...collector.pending]);
	await testInfo.attach('sync-diagnostics', {
		body: Buffer.from(JSON.stringify(collector.records, null, 2)),
		contentType: 'application/json'
	});
	collectorsByTest.delete(testInfo);
}

function collectorFor(testInfo: TestInfo): Collector {
	const existing = collectorsByTest.get(testInfo);
	if (existing) return existing;
	const created = { records: [], pending: new Set<Promise<void>>() };
	collectorsByTest.set(testInfo, created);
	return created;
}
