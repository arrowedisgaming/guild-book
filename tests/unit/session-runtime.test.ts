import { describe, expect, it } from 'vitest';
import {
	compileSessionRuntimeContent,
	parseSessionRuntimeContent,
	toCardCatalog,
	toSessionEngineRuntime,
	MAX_SESSION_RUNTIME_CONTENT_BYTES
} from '$lib/server/content/session-runtime';
import { sessionRuntimeContentV1Schema } from '$lib/schemas/session-runtime.schema';
import { getContentPack, getRules, getTarotProcedures } from '$lib/server/content/loader';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { reduceSession, type ReduceContext } from '$lib/engine/session/reducer';
import { makeRng } from '$lib/engine/rng';
import { makeSessionFixture } from '../fixtures/session';
import type { SessionActor } from '$lib/types/session';

describe('compileSessionRuntimeContent — determinism, digest, size', () => {
	it('produces a deeply-equal document with the same content digest on repeated calls', () => {
		const first = compileSessionRuntimeContent();
		const second = compileSessionRuntimeContent();
		expect(first).toEqual(second);
		expect(first.contentDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(second.contentDigest).toBe(first.contentDigest);
	});

	it('fits well inside the D1 row-size bound', () => {
		const content = compileSessionRuntimeContent();
		expect(new TextEncoder().encode(JSON.stringify(content)).byteLength).toBeLessThan(1_900_000);
		expect(MAX_SESSION_RUNTIME_CONTENT_BYTES).toBe(1_900_000);
	});

	it('changes the digest when the compiled content changes', () => {
		const pack = getContentPack();
		const proceduresFile = getTarotProcedures();
		const mutatedPack = { ...pack, tarot: { ...pack.tarot, handSize: pack.tarot.handSize + 1 } };

		const original = compileSessionRuntimeContent({ pack, proceduresFile });
		const mutated = compileSessionRuntimeContent({ pack: mutatedPack, proceduresFile });

		expect(mutated.contentDigest).not.toBe(original.contentDigest);
	});
});

describe('compileSessionRuntimeContent — scope', () => {
	it('carries exactly the documented top-level fields, no speculative ones', () => {
		const content = compileSessionRuntimeContent();
		expect(Object.keys(content).sort()).toEqual(
			[
				'cards',
				'contentDigest',
				'contentPackId',
				'contentPackVersion',
				'formulas',
				'lookupTables',
				'modifiers',
				'procedures',
				'schemaVersion',
				'tarot'
			].sort()
		);
	});

	/**
	 * Spec §6.4 is normative over the plan's original Step 2 shape: the
	 * runtime document carries "the tarot config, procedure definitions,
	 * modifiers, and lookup tables the session needs" — a pinned snapshot is
	 * immutable, so Increment 3's procedure runner needs the oracle tables
	 * and formula params to travel with the pin, not be fetched from the
	 * live bundle later. Taken whole (no subsetting filter): Increment 0b
	 * already generated `lookupTables`/`formulas` scoped to the same
	 * procedure set as `procedures`/`modifiers`.
	 */
	it('includes the full lookup-table and formula catalogs verbatim (spec §6.4)', () => {
		const content = compileSessionRuntimeContent();
		const proceduresFile = getTarotProcedures();
		expect(content.lookupTables).toEqual(proceduresFile.lookupTables);
		expect(content.formulas).toEqual(proceduresFile.formulas);
		expect(content.lookupTables.length).toBeGreaterThan(0);
		expect(content.formulas.length).toBeGreaterThan(0);
	});

	it('excludes rule content unrelated to live procedures (e.g. the rules-reference collection)', () => {
		const content = compileSessionRuntimeContent();
		const serialized = JSON.stringify(content);
		// A rules-reference entry's body is prose for the browsable rules
		// section, not state a live command resolves against — it must not
		// leak into the compiled document via some other path.
		const rulesEntry = getRules().find((entry) => entry.body.length > 20);
		expect(rulesEntry).toBeTruthy();
		expect(serialized.includes(rulesEntry!.body)).toBe(false);
		expect(content).not.toHaveProperty('kiths');
		expect(content).not.toHaveProperty('denizens');
		expect(content).not.toHaveProperty('spells');
	});

	it('includes the full 78-card catalog (21 majors + 56 minors + the Fool)', () => {
		const content = compileSessionRuntimeContent();
		expect(content.cards).toHaveLength(78);
		expect(content.cards.filter((c) => c.deck === 'major')).toHaveLength(21);
		expect(content.cards.filter((c) => c.deck === 'player')).toHaveLength(57);
	});

	it('carries the pack id/version pinned at compile time', () => {
		const content = compileSessionRuntimeContent();
		const pack = getContentPack();
		expect(content.contentPackId).toBe(pack.id);
		expect(content.contentPackVersion).toBe(pack.version);
	});
});

describe('validate before insert and after read', () => {
	it('the compiled document parses cleanly against the schema (pre-insert gate)', () => {
		const content = compileSessionRuntimeContent();
		expect(() => sessionRuntimeContentV1Schema.parse(content)).not.toThrow();
	});

	it('re-validates a JSON round trip identically (post-read gate)', () => {
		const content = compileSessionRuntimeContent();
		const roundTripped = JSON.parse(JSON.stringify(content));
		const reparsed = parseSessionRuntimeContent(roundTripped);
		expect(reparsed).toEqual(content);
	});

	it('rejects a document that fails schema validation', () => {
		const content = compileSessionRuntimeContent();
		const corrupted = { ...content, schemaVersion: 2 };
		expect(() => parseSessionRuntimeContent(corrupted)).toThrow();
	});

	it('rejects a document at or above the size bound', () => {
		const content = compileSessionRuntimeContent();
		const bloated = { ...content, cards: [...content.cards, ...content.cards.map((c, i) => ({ ...c, id: `${c.id}-padding-${'x'.repeat(50_000)}-${i}` }))] };
		expect(() => parseSessionRuntimeContent(bloated)).toThrow(/bytes/);
	});
});

describe('adapter — satisfies the engine\'s ReduceContext.runtime', () => {
	it('toCardCatalog + assertSessionInvariants accepts a freshly-dealt session', () => {
		const content = compileSessionRuntimeContent();
		const catalog = toCardCatalog(content.cards);
		expect(() => assertSessionInvariants(makeSessionFixture(), catalog)).not.toThrow();
	});

	it('toSessionEngineRuntime lets reduceSession process a real command', () => {
		const content = compileSessionRuntimeContent();
		const gm: SessionActor = { kind: 'gm', userId: 'gm-1' };
		const context: ReduceContext = {
			actor: gm,
			runtime: toSessionEngineRuntime(content),
			rng: makeRng('session-runtime-test')
		};
		const result = reduceSession(
			makeSessionFixture(),
			{ type: 'draw', deck: 'major', destinationZoneId: 'gmHand', count: 1 },
			context
		);
		expect(result.ok).toBe(true);
	});
});
