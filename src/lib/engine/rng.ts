/**
 * Seedable pseudo-random number generator + shuffle. Deterministic given a
 * seed, so a shuffle can be reproduced (shared draws, tests) rather than being
 * one-shot like Math.random. Pure — no side effects.
 */

export type Rng = () => number;

/** Hash an arbitrary string seed into a 32-bit integer. */
function hashSeed(seed: string): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	}
	return h >>> 0;
}

/**
 * mulberry32 — a small, fast, well-distributed PRNG. Returns a function that
 * yields floats in [0, 1). Same seed → same sequence.
 */
export function makeRng(seed: string | number): Rng {
	let a = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher–Yates shuffle into a NEW array (does not mutate the input). */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
