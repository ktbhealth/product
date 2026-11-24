/**
 * Core schema-driven value generator for `@ktb/seed`.
 *
 * `generate(schema, opts)` produces ONE JSON value that satisfies a
 * `@ktb/json-schema` subset schema. Generation is deterministic for a
 * given seed and NEVER silently emits non-conforming data: unsupported
 * features (`not`, unparseable `pattern`s, conflicting `allOf` merges,
 * exhausted budgets) throw {@link SeedError}.
 *
 * Generation strategy per keyword:
 * - `const` / `enum` → returned verbatim / uniform pick (checked first,
 *   so they win over every other constraint).
 * - `type` → dispatch; an array of types picks one uniformly. When
 *   `type` is absent the generator INFERS it from sibling keywords
 *   (`properties`→object, `items`→array, `pattern`/`minLength`→string,
 *   `minimum`/`maximum`→number), defaulting to string.
 * - `string` → `pattern` goes through a small regex-subset generator
 *   (see pattern.ts) verified against the real `RegExp` with retries.
 *   Patterns whose repetition can trigger catastrophic backtracking
 *   (`(a|aa)+b`-style — see `patternHasUnsafeRepetition`) are rejected
 *   UP FRONT with SeedError: the verify `RegExp.test` is synchronous
 *   and uninterruptible, so screening is the only hang-proof option.
 *   Schemas are TRUSTED input (dev/test tooling) — the screen is
 *   defense in depth, not a security boundary. Without `pattern`,
 *   FIELD-NAME heuristics pick realistic locale-aware pools
 *   (name/email/cpf/phone/cep/url/date…), then `minLength`/`maxLength`
 *   are enforced by padding/trimming.
 * - `number`/`integer` → uniform in [`minimum` ?? 0, `maximum` ??
 *   min+100]; integers are rounded into [ceil(min), floor(max)].
 * - `boolean` → 50/50. `default` is an ANNOTATION and does NOT bias
 *   generation (documented choice — defaults describe missing-value
 *   fallbacks, not a distribution).
 * - `array` → length in [`minItems` ?? 0, `maxItems` ?? min+3],
 *   `items` recursed (`items:false` → empty array only).
 * - `object` → all `properties` (or only `required` with
 *   `requiredOnly`), `minProperties`/`maxProperties` enforced,
 *   `additionalProperties:false` → fixed shape, a subschema → a few
 *   extra keys (capped).
 * - `$ref` → internal JSON pointers resolved against the document
 *   root; siblings are merged (2020-12 semantics).
 * - `allOf` → branches merged into one effective schema (bounds take
 *   the stricter side, `enum`s intersect, conflicting `pattern`s or
 *   `const`s → SeedError) then generated once — this keeps EVERY
 *   constraint satisfied, unlike generate-and-merge.
 * - `anyOf`/`oneOf` → one branch picked uniformly and merged with the
 *   sibling keywords. When BOTH sides of a merge carry the same
 *   combinator (e.g. nested `allOf`), branches are distributed into
 *   the cross product `⋁(ai ∧ bj)` — capped at 64 pairs. Caveat:
 *   `oneOf` is best-effort — a generated value could accidentally
 *   satisfy a second branch (documented).
 * - `not` → always SeedError (can't generate the complement reliably).
 * - Boolean schemas: `true` → a random scalar; `false` → SeedError.
 */

import { validate } from "@ktb/json-schema";
import type { JsonSchema, JsonSchemaObject } from "@ktb/json-schema";

import { SeedError } from "./errors.ts";
import { generateFromPattern, patternHasUnsafeRepetition } from "./pattern.ts";
import { poolsFor, type LocalePools } from "./pools.ts";
import { chance, int, makeRng, pick } from "./rng.ts";

/** Default recursion depth for nested subschemas. */
export const DEFAULT_MAX_DEPTH = 8;
/** Default node budget — mirrors json-schema's MAX_SCHEMA_NODES scale. */
export const DEFAULT_MAX_NODES = 2048;
/** Pattern generation attempts before giving up. */
const PATTERN_ATTEMPTS = 25;
/** Cap on `additionalProperties` keys generated per object. */
const MAX_EXTRA_KEYS = 3;

export interface GenerateOptions {
	/** Deterministic PRNG — wins over `seed` when both are given. */
	readonly rng?: () => number;
	/** Seed for the built-in mulberry32 PRNG (string or 32-bit int). */
	readonly seed?: string | number;
	/** BCP-47-ish locale tag ("pt-BR", "en", …) selecting string pools. */
	readonly locale?: string;
	/** Only generate `required` object properties (default false → all). */
	readonly requiredOnly?: boolean;
	/** Max subschema recursion depth (default {@link DEFAULT_MAX_DEPTH}). */
	readonly depth?: number;
	/** Max generator invocations per call (default {@link DEFAULT_MAX_NODES}). */
	readonly maxNodes?: number;
	/**
	 * When true, run the result through `@ktb/json-schema`'s `validate`
	 * before returning and throw SeedError on any issue. Costs one
	 * validation per call — intended for tests/dev, off by default.
	 */
	readonly assertValid?: boolean;
}

interface Ctx {
	readonly rng: () => number;
	readonly pools: LocalePools;
	readonly root: JsonSchema;
	readonly requiredOnly: boolean;
	readonly path: string;
	/** Remaining subschema depth. */
	depth: number;
	/** Remaining node budget. */
	nodes: { left: number };
	/** Last object-property name — drives string heuristics. */
	readonly key?: string;
}

const isObj = (v: unknown): v is JsonSchemaObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

// Stryker disable next-line ConditionalExpression,LogicalOperator: every surviving variant still ends in structuredClone (or returns an equal primitive), which is value-identical for all JSON inputs — only object identity differs, and primitives have none.
const clone = <T>(v: T): T => (v === null || typeof v !== "object" ? v : structuredClone(v));

/** RFC 6901 escape for error paths. */
const ptrEscape = (seg: string): string => seg.replace(/~/g, "~0").replace(/\//g, "~1");

/** Resolve an internal `$ref` ("#" or "#/a/b") against the root schema. */
const resolvePointer = (root: unknown, ref: string): unknown => {
	if (ref === "#") return root;
	let cur: unknown = root;
	for (const raw of ref.slice(2).split("/")) {
		const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(cur)) {
			if (!/^\d+$/.test(seg)) return undefined;
			cur = cur[Number(seg)];
			// Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,StringLiteral: for non-array cur, isObj(cur) implies typeof cur === "object", so every variant coincides with `typeof cur === "object"` up to null (undefined either way) and primitives (hasOwn fails → undefined, or a string index yields a char that deref rejects with the same unresolvable-$ref SeedError). Probe-verified identical.
		} else if (isObj(cur) || typeof cur === "object") {
			if (cur === null || !Object.hasOwn(cur, seg)) return undefined;
			cur = (cur as Record<string, unknown>)[seg];
		} else {
			return undefined;
		}
	}
	return cur;
};

const jsonEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	// Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: the check above already returned false when arrayness differs, so && and || coincide; skipping or emptying this fast path falls through to the key-wise comparison, which is equivalent for dense JSON arrays (Object.keys of an array are exactly its indices).
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const ak = Object.keys(ao);
	const bk = Object.keys(bo);
	return (
		ak.length === bk.length && ak.every((k) => Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k]))
	);
};

const normTypes = (t: JsonSchemaObject["type"]): readonly string[] | null => {
	if (t === undefined) return null;
	// Array.isArray doesn't narrow `readonly T[]` unions — cast the
	// single-type arm explicitly.
	return Array.isArray(t) ? [...t] : [t as string];
};

/**
 * AND-merge two schemas into one effective schema. Throws SeedError on
 * contradictions (empty type/enum intersection, conflicting consts or
 * patterns, inverted bounds). Used for `allOf`, `$ref` siblings and
 * combinator+rest merges.
 */
const mergeObjects = (a: JsonSchemaObject, b: JsonSchemaObject, ctx: Ctx): JsonSchemaObject => {
	const out: Record<string, unknown> = { ...a };

	// --- type: intersect ---
	const ta = normTypes(a.type);
	const tb = normTypes(b.type);
	if (ta && tb) {
		const inter = ta.filter((t) => tb.includes(t));
		if (inter.length === 0) throw new SeedError("allOf branches have disjoint types", ctx.path);
		// Stryker disable next-line ConditionalExpression: type "x" and ["x"] are interchangeable — normTypes normalizes both to the same list before generation.
		out.type = inter.length === 1 ? inter[0] : inter;
	} else if (tb) {
		out.type = b.type;
	}

	// --- const / enum ---
	const aHasConst = Object.hasOwn(a, "const");
	const bHasConst = Object.hasOwn(b, "const");
	if (aHasConst && bHasConst && !jsonEqual(a.const, b.const)) {
		throw new SeedError("conflicting const values", ctx.path);
	}
	if (bHasConst) out.const = b.const;
	if (a.enum && b.enum) {
		// Stryker disable next-line OptionalChaining: the `a.enum && b.enum` guard above guarantees b.enum is defined here.
		const inter = a.enum.filter((v) => b.enum?.some((w) => jsonEqual(v, w)));
		if (inter.length === 0) throw new SeedError("empty enum intersection", ctx.path);
		out.enum = inter;
	} else if (b.enum) {
		out.enum = b.enum;
	}

	// --- scalar bounds: stricter wins ---
	const LOWER_KEYS = ["minimum", "minLength", "minItems", "minProperties"] as const;
	const UPPER_KEYS = ["maximum", "maxLength", "maxItems", "maxProperties"] as const;
	for (const k of LOWER_KEYS) {
		const av = a[k];
		const bv = b[k];
		// Stryker disable next-line ConditionalExpression: when bv is undefined the skipped assignment would compute Math.max(av, -Infinity) === av — already present via the {...a} spread.
		if (av !== undefined || bv !== undefined) out[k] = Math.max(av ?? -Infinity, bv ?? -Infinity);
	}
	for (const k of UPPER_KEYS) {
		const av = a[k];
		const bv = b[k];
		// Stryker disable next-line ConditionalExpression: when bv is undefined the skipped assignment would compute Math.min(av, Infinity) === av — already present via the {...a} spread.
		if (av !== undefined || bv !== undefined) out[k] = Math.min(av ?? Infinity, bv ?? Infinity);
	}
	// Cross-check the bound pairs we just tightened.
	const pairs: ReadonlyArray<readonly [string, string]> = [
		["minimum", "maximum"],
		["minLength", "maxLength"],
		["minItems", "maxItems"],
		["minProperties", "maxProperties"],
	];
	for (const [lo, hi] of pairs) {
		const lv = out[lo] as number | undefined;
		const hv = out[hi] as number | undefined;
		// Stryker disable next-line ConditionalExpression: each variant still reduces to `lv > hv` plus redundant definedness checks — any comparison against undefined is false, so the guards cannot change the outcome.
		if (lv !== undefined && hv !== undefined && lv > hv) {
			throw new SeedError(`inverted bounds: ${lo} > ${hi}`, ctx.path);
		}
	}

	// --- pattern: at most one distinct source ---
	if (b.pattern !== undefined) {
		if (a.pattern !== undefined && a.pattern !== b.pattern) {
			throw new SeedError("conflicting patterns cannot be merged", ctx.path);
		}
		out.pattern = b.pattern;
	}

	// --- object keywords ---
	if (b.properties) {
		const merged: Record<string, JsonSchema> = { ...(a.properties ?? {}) };
		for (const [k, v] of Object.entries(b.properties)) {
			const prev = merged[k];
			merged[k] = prev === undefined ? v : (mergeTwo(prev, v, ctx) as JsonSchema);
		}
		out.properties = merged;
	}
	if (b.required) {
		out.required = [...new Set([...(a.required ?? []), ...b.required])];
	}
	// Stryker disable next-line ConditionalExpression: entering with bv === undefined makes every arm converge to av (or undefined, equivalent to absent) — additionalProperties stays a's either way.
	if (b.additionalProperties !== undefined) {
		const av = a.additionalProperties;
		const bv = b.additionalProperties;
		// Stryker disable next-line LogicalOperator,ConditionalExpression: whenever either side is false the remaining arms still produce false — mergeTwo(x, false) === false and the true/undefined arms assign the false side — so the explicit check is redundant.
		if (av === false || bv === false) {
			out.additionalProperties = false;
			// Stryker disable next-line ConditionalExpression,BooleanLiteral: reached only when av is not false; for av === true every remaining arm yields bv or true — identical to taking bv.
		} else if (av === undefined || av === true) {
			out.additionalProperties = bv;
			// Stryker disable next-line ConditionalExpression,LogicalOperator,BooleanLiteral,BlockStatement: reached only when bv is defined and not false, so `bv === undefined` is always false; for bv === true the fallthrough mergeTwo(av, true) === av — identical to the assignment.
		} else if (bv === undefined || bv === true) {
			out.additionalProperties = av;
		} else {
			out.additionalProperties = mergeTwo(av, bv, ctx);
		}
	}

	// --- array keyword ---
	if (b.items !== undefined) {
		out.items = a.items === undefined ? b.items : mergeTwo(a.items, b.items, ctx);
	}

	// --- combinators ---
	// allOf concatenates freely (associative). anyOf/oneOf appearing on
	// BOTH sides must be AND-ed, which is NOT a union — distribute into
	// the cross product anyOf(ai ∧ bj) so every pair constraint holds.
	// (oneOf keeps its documented exactly-one caveat.)
	if (a.allOf || b.allOf) {
		out.allOf = [...(a.allOf ?? []), ...(b.allOf ?? [])];
	}
	for (const k of ["anyOf", "oneOf"] as const) {
		const av = a[k];
		const bv = b[k];
		if (av?.length && bv?.length) {
			if (av.length * bv.length > 64) {
				throw new SeedError(`combinator product too large (${av.length}×${bv.length})`, ctx.path);
			}
			const combos: JsonSchema[] = [];
			for (const x of av) {
				for (const y of bv) {
					try {
						combos.push(mergeTwo(x, y, ctx));
					} catch {
						// Incompatible pair — it can never be satisfied, so
						// dropping it preserves semantics.
					}
				}
			}
			if (combos.length === 0) {
				throw new SeedError(`no satisfiable ${k} combination`, ctx.path);
			}
			out[k] = combos;
		} else if (av || bv) {
			out[k] = [...(av ?? []), ...(bv ?? [])];
		}
	}
	// not(A) AND not(B) === not(A or B)
	if (a.not !== undefined && b.not !== undefined) {
		out.not = { anyOf: [a.not, b.not] };
	} else if (b.not !== undefined) {
		out.not = b.not;
	}

	// --- annotations: keep a's, fall back to b's ---
	for (const k of ["$schema", "title", "description", "default", "$comment"] as const) {
		if (out[k] === undefined && b[k] !== undefined) out[k] = b[k];
	}

	return out as JsonSchemaObject;
};

const mergeTwo = (a: JsonSchema, b: JsonSchema, ctx: Ctx): JsonSchema => {
	const da = deref(a, ctx);
	const db = deref(b, ctx);
	if (da === true) return db;
	if (db === true) return da;
	if (da === false || db === false) return false;
	return mergeObjects(da, db, ctx);
};

/** Strip a set of keys, returning the rest as a schema object. */
const omitKeys = (s: JsonSchemaObject, keys: readonly string[]): JsonSchemaObject => {
	const out: Record<string, unknown> = { ...s };
	for (const k of keys) delete out[k];
	return out as JsonSchemaObject;
};

/** Resolve `$ref` chains (with sibling merge) until a plain schema. */
const deref = (schema: JsonSchema, ctx: Ctx): JsonSchema => {
	let s = schema;
	const seen = new Set<string>();
	while (isObj(s) && typeof s.$ref === "string") {
		if (seen.has(s.$ref)) throw new SeedError("recursive $ref", ctx.path);
		seen.add(s.$ref);
		const target = resolvePointer(ctx.root, s.$ref);
		if (
			target === undefined ||
			target === null ||
			(typeof target !== "object" && typeof target !== "boolean")
		) {
			throw new SeedError(`unresolvable $ref "${s.$ref}"`, ctx.path);
		}
		const siblings = omitKeys(s, ["$ref"]);
		const hasSiblings = Object.keys(siblings).length > 0;
		s = hasSiblings ? mergeTwo(target as JsonSchema, siblings, ctx) : (target as JsonSchema);
	}
	return s;
};

// ---------------------------------------------------------------------------
// Scalar generators
// ---------------------------------------------------------------------------

const EPOCH_1950 = Date.UTC(1950, 0, 1);

const isoDate = (rng: () => number): string =>
	new Date(EPOCH_1950 + rng() * (Date.now() - EPOCH_1950)).toISOString().slice(0, 10);

const isoDateTime = (rng: () => number): string =>
	new Date(EPOCH_1950 + rng() * (Date.now() - EPOCH_1950)).toISOString();

const uuid = (rng: () => number): string => {
	const hex = "0123456789abcdef";
	const seg = (n: number) => Array.from({ length: n }, () => hex[Math.floor(rng() * 16)]).join("");
	return `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`;
};

/** CPF with valid mod-11 check digits (pt-BR tax id). */
const cpf = (rng: () => number): string => {
	const digits = Array.from({ length: 9 }, () => Math.floor(rng() * 10));
	const dv = (nums: number[], weights: number[]): number => {
		const sum = nums.reduce((acc, d, i) => acc + d * weights[i], 0);
		const r = (sum * 10) % 11;
		return r === 10 ? 0 : r;
	};
	const w1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
	const d1 = dv(digits, w1);
	const w2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
	const d2 = dv([...digits, d1], w2);
	return [...digits, d1, d2].join("");
};

const phone = (pools: LocalePools, rng: () => number): string =>
	pools.phoneStyle === "br"
		? `(${int(rng, 11, 99)}) 9${int(rng, 1000, 9999)}-${int(rng, 1000, 9999)}`
		: `(${int(rng, 200, 999)}) ${int(rng, 200, 999)}-${int(rng, 1000, 9999)}`;

const postalCode = (pools: LocalePools, rng: () => number): string =>
	pools.countryCode === "BR"
		? `${int(rng, 10000, 99999)}-${int(rng, 100, 999)}`
		: `${int(rng, 10000, 99999)}`;

const email = (ctx: Ctx): string => {
	const first = slug(ctx.pools.firstNames[Math.floor(ctx.rng() * ctx.pools.firstNames.length)]);
	const last = slug(ctx.pools.lastNames[Math.floor(ctx.rng() * ctx.pools.lastNames.length)]);
	return `${first}.${last}${int(ctx.rng, 1, 99)}@${pick(ctx.rng, ctx.pools.emailDomains)}`;
};

const fullName = (ctx: Ctx): string => {
	const f = pick(ctx.rng, ctx.pools.firstNames);
	const l = pick(ctx.rng, ctx.pools.lastNames);
	return chance(ctx.rng, 0.3) ? `${f} ${l} ${pick(ctx.rng, ctx.pools.lastNames)}` : `${f} ${l}`;
};

const slug = (s: string): string =>
	s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");

const randomWords = (ctx: Ctx, count: number): string =>
	Array.from({ length: count }, () => pick(ctx.rng, ctx.pools.words)).join(" ");

/**
 * Field-name → realistic value heuristics. `key` is the object
 * property name (any case); matched loosely against pt-BR and en
 * vocabulary. Best-effort by design — `pattern`/`enum` constraints
 * still take precedence upstream.
 */
const stringForKey = (key: string, ctx: Ctx): string => {
	const k = key.toLowerCase();
	const { pools, rng } = ctx;

	if (k.includes("cpf")) return cpf(rng);
	if (k.includes("cnpj")) return Array.from({ length: 14 }, () => Math.floor(rng() * 10)).join("");
	if (k.includes("email") || k === "mail" || k.includes("emailaddress")) return email(ctx);
	if (k.includes("username") || k === "user" || k.includes("login") || k.includes("handle")) {
		return `${slug(pick(rng, pools.firstNames))}.${slug(pick(rng, pools.lastNames))}${int(rng, 1, 99)}`;
	}
	if (
		k.includes("phone") ||
		k.includes("telefone") ||
		k.includes("celular") ||
		k.includes("whatsapp") ||
		k === "tel" ||
		k.includes("mobile") ||
		k.includes("fax")
	) {
		return phone(pools, rng);
	}
	if (
		k.includes("cep") ||
		k.includes("postal") ||
		k.includes("postcode") ||
		k.includes("zipcode") ||
		k === "zip"
	) {
		return postalCode(pools, rng);
	}
	if (
		k.includes("url") ||
		k.includes("uri") ||
		k.includes("website") ||
		k.includes("homepage") ||
		k.includes("avatar") ||
		(k.includes("link") && !k.includes("unlink"))
	) {
		return `https://www.${pick(rng, pools.emailDomains)}/${pick(rng, pools.words)}`;
	}
	if (k.includes("birth") || k.includes("nascimento") || k === "dob") return isoDate(rng);
	// camelCase "…At" (createdAt), snake "…_at" or explicit timestamp —
	// deliberately NOT plain /at$/i so "format"/"that" don't match.
	if (/[A-Z]t$/.test(key) || /[_-]at$/.test(k) || k === "timestamp") return isoDateTime(rng);
	if (
		(k.includes("date") || k.includes("data")) &&
		!k.includes("update") &&
		!k.includes("candidate") &&
		!k.includes("validate") &&
		!k.includes("mandate")
	) {
		return isoDate(rng);
	}
	if (
		k.includes("filename") ||
		k.includes("file_name") ||
		k.includes("filepath") ||
		k.includes("filetype")
	) {
		return `${pick(rng, pools.words)}-${int(rng, 100, 9999)}`;
	}
	if (
		k.includes("firstname") ||
		k.includes("first_name") ||
		k.includes("givenname") ||
		k === "fname"
	) {
		return pick(rng, pools.firstNames);
	}
	if (
		k.includes("lastname") ||
		k.includes("last_name") ||
		k.includes("surname") ||
		k.includes("familyname") ||
		k === "lname"
	) {
		return pick(rng, pools.lastNames);
	}
	if (k.includes("socialname") || k.includes("nickname") || k.includes("apelido")) {
		return pick(rng, pools.firstNames);
	}
	if (
		k === "name" ||
		k === "nome" ||
		k.includes("fullname") ||
		k.endsWith("name") ||
		k.endsWith("nome")
	) {
		return fullName(ctx);
	}
	if (k.includes("city") || k.includes("cidade") || k.includes("town") || k.includes("municipio")) {
		return pick(rng, pools.cities);
	}
	if (k === "uf" || k === "state" || k.endsWith("state") || k.includes("estado")) {
		return pick(rng, pools.states);
	}
	if (
		k.includes("district") ||
		k.includes("bairro") ||
		k.includes("neighborhood") ||
		k.includes("suburb")
	) {
		return pick(rng, pools.neighborhoods);
	}
	// number before address so "addressNumber"/"streetNumber" → digits.
	if (k.includes("number") || k.includes("numero") || k === "num") {
		return String(int(rng, 1, 20000));
	}
	if (
		k.includes("address") ||
		k.includes("endereco") ||
		k.includes("logradouro") ||
		k.includes("street") ||
		k.includes("avenue")
	) {
		return `${pick(rng, ["Rua", "Avenida", "Travessa", "Alameda"])} ${pick(rng, pools.streets)}`;
	}
	if (k.includes("complement") || k.includes("complemento")) {
		return pools.phoneStyle === "br" ? `Apto ${int(rng, 1, 500)}` : `Apt ${int(rng, 1, 500)}`;
	}
	if (k.includes("country") || k === "pais" || k.includes("nationality")) return pools.countryCode;
	if (k.includes("gender") || k.includes("sexo") || k === "sex") {
		return pools.phoneStyle === "br"
			? pick(rng, ["F", "M"])
			: pick(rng, ["female", "male", "other"]);
	}
	if (k.includes("language") || k.includes("idioma") || k === "locale") return pools.localeTag;
	if (k.includes("currency")) return pools.countryCode === "BR" ? "BRL" : "USD";
	if (
		k === "id" ||
		// Stryker disable next-line ConditionalExpression,StringLiteral: k === "uuid" implies k.endsWith("uuid") below, so this disjunct can never change the OR result.
		k === "uuid" ||
		// Stryker disable next-line ConditionalExpression,StringLiteral: k === "guid" implies k.endsWith("guid") below, so this disjunct can never change the OR result.
		k === "guid" ||
		k === "uid" ||
		k.endsWith("_id") ||
		k.endsWith("uuid") ||
		k.endsWith("guid")
	) {
		return uuid(rng);
	}
	return randomWords(ctx, 1 + int(rng, 0, 2));
};

/** Enforce minLength/maxLength by padding with words / hard-trimming. */
const fitLength = (value: string, s: JsonSchemaObject, ctx: Ctx): string => {
	const min = s.minLength ?? 0;
	const max = s.maxLength;
	if (max !== undefined && min > max) {
		throw new SeedError(`minLength ${min} > maxLength ${max}`, ctx.path);
	}
	let out = value;
	if (max !== undefined && out.length > max) {
		out = out.slice(0, max).trimEnd();
	}
	let guard = 0;
	while (out.length < min && guard++ < 1000) {
		out = `${out} ${pick(ctx.rng, ctx.pools.words)}`;
	}
	if (out.length < min) throw new SeedError(`could not reach minLength ${min}`, ctx.path);
	if (max !== undefined && out.length > max) out = out.slice(0, max);
	return out;
};

const genString = (s: JsonSchemaObject, ctx: Ctx): string => {
	const min = s.minLength ?? 0;
	const max = s.maxLength;

	if (typeof s.pattern === "string") {
		// ReDoS screen BEFORE any candidate work: `re.test` below is a
		// synchronous, uninterruptible call — an alternation/nested-
		// quantifier repetition like `(a|aa)+b` can hang the event loop
		// on a near-miss candidate. Reject loudly instead (dev tooling:
		// a rare SeedError beats a hang-forever).
		if (patternHasUnsafeRepetition(s.pattern)) {
			throw new SeedError(
				`pattern /${s.pattern}/ has unsafe repetition (catastrophic backtracking risk)`,
				ctx.path,
			);
		}
		let re: RegExp;
		try {
			re = new RegExp(s.pattern);
		} catch {
			throw new SeedError(`invalid pattern /${s.pattern}/`, ctx.path);
		}
		const limit = max ?? 1024;
		let lastErr: unknown;
		for (let i = 0; i < PATTERN_ATTEMPTS; i++) {
			let cand: string;
			try {
				cand = generateFromPattern(s.pattern, ctx.rng, limit);
			} catch (e) {
				lastErr = e;
				continue;
			}
			if (cand.length >= min && (max === undefined || cand.length <= max) && re.test(cand)) {
				return cand;
			}
		}
		throw new SeedError(
			`could not generate a string matching /${s.pattern}/ (${lastErr instanceof Error ? lastErr.message : "no candidate verified"})`,
			ctx.path,
		);
	}

	const raw = stringForKey(ctx.key ?? "", ctx);
	return fitLength(raw, s, ctx);
};

const genNumber = (s: JsonSchemaObject, isInt: boolean, ctx: Ctx): number => {
	const lo = s.minimum ?? 0;
	const hi = s.maximum ?? lo + 100;
	if (isInt) {
		const ilo = Math.ceil(lo);
		const ihi = Math.floor(hi);
		if (ihi < ilo) throw new SeedError(`no integer in [${lo}, ${hi}]`, ctx.path);
		return int(ctx.rng, ilo, ihi);
	}
	if (hi < lo) throw new SeedError(`maximum ${hi} < minimum ${lo}`, ctx.path);
	if (hi === lo) return lo;
	return lo + ctx.rng() * (hi - lo);
};

const genArray = (s: JsonSchemaObject, ctx: Ctx): unknown[] => {
	const items = s.items;
	const min = s.minItems ?? 0;
	const max = s.maxItems ?? min + 3;
	if (max < min) throw new SeedError(`maxItems ${max} < minItems ${min}`, ctx.path);
	if (items === false) {
		if (min > 0) throw new SeedError("items:false with minItems > 0 is unsatisfiable", ctx.path);
		return [];
	}
	const child: Ctx = { ...ctx, depth: ctx.depth - 1, path: `${ctx.path}/*` };
	if (child.depth < 0) throw new SeedError("max depth exceeded", ctx.path);
	const len = int(ctx.rng, min, max);
	const itemSchema = items ?? true;
	return Array.from({ length: len }, () => generateValue(itemSchema, child));
};

const genObject = (s: JsonSchemaObject, ctx: Ctx): Record<string, unknown> => {
	const props = s.properties ?? {};
	const required = s.required ?? [];
	const minP = s.minProperties ?? 0;
	const maxP = s.maxProperties;
	const ap = s.additionalProperties;
	if (maxP !== undefined && minP > maxP) {
		throw new SeedError(`minProperties ${minP} > maxProperties ${maxP}`, ctx.path);
	}

	const apSchema = ap !== undefined && ap !== false ? ap : undefined;
	const apAllows = ap !== false; // undefined | true | schema

	// Candidate keys, deduped, required first for stable trimming.
	const keys: string[] = [];
	const seen = new Set<string>();
	const push = (k: string) => {
		if (!seen.has(k)) {
			seen.add(k);
			keys.push(k);
		}
	};
	for (const k of required) push(k);
	if (!ctx.requiredOnly) for (const k of Object.keys(props)) push(k);

	// minProperties: top up with remaining property names, then extras.
	for (const k of Object.keys(props)) {
		if (keys.length >= minP) break;
		push(k);
	}
	let extraN = 0;
	const extraKey = (): string => {
		// "extra<i>" keys always exist eventually — `seen` is finite.
		let i = extraN++;
		while (seen.has(`extra${i}`)) i = extraN++;
		return `extra${i}`;
	};
	while (keys.length < minP) {
		if (!apAllows) {
			throw new SeedError(
				`cannot reach minProperties ${minP} with additionalProperties:false`,
				ctx.path,
			);
		}
		push(extraKey());
	}
	// A few bonus extras when additionalProperties is an actual schema.
	if (apSchema !== undefined && apSchema !== true) {
		const room = maxP === undefined ? MAX_EXTRA_KEYS : Math.max(0, maxP - keys.length);
		for (let i = 0; i < Math.min(int(ctx.rng, 0, MAX_EXTRA_KEYS), room); i++) {
			push(extraKey());
		}
	}

	// maxProperties: trim non-required overflow.
	if (maxP !== undefined && keys.length > maxP) {
		const requiredSet = new Set(required);
		const kept = keys.filter((k) => requiredSet.has(k));
		for (const k of keys) {
			if (kept.length >= maxP) break;
			if (!requiredSet.has(k)) kept.push(k);
		}
		if (kept.length > maxP) {
			throw new SeedError(`required properties exceed maxProperties ${maxP}`, ctx.path);
		}
		keys.length = 0;
		keys.push(...kept);
	}

	const out: Record<string, unknown> = {};
	for (const key of keys) {
		let vs: JsonSchema;
		if (Object.hasOwn(props, key)) {
			vs = props[key] as JsonSchema;
		} else if (ap === false) {
			throw new SeedError(
				`required key "${key}" has no schema and additionalProperties:false`,
				ctx.path,
			);
		} else {
			vs = apSchema ?? true;
		}
		const child: Ctx = {
			...ctx,
			depth: ctx.depth - 1,
			path: `${ctx.path}/${ptrEscape(key)}`,
			key,
		};
		if (child.depth < 0) throw new SeedError("max depth exceeded", ctx.path);
		out[key] = generateValue(vs, child);
	}
	return out;
};

const randomScalar = (ctx: Ctx): unknown =>
	pick(ctx.rng, [
		() => randomWords(ctx, 1 + int(ctx.rng, 0, 2)),
		() => int(ctx.rng, 0, 1000),
		() => chance(ctx.rng, 0.5),
		() => null,
	])();

const generateValue = (schema: JsonSchema, ctx: Ctx): unknown => {
	if (--ctx.nodes.left < 0) throw new SeedError("node budget exceeded", ctx.path);

	let s = deref(schema, ctx);
	if (s === true) return randomScalar(ctx);
	if (s === false) throw new SeedError("schema accepts nothing (false)", ctx.path);
	if (Object.hasOwn(s, "const")) return clone(s.const);
	if (s.enum && s.enum.length > 0) return clone(pick(ctx.rng, s.enum));
	if (s.enum && s.enum.length === 0) throw new SeedError("empty enum", ctx.path);
	if (s.not !== undefined) {
		throw new SeedError("`not` schemas cannot be generated", ctx.path);
	}

	// Combinators: merge into an effective schema and recurse. The
	// merged schema may still carry other combinators — each pass
	// consumes one, so this terminates.
	if (s.allOf && s.allOf.length > 0) {
		const rest = omitKeys(s, ["allOf"]);
		const merged = [rest as JsonSchema, ...s.allOf].reduce<JsonSchema>(
			(acc, part) => mergeTwo(acc, part, ctx),
			true,
		);
		return generateValue(merged, ctx);
	}
	if (s.anyOf && s.anyOf.length > 0) {
		const rest = omitKeys(s, ["anyOf"]);
		const branch = pick(ctx.rng, s.anyOf);
		return generateValue(mergeTwo(rest, branch, ctx), ctx);
	}
	if (s.oneOf && s.oneOf.length > 0) {
		const rest = omitKeys(s, ["oneOf"]);
		const branch = pick(ctx.rng, s.oneOf);
		return generateValue(mergeTwo(rest, branch, ctx), ctx);
	}

	// Resolve effective type.
	const types = normTypes(s.type);
	const type = types && types.length > 0 ? pick(ctx.rng, types) : inferType(s);

	switch (type) {
		case "null":
			return null;
		case "boolean":
			return chance(ctx.rng, 0.5);
		case "number":
			return genNumber(s, false, ctx);
		case "integer":
			return genNumber(s, true, ctx);
		case "array":
			return genArray(s, ctx);
		case "object":
			return genObject(s, ctx);
		case "string":
		default:
			return genString(s, ctx);
	}
};

/** Infer a type from constraint keywords when `type` is absent. */
const inferType = (s: JsonSchemaObject): string => {
	if (
		s.properties ||
		s.required ||
		s.additionalProperties !== undefined ||
		s.minProperties !== undefined ||
		s.maxProperties !== undefined
	) {
		return "object";
	}
	if (s.items !== undefined || s.minItems !== undefined || s.maxItems !== undefined) return "array";
	if (s.pattern !== undefined || s.minLength !== undefined || s.maxLength !== undefined)
		return "string";
	if (s.minimum !== undefined || s.maximum !== undefined) return "number";
	return "string";
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate one JSON value satisfying `schema`. Deterministic for a
 * given seed/rng; throws {@link SeedError} on ungeneratable features.
 */
export const generate = (schema: JsonSchema, opts: GenerateOptions = {}): unknown => {
	const rng = opts.rng ?? makeRng(opts.seed ?? Math.floor(Math.random() * 0x1_0000_0000));
	const ctx: Ctx = {
		rng,
		pools: poolsFor(opts.locale),
		root: schema,
		requiredOnly: opts.requiredOnly ?? false,
		path: "$",
		depth: opts.depth ?? DEFAULT_MAX_DEPTH,
		nodes: { left: opts.maxNodes ?? DEFAULT_MAX_NODES },
	};
	const value = generateValue(schema, ctx);
	if (opts.assertValid) {
		const issues = validate(schema, value);
		if (issues.length > 0) {
			throw new SeedError(`generated value failed validation: ${issues[0].message}`, "$");
		}
	}
	return value;
};

/** Hard cap on `generateMany` count — each value runs the full
 * generator (pattern retries included), so an unbounded count is an
 * unbounded hang/DoS surface even for benign schemas. */
export const MAX_GENERATE_MANY = 10_000;

/** Generate `count` independent values (rng advances between calls).
 * `count` is capped at {@link MAX_GENERATE_MANY} — SeedError beyond. */
export const generateMany = (
	schema: JsonSchema,
	count: number,
	opts: GenerateOptions = {},
): unknown[] => {
	if (!Number.isInteger(count) || count < 0) {
		throw new SeedError(`count must be a non-negative integer, got ${count}`);
	}
	if (count > MAX_GENERATE_MANY) {
		throw new SeedError(`count ${count} exceeds MAX_GENERATE_MANY (${MAX_GENERATE_MANY})`);
	}
	const rng = opts.rng ?? makeRng(opts.seed ?? Math.floor(Math.random() * 0x1_0000_0000));
	return Array.from({ length: count }, () => generate(schema, { ...opts, rng }));
};

/**
 * Generate an object record — `schema` must effectively produce an
 * object (type object, or inferable from `properties`/`required`).
 */
export const generateRecord = (
	schema: JsonSchema,
	opts: GenerateOptions = {},
): Record<string, unknown> => {
	const value = generate(schema, opts);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SeedError("generateRecord requires an object-producing schema");
	}
	return value as Record<string, unknown>;
};
