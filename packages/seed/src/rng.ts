/**
 * Deterministic PRNG for `@ktb/seed` — mulberry32, a tiny 32-bit
 * generator. Chosen over a dependency (faker/seedrandom/pure-rand) to
 * keep the package dependency-free and workerd-safe.
 *
 * NOT cryptographically secure — this is for synthetic test/demo data
 * only. Do not use for tokens, keys or anything security-relevant.
 */

/** xmur3 string hash — turns a string seed into four 32-bit ints. */
const xmur3 = (str: string): (() => number) => {
	let h = 1779033703 ^ str.length;
	for (let i = 0; i < str.length; i++) {
		h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	return () => {
		h = Math.imul(h ^ (h >>> 16), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		return (h ^= h >>> 16) >>> 0;
	};
};

/**
 * Create a deterministic `() => number` in `[0, 1)`. The same seed
 * (string or 32-bit int) always produces the same stream.
 */
export const makeRng = (seed: string | number = 0): (() => number) => {
	let state =
		typeof seed === "string"
			? (xmur3(seed)() ^ Math.imul(xmur3(`${seed}#2`)(), 0x9e3779b1)) >>> 0
			: seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** Uniform integer in the inclusive range [lo, hi]. */
export const int = (rng: () => number, lo: number, hi: number): number =>
	lo + Math.floor(rng() * (hi - lo + 1));

/** Uniform pick from a non-empty array. */
export const pick = <T>(rng: () => number, items: readonly T[]): T =>
	items[Math.floor(rng() * items.length)] as T;

/** True with probability `p` (0..1). */
export const chance = (rng: () => number, p: number): boolean => rng() < p;
