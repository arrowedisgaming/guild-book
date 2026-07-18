import { describe, expect, it } from 'vitest';
import { canonicalDigest, canonicalJsonStringify, sha256Hex } from '$lib/server/content/canonical-json';

describe('canonicalJsonStringify', () => {
	it('is independent of object key order', () => {
		const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
		const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
		expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
	});

	it('preserves array element order', () => {
		expect(canonicalJsonStringify([1, 2, 3])).not.toBe(canonicalJsonStringify([3, 2, 1]));
	});

	it('sorts keys inside array elements too', () => {
		const value = [{ b: 1, a: 2 }];
		expect(canonicalJsonStringify(value)).toBe('[{"a":2,"b":1}]');
	});

	it('round-trips primitives unchanged', () => {
		expect(canonicalJsonStringify(null)).toBe('null');
		expect(canonicalJsonStringify(42)).toBe('42');
		expect(canonicalJsonStringify('x')).toBe('"x"');
	});
});

describe('sha256Hex', () => {
	it('matches the known SHA-256 of the empty string', () => {
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});
});

describe('canonicalDigest', () => {
	it('is stable across differently-ordered but equal input', () => {
		const first = canonicalDigest({ b: 1, a: 2 });
		const second = canonicalDigest({ a: 2, b: 1 });
		expect(first).toBe(second);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
	});

	it('changes when the value changes', () => {
		expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
	});
});
