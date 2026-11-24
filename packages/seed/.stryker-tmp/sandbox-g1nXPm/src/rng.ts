/**
 * Deterministic PRNG for `@ktb/seed` — mulberry32, a tiny 32-bit
 * generator. Chosen over a dependency (faker/seedrandom/pure-rand) to
 * keep the package dependency-free and workerd-safe.
 *
 * NOT cryptographically secure — this is for synthetic test/demo data
 * only. Do not use for tokens, keys or anything security-relevant.
 */
// @ts-nocheck


/** xmur3 string hash — turns a string seed into four 32-bit ints. */function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
const xmur3 = (str: string): () => number => {
  if (stryMutAct_9fa48("2297")) {
    {}
  } else {
    stryCov_9fa48("2297");
    let h = 1779033703 ^ str.length;
    for (let i = 0; stryMutAct_9fa48("2300") ? i >= str.length : stryMutAct_9fa48("2299") ? i <= str.length : stryMutAct_9fa48("2298") ? false : (stryCov_9fa48("2298", "2299", "2300"), i < str.length); stryMutAct_9fa48("2301") ? i-- : (stryCov_9fa48("2301"), i++)) {
      if (stryMutAct_9fa48("2302")) {
        {}
      } else {
        stryCov_9fa48("2302");
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = h << 13 | h >>> 19;
      }
    }
    return () => {
      if (stryMutAct_9fa48("2303")) {
        {}
      } else {
        stryCov_9fa48("2303");
        h = Math.imul(h ^ h >>> 16, 2246822507);
        h = Math.imul(h ^ h >>> 13, 3266489909);
        return (h ^= h >>> 16) >>> 0;
      }
    };
  }
};

/**
 * Create a deterministic `() => number` in `[0, 1)`. The same seed
 * (string or 32-bit int) always produces the same stream.
 */
export const makeRng = (seed: string | number = 0): () => number => {
  if (stryMutAct_9fa48("2304")) {
    {}
  } else {
    stryCov_9fa48("2304");
    let state = (stryMutAct_9fa48("2307") ? typeof seed !== "string" : stryMutAct_9fa48("2306") ? false : stryMutAct_9fa48("2305") ? true : (stryCov_9fa48("2305", "2306", "2307"), typeof seed === (stryMutAct_9fa48("2308") ? "" : (stryCov_9fa48("2308"), "string")))) ? (xmur3(seed)() ^ Math.imul(xmur3(stryMutAct_9fa48("2309") ? `` : (stryCov_9fa48("2309"), `${seed}#2`))(), 0x9e3779b1)) >>> 0 : seed >>> 0;
    return () => {
      if (stryMutAct_9fa48("2310")) {
        {}
      } else {
        stryCov_9fa48("2310");
        state = (stryMutAct_9fa48("2311") ? state - 0x6d2b79f5 : (stryCov_9fa48("2311"), state + 0x6d2b79f5)) | 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= stryMutAct_9fa48("2312") ? t - Math.imul(t ^ t >>> 7, t | 61) : (stryCov_9fa48("2312"), t + Math.imul(t ^ t >>> 7, t | 61));
        return stryMutAct_9fa48("2313") ? ((t ^ t >>> 14) >>> 0) * 4294967296 : (stryCov_9fa48("2313"), ((t ^ t >>> 14) >>> 0) / 4294967296);
      }
    };
  }
};

/** Uniform integer in the inclusive range [lo, hi]. */
export const int = stryMutAct_9fa48("2314") ? () => undefined : (stryCov_9fa48("2314"), (() => {
  const int = (rng: () => number, lo: number, hi: number): number => stryMutAct_9fa48("2315") ? lo - Math.floor(rng() * (hi - lo + 1)) : (stryCov_9fa48("2315"), lo + Math.floor(stryMutAct_9fa48("2316") ? rng() / (hi - lo + 1) : (stryCov_9fa48("2316"), rng() * (stryMutAct_9fa48("2317") ? hi - lo - 1 : (stryCov_9fa48("2317"), (stryMutAct_9fa48("2318") ? hi + lo : (stryCov_9fa48("2318"), hi - lo)) + 1)))));
  return int;
})());

/** Uniform pick from a non-empty array. */
export const pick = stryMutAct_9fa48("2319") ? () => undefined : (stryCov_9fa48("2319"), (() => {
  const pick = <T,>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
  return pick;
})());

/** True with probability `p` (0..1). */
export const chance = stryMutAct_9fa48("2320") ? () => undefined : (stryCov_9fa48("2320"), (() => {
  const chance = (rng: () => number, p: number): boolean => stryMutAct_9fa48("2324") ? rng() >= p : stryMutAct_9fa48("2323") ? rng() <= p : stryMutAct_9fa48("2322") ? false : stryMutAct_9fa48("2321") ? true : (stryCov_9fa48("2321", "2322", "2323", "2324"), rng() < p);
  return chance;
})());