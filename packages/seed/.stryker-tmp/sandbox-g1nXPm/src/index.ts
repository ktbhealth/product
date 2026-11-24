/**
 * `@ktb/seed` — deterministic, schema-driven synthetic data generation
 * against the `@ktb/json-schema` subset profile.
 *
 * Pure library, no Effect service, no registry contributions. See
 * generate.ts for the per-keyword generation strategy and
 * pattern.ts for the regex-subset generator.
 */
// @ts-nocheck


export { SeedError } from "./errors.ts";
export { makeRng, int, pick, chance } from "./rng.ts";
export { generate, generateMany, generateRecord, DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES, MAX_GENERATE_MANY } from "./generate.ts";
export type { GenerateOptions } from "./generate.ts";
export { poolsFor, type LocalePools } from "./pools.ts";
export { generateFromPattern, patternHasUnsafeRepetition } from "./pattern.ts";