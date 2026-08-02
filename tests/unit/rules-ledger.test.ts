import { describe, expect, it } from 'vitest';
import ledger from '../../scripts/content-import/manifest/rules-coverage-ledger.json';
import rules from '../../static/content-packs/hmtw/rules.json';

/**
 * The vault is gitignored, so CI cannot re-extract chapters. This test is the
 * committed half of the coverage guarantee: the ledger (generated WITH the
 * vault, locally) must stay bijective with rules.json. The local half —
 * "ledger matches the actual source" — is `md-rules.mjs --check` inside
 * `npm run content:verify` / release:verify.
 */
describe('rules coverage ledger', () => {
	const emitted = ledger.flatMap((c: { headings: { disposition: string; id?: string }[] }) => c.headings.filter((h) => h.disposition === 'emitted'));
	const ruleIds = new Set(rules.map((r: { id: string }) => r.id));

	it('covers all nine chapters', () => {
		expect(ledger.map((c: { section: string }) => c.section).sort()).toEqual(
			['adventurer', 'basics', 'camp-phase', 'challenge-phase', 'city-phase', 'crawl-phase', 'four-paths', 'guild', 'kith-and-kin'].sort()
		);
	});

	it('every emitted ledger id exists exactly once in rules.json', () => {
		const ids = emitted.map((h) => h.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(ruleIds.has(id!), `${id} missing from rules.json`).toBe(true);
	});

	it('every walked-section rule is claimed by the ledger', () => {
		const walkedSections = new Set(ledger.map((c: { section: string }) => c.section));
		const emittedIds = new Set(emitted.map((h) => h.id));
		for (const r of rules.filter((r: { section: string }) => walkedSections.has(r.section))) {
			expect(emittedIds.has(r.id), `${r.id} not in ledger`).toBe(true);
		}
	});

	it('every heading is dispositioned, and skips carry reasons', () => {
		for (const c of ledger) {
			for (const h of c.headings) {
				expect(['emitted', 'container', 'skipped']).toContain(h.disposition);
				if (h.disposition === 'skipped') expect((h as { reason?: string }).reason, `${h.locator}`).toBeTruthy();
			}
			expect(c.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});
