import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import manifestJson from '../../scripts/content-import/manifest/tarot-procedures-md.json';
import type { TarotSourceRef } from '$lib/types/content-pack';

/**
 * The manifest is the authoring surface, not the runtime contract: entries carry
 * an audit-only `rationale`, and unsupported entries have no steps. TypeScript
 * infers a wide union from the JSON, so it is read through the shape the audit
 * actually asserts on. The runtime shape is validated by Zod in
 * tarot-procedures.test.ts.
 */
type ManifestStep = { id: string; operation: string; lookupTableId?: string };
type ManifestEntry = {
	id: string;
	title: string;
	scope: string;
	source: TarotSourceRef;
	invokedFrom?: TarotSourceRef[];
	rationale?: string;
	ruleEntryIds: string[];
	steps: ManifestStep[];
};
const manifest = manifestJson as unknown as {
	entries: ManifestEntry[];
	lookupTables: { id: string }[];
};

/**
 * The audit manifest is the scope contract: every in-session tarot rule is
 * enumerated exactly once and classified. Review of this finite list is what
 * "v1 completeness" means — the product makes no claim over unenumerated prose.
 */
const REQUIRED_V1 = [
	'test-of-fate',
	'group-test',
	'test-augury',
	'challenge-round',
	'challenge-black-honey',
	'challenge-stun',
	'challenge-brainfever',
	'challenge-counsel',
	'challenge-guardian-angel',
	'challenge-aim',
	'challenge-guard',
	'crawl-meatgrinder',
	'crawl-were-doomed',
	'crawl-area-sense',
	'denizen-disposition',
	'camp-watch',
	'camp-patrol',
	'camp-high-chant',
	'camp-leeches',
	'overland-travel',
	'city-events',
	'city-signs-and-portents',
	'city-beg-and-busk',
	'city-carouse',
	'city-doomsaying',
	'city-strange-communions',
	'city-as-above-so-below',
	'oracle-maleficence',
	'oracle-malediction',
	'oracle-random-totem',
	'gm-twist'
] as const;

const SCOPES = ['supported-v1', 'deferred-preparation', 'not-applicable-non-tarot'];

const sourceKey = (source: TarotSourceRef) =>
	JSON.stringify([source.file, source.heading ?? null, source.after ?? null, source.anchor ?? null]);

describe('tarot procedure audit manifest', () => {
	const ids = manifest.entries.map((e) => e.id);

	it('classifies every required v1 procedure exactly once', () => {
		expect(new Set(ids).size).toBe(ids.length);
		const missing = REQUIRED_V1.filter((id) => !ids.includes(id));
		expect(missing).toEqual([]);
	});

	it('marks every required v1 procedure as supported', () => {
		for (const id of REQUIRED_V1) {
			const entry = manifest.entries.find((e) => e.id === id);
			expect(entry?.scope, id).toBe('supported-v1');
		}
	});

	it('keeps preparation tools out of supported v1 scope', () => {
		const jobBoard = manifest.entries.find((e) => e.id === 'city-job-board');
		expect(jobBoard?.scope).toBe('deferred-preparation');
	});

	it('gives every entry a valid scope and a source', () => {
		for (const entry of manifest.entries) {
			expect(SCOPES, entry.id).toContain(entry.scope);
			expect(entry.source.file, entry.id).toMatch(/\.md$/);
			// A rule with no heading of its own must name a bullet anchor instead.
			expect(Boolean(entry.source.heading || entry.source.anchor), entry.id).toBe(true);
		}
	});

	it('gives every supported procedure non-empty, unique invocation evidence', () => {
		for (const entry of manifest.entries) {
			if (entry.scope !== 'supported-v1') continue;
			expect(entry.invokedFrom?.length ?? 0, entry.id).toBeGreaterThan(0);
			const keys = entry.invokedFrom!.map(sourceKey);
			expect(new Set(keys).size, `${entry.id} duplicate invokedFrom`).toBe(keys.length);
			for (const ref of entry.invokedFrom!) {
				expect(ref.file, entry.id).toMatch(/\.md$/);
				expect(Boolean(ref.heading || ref.anchor), entry.id).toBe(true);
			}
		}
	});

	it('gives every non-supported entry a rationale', () => {
		for (const entry of manifest.entries) {
			if (entry.scope === 'supported-v1') continue;
			expect(entry.rationale?.length ?? 0, `${entry.id} needs a rationale`).toBeGreaterThan(0);
		}
	});

	it('gives every supported entry at least one step, and unsupported entries none', () => {
		for (const entry of manifest.entries) {
			if (entry.scope === 'supported-v1') {
				expect(entry.steps.length, `${entry.id}`).toBeGreaterThan(0);
			} else {
				expect(entry.steps.length, `${entry.id} is audit-only`).toBe(0);
			}
		}
	});

	it('cites a real rules entry wherever one exists', () => {
		const known = new Set(
			(
				JSON.parse(readFileSync('static/content-packs/hmtw/rules.json', 'utf8')) as {
					id: string;
				}[]
			).map((r) => r.id)
		);
		for (const entry of manifest.entries) {
			for (const id of entry.ruleEntryIds) {
				expect(known.has(id), `${entry.id} cites ${id}`).toBe(true);
			}
		}
	});

	it('keeps the manual 50 percent choice manual', () => {
		const manual = manifest.entries
			.flatMap((e) => e.steps)
			.filter((s) => s.id === 'flat-fifty-percent-choice');
		expect(manual.length).toBeGreaterThan(0);
		for (const step of manual) expect(step.operation).toBe('manual-choice');
	});

	it('resolves every declared lookupTableId to a declared table', () => {
		const tableIds = new Set(manifest.lookupTables.map((t) => t.id));
		for (const entry of manifest.entries) {
			for (const step of entry.steps) {
				if (step.lookupTableId) expect(tableIds.has(step.lookupTableId), step.lookupTableId).toBe(true);
			}
		}
	});
});
