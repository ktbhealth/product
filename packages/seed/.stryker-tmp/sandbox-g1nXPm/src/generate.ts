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
// @ts-nocheck
function stryNS_9fa48() {
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
  nodes: {
    left: number;
  };
  /** Last object-property name — drives string heuristics. */
  readonly key?: string;
}
const isObj = stryMutAct_9fa48("3") ? () => undefined : (stryCov_9fa48("3"), (() => {
  const isObj = (v: unknown): v is JsonSchemaObject => stryMutAct_9fa48("6") ? typeof v === "object" && v !== null || !Array.isArray(v) : stryMutAct_9fa48("5") ? false : stryMutAct_9fa48("4") ? true : (stryCov_9fa48("4", "5", "6"), (stryMutAct_9fa48("8") ? typeof v === "object" || v !== null : stryMutAct_9fa48("7") ? true : (stryCov_9fa48("7", "8"), (stryMutAct_9fa48("10") ? typeof v !== "object" : stryMutAct_9fa48("9") ? true : (stryCov_9fa48("9", "10"), typeof v === (stryMutAct_9fa48("11") ? "" : (stryCov_9fa48("11"), "object")))) && (stryMutAct_9fa48("13") ? v === null : stryMutAct_9fa48("12") ? true : (stryCov_9fa48("12", "13"), v !== null)))) && (stryMutAct_9fa48("14") ? Array.isArray(v) : (stryCov_9fa48("14"), !Array.isArray(v))));
  return isObj;
})());
const clone = stryMutAct_9fa48("15") ? () => undefined : (stryCov_9fa48("15"), (() => {
  const clone = <T,>(v: T): T => (stryMutAct_9fa48("18") ? v === null && typeof v !== "object" : stryMutAct_9fa48("17") ? false : stryMutAct_9fa48("16") ? true : (stryCov_9fa48("16", "17", "18"), (stryMutAct_9fa48("20") ? v !== null : stryMutAct_9fa48("19") ? false : (stryCov_9fa48("19", "20"), v === null)) || (stryMutAct_9fa48("22") ? typeof v === "object" : stryMutAct_9fa48("21") ? false : (stryCov_9fa48("21", "22"), typeof v !== (stryMutAct_9fa48("23") ? "" : (stryCov_9fa48("23"), "object")))))) ? v : structuredClone(v);
  return clone;
})());

/** RFC 6901 escape for error paths. */
const ptrEscape = stryMutAct_9fa48("24") ? () => undefined : (stryCov_9fa48("24"), (() => {
  const ptrEscape = (seg: string): string => seg.replace(/~/g, stryMutAct_9fa48("25") ? "" : (stryCov_9fa48("25"), "~0")).replace(/\//g, stryMutAct_9fa48("26") ? "" : (stryCov_9fa48("26"), "~1"));
  return ptrEscape;
})());

/** Resolve an internal `$ref` ("#" or "#/a/b") against the root schema. */
const resolvePointer = (root: unknown, ref: string): unknown => {
  if (stryMutAct_9fa48("27")) {
    {}
  } else {
    stryCov_9fa48("27");
    if (stryMutAct_9fa48("30") ? ref !== "#" : stryMutAct_9fa48("29") ? false : stryMutAct_9fa48("28") ? true : (stryCov_9fa48("28", "29", "30"), ref === (stryMutAct_9fa48("31") ? "" : (stryCov_9fa48("31"), "#")))) return root;
    let cur: unknown = root;
    for (const raw of stryMutAct_9fa48("32") ? ref.split("/") : (stryCov_9fa48("32"), ref.slice(2).split(stryMutAct_9fa48("33") ? "" : (stryCov_9fa48("33"), "/")))) {
      if (stryMutAct_9fa48("34")) {
        {}
      } else {
        stryCov_9fa48("34");
        const seg = raw.replace(/~1/g, stryMutAct_9fa48("35") ? "" : (stryCov_9fa48("35"), "/")).replace(/~0/g, stryMutAct_9fa48("36") ? "" : (stryCov_9fa48("36"), "~"));
        if (stryMutAct_9fa48("38") ? false : stryMutAct_9fa48("37") ? true : (stryCov_9fa48("37", "38"), Array.isArray(cur))) {
          if (stryMutAct_9fa48("39")) {
            {}
          } else {
            stryCov_9fa48("39");
            if (stryMutAct_9fa48("42") ? false : stryMutAct_9fa48("41") ? true : stryMutAct_9fa48("40") ? /^\d+$/.test(seg) : (stryCov_9fa48("40", "41", "42"), !(stryMutAct_9fa48("46") ? /^\D+$/ : stryMutAct_9fa48("45") ? /^\d$/ : stryMutAct_9fa48("44") ? /^\d+/ : stryMutAct_9fa48("43") ? /\d+$/ : (stryCov_9fa48("43", "44", "45", "46"), /^\d+$/)).test(seg))) return undefined;
            cur = cur[Number(seg)];
          }
        } else if (stryMutAct_9fa48("49") ? isObj(cur) && typeof cur === "object" : stryMutAct_9fa48("48") ? false : stryMutAct_9fa48("47") ? true : (stryCov_9fa48("47", "48", "49"), isObj(cur) || (stryMutAct_9fa48("51") ? typeof cur !== "object" : stryMutAct_9fa48("50") ? false : (stryCov_9fa48("50", "51"), typeof cur === (stryMutAct_9fa48("52") ? "" : (stryCov_9fa48("52"), "object")))))) {
          if (stryMutAct_9fa48("53")) {
            {}
          } else {
            stryCov_9fa48("53");
            if (stryMutAct_9fa48("56") ? cur === null && !Object.hasOwn(cur, seg) : stryMutAct_9fa48("55") ? false : stryMutAct_9fa48("54") ? true : (stryCov_9fa48("54", "55", "56"), (stryMutAct_9fa48("58") ? cur !== null : stryMutAct_9fa48("57") ? false : (stryCov_9fa48("57", "58"), cur === null)) || (stryMutAct_9fa48("59") ? Object.hasOwn(cur, seg) : (stryCov_9fa48("59"), !Object.hasOwn(cur, seg))))) return undefined;
            cur = (cur as Record<string, unknown>)[seg];
          }
        } else {
          if (stryMutAct_9fa48("60")) {
            {}
          } else {
            stryCov_9fa48("60");
            return undefined;
          }
        }
      }
    }
    return cur;
  }
};
const jsonEqual = (a: unknown, b: unknown): boolean => {
  if (stryMutAct_9fa48("61")) {
    {}
  } else {
    stryCov_9fa48("61");
    if (stryMutAct_9fa48("64") ? a !== b : stryMutAct_9fa48("63") ? false : stryMutAct_9fa48("62") ? true : (stryCov_9fa48("62", "63", "64"), a === b)) return stryMutAct_9fa48("65") ? false : (stryCov_9fa48("65"), true);
    if (stryMutAct_9fa48("68") ? (typeof a !== "object" || typeof b !== "object" || a === null) && b === null : stryMutAct_9fa48("67") ? false : stryMutAct_9fa48("66") ? true : (stryCov_9fa48("66", "67", "68"), (stryMutAct_9fa48("70") ? (typeof a !== "object" || typeof b !== "object") && a === null : stryMutAct_9fa48("69") ? false : (stryCov_9fa48("69", "70"), (stryMutAct_9fa48("72") ? typeof a !== "object" && typeof b !== "object" : stryMutAct_9fa48("71") ? false : (stryCov_9fa48("71", "72"), (stryMutAct_9fa48("74") ? typeof a === "object" : stryMutAct_9fa48("73") ? false : (stryCov_9fa48("73", "74"), typeof a !== (stryMutAct_9fa48("75") ? "" : (stryCov_9fa48("75"), "object")))) || (stryMutAct_9fa48("77") ? typeof b === "object" : stryMutAct_9fa48("76") ? false : (stryCov_9fa48("76", "77"), typeof b !== (stryMutAct_9fa48("78") ? "" : (stryCov_9fa48("78"), "object")))))) || (stryMutAct_9fa48("80") ? a !== null : stryMutAct_9fa48("79") ? false : (stryCov_9fa48("79", "80"), a === null)))) || (stryMutAct_9fa48("82") ? b !== null : stryMutAct_9fa48("81") ? false : (stryCov_9fa48("81", "82"), b === null)))) return stryMutAct_9fa48("83") ? true : (stryCov_9fa48("83"), false);
    if (stryMutAct_9fa48("86") ? Array.isArray(a) === Array.isArray(b) : stryMutAct_9fa48("85") ? false : stryMutAct_9fa48("84") ? true : (stryCov_9fa48("84", "85", "86"), Array.isArray(a) !== Array.isArray(b))) return stryMutAct_9fa48("87") ? true : (stryCov_9fa48("87"), false);
    if (stryMutAct_9fa48("90") ? Array.isArray(a) || Array.isArray(b) : stryMutAct_9fa48("89") ? false : stryMutAct_9fa48("88") ? true : (stryCov_9fa48("88", "89", "90"), Array.isArray(a) && Array.isArray(b))) {
      if (stryMutAct_9fa48("91")) {
        {}
      } else {
        stryCov_9fa48("91");
        return stryMutAct_9fa48("94") ? a.length === b.length || a.every((v, i) => jsonEqual(v, b[i])) : stryMutAct_9fa48("93") ? false : stryMutAct_9fa48("92") ? true : (stryCov_9fa48("92", "93", "94"), (stryMutAct_9fa48("96") ? a.length !== b.length : stryMutAct_9fa48("95") ? true : (stryCov_9fa48("95", "96"), a.length === b.length)) && (stryMutAct_9fa48("97") ? a.some((v, i) => jsonEqual(v, b[i])) : (stryCov_9fa48("97"), a.every(stryMutAct_9fa48("98") ? () => undefined : (stryCov_9fa48("98"), (v, i) => jsonEqual(v, b[i]))))));
      }
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    return stryMutAct_9fa48("101") ? ak.length === bk.length || ak.every(k => Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k])) : stryMutAct_9fa48("100") ? false : stryMutAct_9fa48("99") ? true : (stryCov_9fa48("99", "100", "101"), (stryMutAct_9fa48("103") ? ak.length !== bk.length : stryMutAct_9fa48("102") ? true : (stryCov_9fa48("102", "103"), ak.length === bk.length)) && (stryMutAct_9fa48("104") ? ak.some(k => Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k])) : (stryCov_9fa48("104"), ak.every(stryMutAct_9fa48("105") ? () => undefined : (stryCov_9fa48("105"), k => stryMutAct_9fa48("108") ? Object.hasOwn(bo, k) || jsonEqual(ao[k], bo[k]) : stryMutAct_9fa48("107") ? false : stryMutAct_9fa48("106") ? true : (stryCov_9fa48("106", "107", "108"), Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k])))))));
  }
};
const normTypes = (t: JsonSchemaObject["type"]): readonly string[] | null => {
  if (stryMutAct_9fa48("109")) {
    {}
  } else {
    stryCov_9fa48("109");
    if (stryMutAct_9fa48("112") ? t !== undefined : stryMutAct_9fa48("111") ? false : stryMutAct_9fa48("110") ? true : (stryCov_9fa48("110", "111", "112"), t === undefined)) return null;
    // Array.isArray doesn't narrow `readonly T[]` unions — cast the
    // single-type arm explicitly.
    return Array.isArray(t) ? stryMutAct_9fa48("113") ? [] : (stryCov_9fa48("113"), [...t]) : stryMutAct_9fa48("114") ? [] : (stryCov_9fa48("114"), [t as string]);
  }
};

/**
 * AND-merge two schemas into one effective schema. Throws SeedError on
 * contradictions (empty type/enum intersection, conflicting consts or
 * patterns, inverted bounds). Used for `allOf`, `$ref` siblings and
 * combinator+rest merges.
 */
const mergeObjects = (a: JsonSchemaObject, b: JsonSchemaObject, ctx: Ctx): JsonSchemaObject => {
  if (stryMutAct_9fa48("115")) {
    {}
  } else {
    stryCov_9fa48("115");
    const out: Record<string, unknown> = stryMutAct_9fa48("116") ? {} : (stryCov_9fa48("116"), {
      ...a
    });

    // --- type: intersect ---
    const ta = normTypes(a.type);
    const tb = normTypes(b.type);
    if (stryMutAct_9fa48("119") ? ta || tb : stryMutAct_9fa48("118") ? false : stryMutAct_9fa48("117") ? true : (stryCov_9fa48("117", "118", "119"), ta && tb)) {
      if (stryMutAct_9fa48("120")) {
        {}
      } else {
        stryCov_9fa48("120");
        const inter = stryMutAct_9fa48("121") ? ta : (stryCov_9fa48("121"), ta.filter(stryMutAct_9fa48("122") ? () => undefined : (stryCov_9fa48("122"), t => tb.includes(t))));
        if (stryMutAct_9fa48("125") ? inter.length !== 0 : stryMutAct_9fa48("124") ? false : stryMutAct_9fa48("123") ? true : (stryCov_9fa48("123", "124", "125"), inter.length === 0)) throw new SeedError(stryMutAct_9fa48("127") ? "" : (stryCov_9fa48("127"), "allOf branches have disjoint types"), ctx.path);
        out.type = (stryMutAct_9fa48("130") ? inter.length !== 1 : stryMutAct_9fa48("129") ? false : stryMutAct_9fa48("128") ? true : (stryCov_9fa48("128", "129", "130"), inter.length === 1)) ? inter[0] : inter;
      }
    } else if (stryMutAct_9fa48("132") ? false : stryMutAct_9fa48("131") ? true : (stryCov_9fa48("131", "132"), tb)) {
      if (stryMutAct_9fa48("133")) {
        {}
      } else {
        stryCov_9fa48("133");
        out.type = b.type;
      }
    }

    // --- const / enum ---
    const aHasConst = Object.hasOwn(a, stryMutAct_9fa48("134") ? "" : (stryCov_9fa48("134"), "const"));
    const bHasConst = Object.hasOwn(b, stryMutAct_9fa48("135") ? "" : (stryCov_9fa48("135"), "const"));
    if (stryMutAct_9fa48("138") ? aHasConst && bHasConst || !jsonEqual(a.const, b.const) : stryMutAct_9fa48("137") ? false : stryMutAct_9fa48("136") ? true : (stryCov_9fa48("136", "137", "138"), (stryMutAct_9fa48("140") ? aHasConst || bHasConst : stryMutAct_9fa48("139") ? true : (stryCov_9fa48("139", "140"), aHasConst && bHasConst)) && (stryMutAct_9fa48("141") ? jsonEqual(a.const, b.const) : (stryCov_9fa48("141"), !jsonEqual(a.const, b.const))))) {
      if (stryMutAct_9fa48("142")) {
        {}
      } else {
        stryCov_9fa48("142");
        throw new SeedError(stryMutAct_9fa48("144") ? "" : (stryCov_9fa48("144"), "conflicting const values"), ctx.path);
      }
    }
    if (stryMutAct_9fa48("146") ? false : stryMutAct_9fa48("145") ? true : (stryCov_9fa48("145", "146"), bHasConst)) out.const = b.const;
    if (stryMutAct_9fa48("149") ? a.enum || b.enum : stryMutAct_9fa48("148") ? false : stryMutAct_9fa48("147") ? true : (stryCov_9fa48("147", "148", "149"), a.enum && b.enum)) {
      if (stryMutAct_9fa48("150")) {
        {}
      } else {
        stryCov_9fa48("150");
        const inter = stryMutAct_9fa48("151") ? a.enum : (stryCov_9fa48("151"), a.enum.filter(stryMutAct_9fa48("152") ? () => undefined : (stryCov_9fa48("152"), v => stryMutAct_9fa48("154") ? b.enum.some(w => jsonEqual(v, w)) : stryMutAct_9fa48("153") ? b.enum?.every(w => jsonEqual(v, w)) : (stryCov_9fa48("153", "154"), b.enum?.some(stryMutAct_9fa48("155") ? () => undefined : (stryCov_9fa48("155"), w => jsonEqual(v, w)))))));
        if (stryMutAct_9fa48("158") ? inter.length !== 0 : stryMutAct_9fa48("157") ? false : stryMutAct_9fa48("156") ? true : (stryCov_9fa48("156", "157", "158"), inter.length === 0)) throw new SeedError(stryMutAct_9fa48("160") ? "" : (stryCov_9fa48("160"), "empty enum intersection"), ctx.path);
        out.enum = inter;
      }
    } else if (stryMutAct_9fa48("162") ? false : stryMutAct_9fa48("161") ? true : (stryCov_9fa48("161", "162"), b.enum)) {
      if (stryMutAct_9fa48("163")) {
        {}
      } else {
        stryCov_9fa48("163");
        out.enum = b.enum;
      }
    }

    // --- scalar bounds: stricter wins ---
    const LOWER_KEYS = ["minimum", "minLength", "minItems", "minProperties"] as const;
    const UPPER_KEYS = ["maximum", "maxLength", "maxItems", "maxProperties"] as const;
    for (const k of LOWER_KEYS) {
      if (stryMutAct_9fa48("164")) {
        {}
      } else {
        stryCov_9fa48("164");
        const av = a[k];
        const bv = b[k];
        if (stryMutAct_9fa48("167") ? av !== undefined && bv !== undefined : stryMutAct_9fa48("166") ? false : stryMutAct_9fa48("165") ? true : (stryCov_9fa48("165", "166", "167"), (stryMutAct_9fa48("169") ? av === undefined : stryMutAct_9fa48("168") ? false : (stryCov_9fa48("168", "169"), av !== undefined)) || (stryMutAct_9fa48("171") ? bv === undefined : stryMutAct_9fa48("170") ? false : (stryCov_9fa48("170", "171"), bv !== undefined)))) out[k] = stryMutAct_9fa48("172") ? Math.min(av ?? -Infinity, bv ?? -Infinity) : (stryCov_9fa48("172"), Math.max(stryMutAct_9fa48("173") ? av && -Infinity : (stryCov_9fa48("173"), av ?? (stryMutAct_9fa48("174") ? +Infinity : (stryCov_9fa48("174"), -Infinity))), stryMutAct_9fa48("175") ? bv && -Infinity : (stryCov_9fa48("175"), bv ?? (stryMutAct_9fa48("176") ? +Infinity : (stryCov_9fa48("176"), -Infinity)))));
      }
    }
    for (const k of UPPER_KEYS) {
      if (stryMutAct_9fa48("177")) {
        {}
      } else {
        stryCov_9fa48("177");
        const av = a[k];
        const bv = b[k];
        if (stryMutAct_9fa48("180") ? av !== undefined && bv !== undefined : stryMutAct_9fa48("179") ? false : stryMutAct_9fa48("178") ? true : (stryCov_9fa48("178", "179", "180"), (stryMutAct_9fa48("182") ? av === undefined : stryMutAct_9fa48("181") ? false : (stryCov_9fa48("181", "182"), av !== undefined)) || (stryMutAct_9fa48("184") ? bv === undefined : stryMutAct_9fa48("183") ? false : (stryCov_9fa48("183", "184"), bv !== undefined)))) out[k] = stryMutAct_9fa48("185") ? Math.max(av ?? Infinity, bv ?? Infinity) : (stryCov_9fa48("185"), Math.min(stryMutAct_9fa48("186") ? av && Infinity : (stryCov_9fa48("186"), av ?? Infinity), stryMutAct_9fa48("187") ? bv && Infinity : (stryCov_9fa48("187"), bv ?? Infinity)));
      }
    }
    // Cross-check the bound pairs we just tightened.
    const pairs: ReadonlyArray<readonly [string, string]> = stryMutAct_9fa48("188") ? [] : (stryCov_9fa48("188"), [stryMutAct_9fa48("189") ? [] : (stryCov_9fa48("189"), [stryMutAct_9fa48("190") ? "" : (stryCov_9fa48("190"), "minimum"), stryMutAct_9fa48("191") ? "" : (stryCov_9fa48("191"), "maximum")]), stryMutAct_9fa48("192") ? [] : (stryCov_9fa48("192"), [stryMutAct_9fa48("193") ? "" : (stryCov_9fa48("193"), "minLength"), stryMutAct_9fa48("194") ? "" : (stryCov_9fa48("194"), "maxLength")]), stryMutAct_9fa48("195") ? [] : (stryCov_9fa48("195"), [stryMutAct_9fa48("196") ? "" : (stryCov_9fa48("196"), "minItems"), stryMutAct_9fa48("197") ? "" : (stryCov_9fa48("197"), "maxItems")]), stryMutAct_9fa48("198") ? [] : (stryCov_9fa48("198"), [stryMutAct_9fa48("199") ? "" : (stryCov_9fa48("199"), "minProperties"), stryMutAct_9fa48("200") ? "" : (stryCov_9fa48("200"), "maxProperties")])]);
    for (const [lo, hi] of pairs) {
      if (stryMutAct_9fa48("201")) {
        {}
      } else {
        stryCov_9fa48("201");
        const lv = out[lo] as number | undefined;
        const hv = out[hi] as number | undefined;
        if (stryMutAct_9fa48("204") ? lv !== undefined && hv !== undefined || lv > hv : stryMutAct_9fa48("203") ? false : stryMutAct_9fa48("202") ? true : (stryCov_9fa48("202", "203", "204"), (stryMutAct_9fa48("206") ? lv !== undefined || hv !== undefined : stryMutAct_9fa48("205") ? true : (stryCov_9fa48("205", "206"), (stryMutAct_9fa48("208") ? lv === undefined : stryMutAct_9fa48("207") ? true : (stryCov_9fa48("207", "208"), lv !== undefined)) && (stryMutAct_9fa48("210") ? hv === undefined : stryMutAct_9fa48("209") ? true : (stryCov_9fa48("209", "210"), hv !== undefined)))) && (stryMutAct_9fa48("213") ? lv <= hv : stryMutAct_9fa48("212") ? lv >= hv : stryMutAct_9fa48("211") ? true : (stryCov_9fa48("211", "212", "213"), lv > hv)))) {
          if (stryMutAct_9fa48("214")) {
            {}
          } else {
            stryCov_9fa48("214");
            throw new SeedError(stryMutAct_9fa48("216") ? `` : (stryCov_9fa48("216"), `inverted bounds: ${lo} > ${hi}`), ctx.path);
          }
        }
      }
    }

    // --- pattern: at most one distinct source ---
    if (stryMutAct_9fa48("219") ? b.pattern === undefined : stryMutAct_9fa48("218") ? false : stryMutAct_9fa48("217") ? true : (stryCov_9fa48("217", "218", "219"), b.pattern !== undefined)) {
      if (stryMutAct_9fa48("220")) {
        {}
      } else {
        stryCov_9fa48("220");
        if (stryMutAct_9fa48("223") ? a.pattern !== undefined || a.pattern !== b.pattern : stryMutAct_9fa48("222") ? false : stryMutAct_9fa48("221") ? true : (stryCov_9fa48("221", "222", "223"), (stryMutAct_9fa48("225") ? a.pattern === undefined : stryMutAct_9fa48("224") ? true : (stryCov_9fa48("224", "225"), a.pattern !== undefined)) && (stryMutAct_9fa48("227") ? a.pattern === b.pattern : stryMutAct_9fa48("226") ? true : (stryCov_9fa48("226", "227"), a.pattern !== b.pattern)))) {
          if (stryMutAct_9fa48("228")) {
            {}
          } else {
            stryCov_9fa48("228");
            throw new SeedError(stryMutAct_9fa48("230") ? "" : (stryCov_9fa48("230"), "conflicting patterns cannot be merged"), ctx.path);
          }
        }
        out.pattern = b.pattern;
      }
    }

    // --- object keywords ---
    if (stryMutAct_9fa48("232") ? false : stryMutAct_9fa48("231") ? true : (stryCov_9fa48("231", "232"), b.properties)) {
      if (stryMutAct_9fa48("233")) {
        {}
      } else {
        stryCov_9fa48("233");
        const merged: Record<string, JsonSchema> = stryMutAct_9fa48("234") ? {} : (stryCov_9fa48("234"), {
          ...(stryMutAct_9fa48("235") ? a.properties && {} : (stryCov_9fa48("235"), a.properties ?? {}))
        });
        for (const [k, v] of Object.entries(b.properties)) {
          if (stryMutAct_9fa48("236")) {
            {}
          } else {
            stryCov_9fa48("236");
            const prev = merged[k];
            merged[k] = (stryMutAct_9fa48("239") ? prev !== undefined : stryMutAct_9fa48("238") ? false : stryMutAct_9fa48("237") ? true : (stryCov_9fa48("237", "238", "239"), prev === undefined)) ? v : mergeTwo(prev, v, ctx) as JsonSchema;
          }
        }
        out.properties = merged;
      }
    }
    if (stryMutAct_9fa48("241") ? false : stryMutAct_9fa48("240") ? true : (stryCov_9fa48("240", "241"), b.required)) {
      if (stryMutAct_9fa48("242")) {
        {}
      } else {
        stryCov_9fa48("242");
        out.required = stryMutAct_9fa48("243") ? [] : (stryCov_9fa48("243"), [...new Set(stryMutAct_9fa48("244") ? [] : (stryCov_9fa48("244"), [...(stryMutAct_9fa48("245") ? a.required && [] : (stryCov_9fa48("245"), a.required ?? (stryMutAct_9fa48("246") ? ["Stryker was here"] : (stryCov_9fa48("246"), [])))), ...b.required]))]);
      }
    }
    if (stryMutAct_9fa48("249") ? b.additionalProperties === undefined : stryMutAct_9fa48("248") ? false : stryMutAct_9fa48("247") ? true : (stryCov_9fa48("247", "248", "249"), b.additionalProperties !== undefined)) {
      if (stryMutAct_9fa48("250")) {
        {}
      } else {
        stryCov_9fa48("250");
        const av = a.additionalProperties;
        const bv = b.additionalProperties;
        if (stryMutAct_9fa48("253") ? av === false && bv === false : stryMutAct_9fa48("252") ? false : stryMutAct_9fa48("251") ? true : (stryCov_9fa48("251", "252", "253"), (stryMutAct_9fa48("255") ? av !== false : stryMutAct_9fa48("254") ? false : (stryCov_9fa48("254", "255"), av === (stryMutAct_9fa48("256") ? true : (stryCov_9fa48("256"), false)))) || (stryMutAct_9fa48("258") ? bv !== false : stryMutAct_9fa48("257") ? false : (stryCov_9fa48("257", "258"), bv === (stryMutAct_9fa48("259") ? true : (stryCov_9fa48("259"), false)))))) {
          if (stryMutAct_9fa48("260")) {
            {}
          } else {
            stryCov_9fa48("260");
            out.additionalProperties = stryMutAct_9fa48("261") ? true : (stryCov_9fa48("261"), false);
          }
        } else if (stryMutAct_9fa48("264") ? av === undefined && av === true : stryMutAct_9fa48("263") ? false : stryMutAct_9fa48("262") ? true : (stryCov_9fa48("262", "263", "264"), (stryMutAct_9fa48("266") ? av !== undefined : stryMutAct_9fa48("265") ? false : (stryCov_9fa48("265", "266"), av === undefined)) || (stryMutAct_9fa48("268") ? av !== true : stryMutAct_9fa48("267") ? false : (stryCov_9fa48("267", "268"), av === (stryMutAct_9fa48("269") ? false : (stryCov_9fa48("269"), true)))))) {
          if (stryMutAct_9fa48("270")) {
            {}
          } else {
            stryCov_9fa48("270");
            out.additionalProperties = bv;
          }
        } else if (stryMutAct_9fa48("273") ? bv === undefined && bv === true : stryMutAct_9fa48("272") ? false : stryMutAct_9fa48("271") ? true : (stryCov_9fa48("271", "272", "273"), (stryMutAct_9fa48("275") ? bv !== undefined : stryMutAct_9fa48("274") ? false : (stryCov_9fa48("274", "275"), bv === undefined)) || (stryMutAct_9fa48("277") ? bv !== true : stryMutAct_9fa48("276") ? false : (stryCov_9fa48("276", "277"), bv === (stryMutAct_9fa48("278") ? false : (stryCov_9fa48("278"), true)))))) {
          if (stryMutAct_9fa48("279")) {
            {}
          } else {
            stryCov_9fa48("279");
            out.additionalProperties = av;
          }
        } else {
          if (stryMutAct_9fa48("280")) {
            {}
          } else {
            stryCov_9fa48("280");
            out.additionalProperties = mergeTwo(av, bv, ctx);
          }
        }
      }
    }

    // --- array keyword ---
    if (stryMutAct_9fa48("283") ? b.items === undefined : stryMutAct_9fa48("282") ? false : stryMutAct_9fa48("281") ? true : (stryCov_9fa48("281", "282", "283"), b.items !== undefined)) {
      if (stryMutAct_9fa48("284")) {
        {}
      } else {
        stryCov_9fa48("284");
        out.items = (stryMutAct_9fa48("287") ? a.items !== undefined : stryMutAct_9fa48("286") ? false : stryMutAct_9fa48("285") ? true : (stryCov_9fa48("285", "286", "287"), a.items === undefined)) ? b.items : mergeTwo(a.items, b.items, ctx);
      }
    }

    // --- combinators ---
    // allOf concatenates freely (associative). anyOf/oneOf appearing on
    // BOTH sides must be AND-ed, which is NOT a union — distribute into
    // the cross product anyOf(ai ∧ bj) so every pair constraint holds.
    // (oneOf keeps its documented exactly-one caveat.)
    if (stryMutAct_9fa48("290") ? a.allOf && b.allOf : stryMutAct_9fa48("289") ? false : stryMutAct_9fa48("288") ? true : (stryCov_9fa48("288", "289", "290"), a.allOf || b.allOf)) {
      if (stryMutAct_9fa48("291")) {
        {}
      } else {
        stryCov_9fa48("291");
        out.allOf = stryMutAct_9fa48("292") ? [] : (stryCov_9fa48("292"), [...(stryMutAct_9fa48("293") ? a.allOf && [] : (stryCov_9fa48("293"), a.allOf ?? (stryMutAct_9fa48("294") ? ["Stryker was here"] : (stryCov_9fa48("294"), [])))), ...(stryMutAct_9fa48("295") ? b.allOf && [] : (stryCov_9fa48("295"), b.allOf ?? (stryMutAct_9fa48("296") ? ["Stryker was here"] : (stryCov_9fa48("296"), []))))]);
      }
    }
    for (const k of ["anyOf", "oneOf"] as const) {
      if (stryMutAct_9fa48("297")) {
        {}
      } else {
        stryCov_9fa48("297");
        const av = a[k];
        const bv = b[k];
        if (stryMutAct_9fa48("300") ? av?.length || bv?.length : stryMutAct_9fa48("299") ? false : stryMutAct_9fa48("298") ? true : (stryCov_9fa48("298", "299", "300"), (stryMutAct_9fa48("301") ? av.length : (stryCov_9fa48("301"), av?.length)) && (stryMutAct_9fa48("302") ? bv.length : (stryCov_9fa48("302"), bv?.length)))) {
          if (stryMutAct_9fa48("303")) {
            {}
          } else {
            stryCov_9fa48("303");
            if (stryMutAct_9fa48("307") ? av.length * bv.length <= 64 : stryMutAct_9fa48("306") ? av.length * bv.length >= 64 : stryMutAct_9fa48("305") ? false : stryMutAct_9fa48("304") ? true : (stryCov_9fa48("304", "305", "306", "307"), (stryMutAct_9fa48("308") ? av.length / bv.length : (stryCov_9fa48("308"), av.length * bv.length)) > 64)) {
              if (stryMutAct_9fa48("309")) {
                {}
              } else {
                stryCov_9fa48("309");
                throw new SeedError(stryMutAct_9fa48("311") ? `` : (stryCov_9fa48("311"), `combinator product too large (${av.length}×${bv.length})`), ctx.path);
              }
            }
            const combos: JsonSchema[] = stryMutAct_9fa48("312") ? ["Stryker was here"] : (stryCov_9fa48("312"), []);
            for (const x of av) {
              if (stryMutAct_9fa48("313")) {
                {}
              } else {
                stryCov_9fa48("313");
                for (const y of bv) {
                  if (stryMutAct_9fa48("314")) {
                    {}
                  } else {
                    stryCov_9fa48("314");
                    try {
                      if (stryMutAct_9fa48("315")) {
                        {}
                      } else {
                        stryCov_9fa48("315");
                        if (stryMutAct_9fa48("316")) {
                          ;
                        } else {
                          stryCov_9fa48("316");
                          combos.push(mergeTwo(x, y, ctx));
                        }
                      }
                    } catch {
                      // Incompatible pair — it can never be satisfied, so
                      // dropping it preserves semantics.
                    }
                  }
                }
              }
            }
            if (stryMutAct_9fa48("319") ? combos.length !== 0 : stryMutAct_9fa48("318") ? false : stryMutAct_9fa48("317") ? true : (stryCov_9fa48("317", "318", "319"), combos.length === 0)) {
              if (stryMutAct_9fa48("320")) {
                {}
              } else {
                stryCov_9fa48("320");
                throw new SeedError(stryMutAct_9fa48("322") ? `` : (stryCov_9fa48("322"), `no satisfiable ${k} combination`), ctx.path);
              }
            }
            out[k] = combos;
          }
        } else if (stryMutAct_9fa48("325") ? av && bv : stryMutAct_9fa48("324") ? false : stryMutAct_9fa48("323") ? true : (stryCov_9fa48("323", "324", "325"), av || bv)) {
          if (stryMutAct_9fa48("326")) {
            {}
          } else {
            stryCov_9fa48("326");
            out[k] = stryMutAct_9fa48("327") ? [] : (stryCov_9fa48("327"), [...(stryMutAct_9fa48("328") ? av && [] : (stryCov_9fa48("328"), av ?? (stryMutAct_9fa48("329") ? ["Stryker was here"] : (stryCov_9fa48("329"), [])))), ...(stryMutAct_9fa48("330") ? bv && [] : (stryCov_9fa48("330"), bv ?? (stryMutAct_9fa48("331") ? ["Stryker was here"] : (stryCov_9fa48("331"), []))))]);
          }
        }
      }
    }
    // not(A) AND not(B) === not(A or B)
    if (stryMutAct_9fa48("334") ? a.not !== undefined || b.not !== undefined : stryMutAct_9fa48("333") ? false : stryMutAct_9fa48("332") ? true : (stryCov_9fa48("332", "333", "334"), (stryMutAct_9fa48("336") ? a.not === undefined : stryMutAct_9fa48("335") ? true : (stryCov_9fa48("335", "336"), a.not !== undefined)) && (stryMutAct_9fa48("338") ? b.not === undefined : stryMutAct_9fa48("337") ? true : (stryCov_9fa48("337", "338"), b.not !== undefined)))) {
      if (stryMutAct_9fa48("339")) {
        {}
      } else {
        stryCov_9fa48("339");
        out.not = stryMutAct_9fa48("340") ? {} : (stryCov_9fa48("340"), {
          anyOf: stryMutAct_9fa48("341") ? [] : (stryCov_9fa48("341"), [a.not, b.not])
        });
      }
    } else if (stryMutAct_9fa48("344") ? b.not === undefined : stryMutAct_9fa48("343") ? false : stryMutAct_9fa48("342") ? true : (stryCov_9fa48("342", "343", "344"), b.not !== undefined)) {
      if (stryMutAct_9fa48("345")) {
        {}
      } else {
        stryCov_9fa48("345");
        out.not = b.not;
      }
    }

    // --- annotations: keep a's, fall back to b's ---
    for (const k of ["$schema", "title", "description", "default", "$comment"] as const) {
      if (stryMutAct_9fa48("346")) {
        {}
      } else {
        stryCov_9fa48("346");
        if (stryMutAct_9fa48("349") ? out[k] === undefined || b[k] !== undefined : stryMutAct_9fa48("348") ? false : stryMutAct_9fa48("347") ? true : (stryCov_9fa48("347", "348", "349"), (stryMutAct_9fa48("351") ? out[k] !== undefined : stryMutAct_9fa48("350") ? true : (stryCov_9fa48("350", "351"), out[k] === undefined)) && (stryMutAct_9fa48("353") ? b[k] === undefined : stryMutAct_9fa48("352") ? true : (stryCov_9fa48("352", "353"), b[k] !== undefined)))) out[k] = b[k];
      }
    }
    return out as JsonSchemaObject;
  }
};
const mergeTwo = (a: JsonSchema, b: JsonSchema, ctx: Ctx): JsonSchema => {
  if (stryMutAct_9fa48("354")) {
    {}
  } else {
    stryCov_9fa48("354");
    const da = deref(a, ctx);
    const db = deref(b, ctx);
    if (stryMutAct_9fa48("357") ? da !== true : stryMutAct_9fa48("356") ? false : stryMutAct_9fa48("355") ? true : (stryCov_9fa48("355", "356", "357"), da === (stryMutAct_9fa48("358") ? false : (stryCov_9fa48("358"), true)))) return db;
    if (stryMutAct_9fa48("361") ? db !== true : stryMutAct_9fa48("360") ? false : stryMutAct_9fa48("359") ? true : (stryCov_9fa48("359", "360", "361"), db === (stryMutAct_9fa48("362") ? false : (stryCov_9fa48("362"), true)))) return da;
    if (stryMutAct_9fa48("365") ? da === false && db === false : stryMutAct_9fa48("364") ? false : stryMutAct_9fa48("363") ? true : (stryCov_9fa48("363", "364", "365"), (stryMutAct_9fa48("367") ? da !== false : stryMutAct_9fa48("366") ? false : (stryCov_9fa48("366", "367"), da === (stryMutAct_9fa48("368") ? true : (stryCov_9fa48("368"), false)))) || (stryMutAct_9fa48("370") ? db !== false : stryMutAct_9fa48("369") ? false : (stryCov_9fa48("369", "370"), db === (stryMutAct_9fa48("371") ? true : (stryCov_9fa48("371"), false)))))) return stryMutAct_9fa48("372") ? true : (stryCov_9fa48("372"), false);
    return mergeObjects(da, db, ctx);
  }
};

/** Strip a set of keys, returning the rest as a schema object. */
const omitKeys = (s: JsonSchemaObject, keys: readonly string[]): JsonSchemaObject => {
  if (stryMutAct_9fa48("373")) {
    {}
  } else {
    stryCov_9fa48("373");
    const out: Record<string, unknown> = stryMutAct_9fa48("374") ? {} : (stryCov_9fa48("374"), {
      ...s
    });
    for (const k of keys) delete out[k];
    return out as JsonSchemaObject;
  }
};

/** Resolve `$ref` chains (with sibling merge) until a plain schema. */
const deref = (schema: JsonSchema, ctx: Ctx): JsonSchema => {
  if (stryMutAct_9fa48("375")) {
    {}
  } else {
    stryCov_9fa48("375");
    let s = schema;
    const seen = new Set<string>();
    while (stryMutAct_9fa48("377") ? isObj(s) || typeof s.$ref === "string" : stryMutAct_9fa48("376") ? false : (stryCov_9fa48("376", "377"), isObj(s) && (stryMutAct_9fa48("379") ? typeof s.$ref !== "string" : stryMutAct_9fa48("378") ? true : (stryCov_9fa48("378", "379"), typeof s.$ref === (stryMutAct_9fa48("380") ? "" : (stryCov_9fa48("380"), "string")))))) {
      if (stryMutAct_9fa48("381")) {
        {}
      } else {
        stryCov_9fa48("381");
        if (stryMutAct_9fa48("383") ? false : stryMutAct_9fa48("382") ? true : (stryCov_9fa48("382", "383"), seen.has(s.$ref))) throw new SeedError(stryMutAct_9fa48("385") ? "" : (stryCov_9fa48("385"), "recursive $ref"), ctx.path);
        if (stryMutAct_9fa48("386")) {
          ;
        } else {
          stryCov_9fa48("386");
          seen.add(s.$ref);
        }
        const target = resolvePointer(ctx.root, s.$ref);
        if (stryMutAct_9fa48("389") ? (target === undefined || target === null) && typeof target !== "object" && typeof target !== "boolean" : stryMutAct_9fa48("388") ? false : stryMutAct_9fa48("387") ? true : (stryCov_9fa48("387", "388", "389"), (stryMutAct_9fa48("391") ? target === undefined && target === null : stryMutAct_9fa48("390") ? false : (stryCov_9fa48("390", "391"), (stryMutAct_9fa48("393") ? target !== undefined : stryMutAct_9fa48("392") ? false : (stryCov_9fa48("392", "393"), target === undefined)) || (stryMutAct_9fa48("395") ? target !== null : stryMutAct_9fa48("394") ? false : (stryCov_9fa48("394", "395"), target === null)))) || (stryMutAct_9fa48("397") ? typeof target !== "object" || typeof target !== "boolean" : stryMutAct_9fa48("396") ? false : (stryCov_9fa48("396", "397"), (stryMutAct_9fa48("399") ? typeof target === "object" : stryMutAct_9fa48("398") ? true : (stryCov_9fa48("398", "399"), typeof target !== (stryMutAct_9fa48("400") ? "" : (stryCov_9fa48("400"), "object")))) && (stryMutAct_9fa48("402") ? typeof target === "boolean" : stryMutAct_9fa48("401") ? true : (stryCov_9fa48("401", "402"), typeof target !== (stryMutAct_9fa48("403") ? "" : (stryCov_9fa48("403"), "boolean")))))))) {
          if (stryMutAct_9fa48("404")) {
            {}
          } else {
            stryCov_9fa48("404");
            throw new SeedError(stryMutAct_9fa48("406") ? `` : (stryCov_9fa48("406"), `unresolvable $ref "${s.$ref}"`), ctx.path);
          }
        }
        const siblings = omitKeys(s, stryMutAct_9fa48("407") ? [] : (stryCov_9fa48("407"), [stryMutAct_9fa48("408") ? "" : (stryCov_9fa48("408"), "$ref")]));
        const hasSiblings = stryMutAct_9fa48("412") ? Object.keys(siblings).length <= 0 : stryMutAct_9fa48("411") ? Object.keys(siblings).length >= 0 : stryMutAct_9fa48("410") ? false : stryMutAct_9fa48("409") ? true : (stryCov_9fa48("409", "410", "411", "412"), Object.keys(siblings).length > 0);
        s = hasSiblings ? mergeTwo(target as JsonSchema, siblings, ctx) : target as JsonSchema;
      }
    }
    return s;
  }
};

// ---------------------------------------------------------------------------
// Scalar generators
// ---------------------------------------------------------------------------

const EPOCH_1950 = Date.UTC(1950, 0, 1);
const isoDate = stryMutAct_9fa48("413") ? () => undefined : (stryCov_9fa48("413"), (() => {
  const isoDate = (rng: () => number): string => stryMutAct_9fa48("414") ? new Date(EPOCH_1950 + rng() * (Date.now() - EPOCH_1950)).toISOString() : (stryCov_9fa48("414"), new Date(stryMutAct_9fa48("415") ? EPOCH_1950 - rng() * (Date.now() - EPOCH_1950) : (stryCov_9fa48("415"), EPOCH_1950 + (stryMutAct_9fa48("416") ? rng() / (Date.now() - EPOCH_1950) : (stryCov_9fa48("416"), rng() * (stryMutAct_9fa48("417") ? Date.now() + EPOCH_1950 : (stryCov_9fa48("417"), Date.now() - EPOCH_1950)))))).toISOString().slice(0, 10));
  return isoDate;
})());
const isoDateTime = stryMutAct_9fa48("418") ? () => undefined : (stryCov_9fa48("418"), (() => {
  const isoDateTime = (rng: () => number): string => new Date(stryMutAct_9fa48("419") ? EPOCH_1950 - rng() * (Date.now() - EPOCH_1950) : (stryCov_9fa48("419"), EPOCH_1950 + (stryMutAct_9fa48("420") ? rng() / (Date.now() - EPOCH_1950) : (stryCov_9fa48("420"), rng() * (stryMutAct_9fa48("421") ? Date.now() + EPOCH_1950 : (stryCov_9fa48("421"), Date.now() - EPOCH_1950)))))).toISOString();
  return isoDateTime;
})());
const uuid = (rng: () => number): string => {
  if (stryMutAct_9fa48("422")) {
    {}
  } else {
    stryCov_9fa48("422");
    const hex = stryMutAct_9fa48("423") ? "" : (stryCov_9fa48("423"), "0123456789abcdef");
    const seg = stryMutAct_9fa48("424") ? () => undefined : (stryCov_9fa48("424"), (() => {
      const seg = (n: number) => Array.from(stryMutAct_9fa48("425") ? {} : (stryCov_9fa48("425"), {
        length: n
      }), stryMutAct_9fa48("426") ? () => undefined : (stryCov_9fa48("426"), () => hex[Math.floor(stryMutAct_9fa48("427") ? rng() / 16 : (stryCov_9fa48("427"), rng() * 16))])).join(stryMutAct_9fa48("428") ? "Stryker was here!" : (stryCov_9fa48("428"), ""));
      return seg;
    })());
    return stryMutAct_9fa48("429") ? `` : (stryCov_9fa48("429"), `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`);
  }
};

/** CPF with valid mod-11 check digits (pt-BR tax id). */
const cpf = (rng: () => number): string => {
  if (stryMutAct_9fa48("430")) {
    {}
  } else {
    stryCov_9fa48("430");
    const digits = Array.from(stryMutAct_9fa48("431") ? {} : (stryCov_9fa48("431"), {
      length: 9
    }), stryMutAct_9fa48("432") ? () => undefined : (stryCov_9fa48("432"), () => Math.floor(stryMutAct_9fa48("433") ? rng() / 10 : (stryCov_9fa48("433"), rng() * 10))));
    const dv = (nums: number[], weights: number[]): number => {
      if (stryMutAct_9fa48("434")) {
        {}
      } else {
        stryCov_9fa48("434");
        const sum = nums.reduce(stryMutAct_9fa48("435") ? () => undefined : (stryCov_9fa48("435"), (acc, d, i) => stryMutAct_9fa48("436") ? acc - d * weights[i] : (stryCov_9fa48("436"), acc + (stryMutAct_9fa48("437") ? d / weights[i] : (stryCov_9fa48("437"), d * weights[i])))), 0);
        const r = stryMutAct_9fa48("438") ? sum * 10 * 11 : (stryCov_9fa48("438"), (stryMutAct_9fa48("439") ? sum / 10 : (stryCov_9fa48("439"), sum * 10)) % 11);
        return (stryMutAct_9fa48("442") ? r !== 10 : stryMutAct_9fa48("441") ? false : stryMutAct_9fa48("440") ? true : (stryCov_9fa48("440", "441", "442"), r === 10)) ? 0 : r;
      }
    };
    const w1 = stryMutAct_9fa48("443") ? [] : (stryCov_9fa48("443"), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d1 = dv(digits, w1);
    const w2 = stryMutAct_9fa48("444") ? [] : (stryCov_9fa48("444"), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = dv(stryMutAct_9fa48("445") ? [] : (stryCov_9fa48("445"), [...digits, d1]), w2);
    return (stryMutAct_9fa48("446") ? [] : (stryCov_9fa48("446"), [...digits, d1, d2])).join(stryMutAct_9fa48("447") ? "Stryker was here!" : (stryCov_9fa48("447"), ""));
  }
};
const phone = stryMutAct_9fa48("448") ? () => undefined : (stryCov_9fa48("448"), (() => {
  const phone = (pools: LocalePools, rng: () => number): string => (stryMutAct_9fa48("451") ? pools.phoneStyle !== "br" : stryMutAct_9fa48("450") ? false : stryMutAct_9fa48("449") ? true : (stryCov_9fa48("449", "450", "451"), pools.phoneStyle === (stryMutAct_9fa48("452") ? "" : (stryCov_9fa48("452"), "br")))) ? stryMutAct_9fa48("453") ? `` : (stryCov_9fa48("453"), `(${int(rng, 11, 99)}) 9${int(rng, 1000, 9999)}-${int(rng, 1000, 9999)}`) : stryMutAct_9fa48("454") ? `` : (stryCov_9fa48("454"), `(${int(rng, 200, 999)}) ${int(rng, 200, 999)}-${int(rng, 1000, 9999)}`);
  return phone;
})());
const postalCode = stryMutAct_9fa48("455") ? () => undefined : (stryCov_9fa48("455"), (() => {
  const postalCode = (pools: LocalePools, rng: () => number): string => (stryMutAct_9fa48("458") ? pools.countryCode !== "BR" : stryMutAct_9fa48("457") ? false : stryMutAct_9fa48("456") ? true : (stryCov_9fa48("456", "457", "458"), pools.countryCode === (stryMutAct_9fa48("459") ? "" : (stryCov_9fa48("459"), "BR")))) ? stryMutAct_9fa48("460") ? `` : (stryCov_9fa48("460"), `${int(rng, 10000, 99999)}-${int(rng, 100, 999)}`) : stryMutAct_9fa48("461") ? `` : (stryCov_9fa48("461"), `${int(rng, 10000, 99999)}`);
  return postalCode;
})());
const email = (ctx: Ctx): string => {
  if (stryMutAct_9fa48("462")) {
    {}
  } else {
    stryCov_9fa48("462");
    const first = slug(ctx.pools.firstNames[Math.floor(stryMutAct_9fa48("463") ? ctx.rng() / ctx.pools.firstNames.length : (stryCov_9fa48("463"), ctx.rng() * ctx.pools.firstNames.length))]);
    const last = slug(ctx.pools.lastNames[Math.floor(stryMutAct_9fa48("464") ? ctx.rng() / ctx.pools.lastNames.length : (stryCov_9fa48("464"), ctx.rng() * ctx.pools.lastNames.length))]);
    return stryMutAct_9fa48("465") ? `` : (stryCov_9fa48("465"), `${first}.${last}${int(ctx.rng, 1, 99)}@${pick(ctx.rng, ctx.pools.emailDomains)}`);
  }
};
const fullName = (ctx: Ctx): string => {
  if (stryMutAct_9fa48("466")) {
    {}
  } else {
    stryCov_9fa48("466");
    const f = pick(ctx.rng, ctx.pools.firstNames);
    const l = pick(ctx.rng, ctx.pools.lastNames);
    return chance(ctx.rng, 0.3) ? stryMutAct_9fa48("467") ? `` : (stryCov_9fa48("467"), `${f} ${l} ${pick(ctx.rng, ctx.pools.lastNames)}`) : stryMutAct_9fa48("468") ? `` : (stryCov_9fa48("468"), `${f} ${l}`);
  }
};
const slug = stryMutAct_9fa48("469") ? () => undefined : (stryCov_9fa48("469"), (() => {
  const slug = (s: string): string => stryMutAct_9fa48("470") ? s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^a-z0-9]/g, "") : (stryCov_9fa48("470"), s.normalize(stryMutAct_9fa48("471") ? "" : (stryCov_9fa48("471"), "NFD")).replace(stryMutAct_9fa48("472") ? /[^̀-ͯ]/g : (stryCov_9fa48("472"), /[̀-ͯ]/g), stryMutAct_9fa48("473") ? "Stryker was here!" : (stryCov_9fa48("473"), "")).toLowerCase().replace(stryMutAct_9fa48("474") ? /[a-z0-9]/g : (stryCov_9fa48("474"), /[^a-z0-9]/g), stryMutAct_9fa48("475") ? "Stryker was here!" : (stryCov_9fa48("475"), "")));
  return slug;
})());
const randomWords = stryMutAct_9fa48("476") ? () => undefined : (stryCov_9fa48("476"), (() => {
  const randomWords = (ctx: Ctx, count: number): string => Array.from(stryMutAct_9fa48("477") ? {} : (stryCov_9fa48("477"), {
    length: count
  }), stryMutAct_9fa48("478") ? () => undefined : (stryCov_9fa48("478"), () => pick(ctx.rng, ctx.pools.words))).join(stryMutAct_9fa48("479") ? "" : (stryCov_9fa48("479"), " "));
  return randomWords;
})());

/**
 * Field-name → realistic value heuristics. `key` is the object
 * property name (any case); matched loosely against pt-BR and en
 * vocabulary. Best-effort by design — `pattern`/`enum` constraints
 * still take precedence upstream.
 */
const stringForKey = (key: string, ctx: Ctx): string => {
  if (stryMutAct_9fa48("480")) {
    {}
  } else {
    stryCov_9fa48("480");
    const k = stryMutAct_9fa48("481") ? key.toUpperCase() : (stryCov_9fa48("481"), key.toLowerCase());
    const {
      pools,
      rng
    } = ctx;
    if (stryMutAct_9fa48("483") ? false : stryMutAct_9fa48("482") ? true : (stryCov_9fa48("482", "483"), k.includes(stryMutAct_9fa48("484") ? "" : (stryCov_9fa48("484"), "cpf")))) return cpf(rng);
    if (stryMutAct_9fa48("486") ? false : stryMutAct_9fa48("485") ? true : (stryCov_9fa48("485", "486"), k.includes(stryMutAct_9fa48("487") ? "" : (stryCov_9fa48("487"), "cnpj")))) return Array.from(stryMutAct_9fa48("488") ? {} : (stryCov_9fa48("488"), {
      length: 14
    }), stryMutAct_9fa48("489") ? () => undefined : (stryCov_9fa48("489"), () => Math.floor(stryMutAct_9fa48("490") ? rng() / 10 : (stryCov_9fa48("490"), rng() * 10)))).join(stryMutAct_9fa48("491") ? "Stryker was here!" : (stryCov_9fa48("491"), ""));
    if (stryMutAct_9fa48("494") ? (k.includes("email") || k === "mail") && k.includes("emailaddress") : stryMutAct_9fa48("493") ? false : stryMutAct_9fa48("492") ? true : (stryCov_9fa48("492", "493", "494"), (stryMutAct_9fa48("496") ? k.includes("email") && k === "mail" : stryMutAct_9fa48("495") ? false : (stryCov_9fa48("495", "496"), k.includes(stryMutAct_9fa48("497") ? "" : (stryCov_9fa48("497"), "email")) || (stryMutAct_9fa48("499") ? k !== "mail" : stryMutAct_9fa48("498") ? false : (stryCov_9fa48("498", "499"), k === (stryMutAct_9fa48("500") ? "" : (stryCov_9fa48("500"), "mail")))))) || k.includes(stryMutAct_9fa48("501") ? "" : (stryCov_9fa48("501"), "emailaddress")))) return email(ctx);
    if (stryMutAct_9fa48("504") ? (k.includes("username") || k === "user" || k.includes("login")) && k.includes("handle") : stryMutAct_9fa48("503") ? false : stryMutAct_9fa48("502") ? true : (stryCov_9fa48("502", "503", "504"), (stryMutAct_9fa48("506") ? (k.includes("username") || k === "user") && k.includes("login") : stryMutAct_9fa48("505") ? false : (stryCov_9fa48("505", "506"), (stryMutAct_9fa48("508") ? k.includes("username") && k === "user" : stryMutAct_9fa48("507") ? false : (stryCov_9fa48("507", "508"), k.includes(stryMutAct_9fa48("509") ? "" : (stryCov_9fa48("509"), "username")) || (stryMutAct_9fa48("511") ? k !== "user" : stryMutAct_9fa48("510") ? false : (stryCov_9fa48("510", "511"), k === (stryMutAct_9fa48("512") ? "" : (stryCov_9fa48("512"), "user")))))) || k.includes(stryMutAct_9fa48("513") ? "" : (stryCov_9fa48("513"), "login")))) || k.includes(stryMutAct_9fa48("514") ? "" : (stryCov_9fa48("514"), "handle")))) {
      if (stryMutAct_9fa48("515")) {
        {}
      } else {
        stryCov_9fa48("515");
        return stryMutAct_9fa48("516") ? `` : (stryCov_9fa48("516"), `${slug(pick(rng, pools.firstNames))}.${slug(pick(rng, pools.lastNames))}${int(rng, 1, 99)}`);
      }
    }
    if (stryMutAct_9fa48("519") ? (k.includes("phone") || k.includes("telefone") || k.includes("celular") || k.includes("whatsapp") || k === "tel" || k.includes("mobile")) && k.includes("fax") : stryMutAct_9fa48("518") ? false : stryMutAct_9fa48("517") ? true : (stryCov_9fa48("517", "518", "519"), (stryMutAct_9fa48("521") ? (k.includes("phone") || k.includes("telefone") || k.includes("celular") || k.includes("whatsapp") || k === "tel") && k.includes("mobile") : stryMutAct_9fa48("520") ? false : (stryCov_9fa48("520", "521"), (stryMutAct_9fa48("523") ? (k.includes("phone") || k.includes("telefone") || k.includes("celular") || k.includes("whatsapp")) && k === "tel" : stryMutAct_9fa48("522") ? false : (stryCov_9fa48("522", "523"), (stryMutAct_9fa48("525") ? (k.includes("phone") || k.includes("telefone") || k.includes("celular")) && k.includes("whatsapp") : stryMutAct_9fa48("524") ? false : (stryCov_9fa48("524", "525"), (stryMutAct_9fa48("527") ? (k.includes("phone") || k.includes("telefone")) && k.includes("celular") : stryMutAct_9fa48("526") ? false : (stryCov_9fa48("526", "527"), (stryMutAct_9fa48("529") ? k.includes("phone") && k.includes("telefone") : stryMutAct_9fa48("528") ? false : (stryCov_9fa48("528", "529"), k.includes(stryMutAct_9fa48("530") ? "" : (stryCov_9fa48("530"), "phone")) || k.includes(stryMutAct_9fa48("531") ? "" : (stryCov_9fa48("531"), "telefone")))) || k.includes(stryMutAct_9fa48("532") ? "" : (stryCov_9fa48("532"), "celular")))) || k.includes(stryMutAct_9fa48("533") ? "" : (stryCov_9fa48("533"), "whatsapp")))) || (stryMutAct_9fa48("535") ? k !== "tel" : stryMutAct_9fa48("534") ? false : (stryCov_9fa48("534", "535"), k === (stryMutAct_9fa48("536") ? "" : (stryCov_9fa48("536"), "tel")))))) || k.includes(stryMutAct_9fa48("537") ? "" : (stryCov_9fa48("537"), "mobile")))) || k.includes(stryMutAct_9fa48("538") ? "" : (stryCov_9fa48("538"), "fax")))) {
      if (stryMutAct_9fa48("539")) {
        {}
      } else {
        stryCov_9fa48("539");
        return phone(pools, rng);
      }
    }
    if (stryMutAct_9fa48("542") ? (k.includes("cep") || k.includes("postal") || k.includes("postcode") || k.includes("zipcode")) && k === "zip" : stryMutAct_9fa48("541") ? false : stryMutAct_9fa48("540") ? true : (stryCov_9fa48("540", "541", "542"), (stryMutAct_9fa48("544") ? (k.includes("cep") || k.includes("postal") || k.includes("postcode")) && k.includes("zipcode") : stryMutAct_9fa48("543") ? false : (stryCov_9fa48("543", "544"), (stryMutAct_9fa48("546") ? (k.includes("cep") || k.includes("postal")) && k.includes("postcode") : stryMutAct_9fa48("545") ? false : (stryCov_9fa48("545", "546"), (stryMutAct_9fa48("548") ? k.includes("cep") && k.includes("postal") : stryMutAct_9fa48("547") ? false : (stryCov_9fa48("547", "548"), k.includes(stryMutAct_9fa48("549") ? "" : (stryCov_9fa48("549"), "cep")) || k.includes(stryMutAct_9fa48("550") ? "" : (stryCov_9fa48("550"), "postal")))) || k.includes(stryMutAct_9fa48("551") ? "" : (stryCov_9fa48("551"), "postcode")))) || k.includes(stryMutAct_9fa48("552") ? "" : (stryCov_9fa48("552"), "zipcode")))) || (stryMutAct_9fa48("554") ? k !== "zip" : stryMutAct_9fa48("553") ? false : (stryCov_9fa48("553", "554"), k === (stryMutAct_9fa48("555") ? "" : (stryCov_9fa48("555"), "zip")))))) {
      if (stryMutAct_9fa48("556")) {
        {}
      } else {
        stryCov_9fa48("556");
        return postalCode(pools, rng);
      }
    }
    if (stryMutAct_9fa48("559") ? (k.includes("url") || k.includes("uri") || k.includes("website") || k.includes("homepage") || k.includes("avatar")) && k.includes("link") && !k.includes("unlink") : stryMutAct_9fa48("558") ? false : stryMutAct_9fa48("557") ? true : (stryCov_9fa48("557", "558", "559"), (stryMutAct_9fa48("561") ? (k.includes("url") || k.includes("uri") || k.includes("website") || k.includes("homepage")) && k.includes("avatar") : stryMutAct_9fa48("560") ? false : (stryCov_9fa48("560", "561"), (stryMutAct_9fa48("563") ? (k.includes("url") || k.includes("uri") || k.includes("website")) && k.includes("homepage") : stryMutAct_9fa48("562") ? false : (stryCov_9fa48("562", "563"), (stryMutAct_9fa48("565") ? (k.includes("url") || k.includes("uri")) && k.includes("website") : stryMutAct_9fa48("564") ? false : (stryCov_9fa48("564", "565"), (stryMutAct_9fa48("567") ? k.includes("url") && k.includes("uri") : stryMutAct_9fa48("566") ? false : (stryCov_9fa48("566", "567"), k.includes(stryMutAct_9fa48("568") ? "" : (stryCov_9fa48("568"), "url")) || k.includes(stryMutAct_9fa48("569") ? "" : (stryCov_9fa48("569"), "uri")))) || k.includes(stryMutAct_9fa48("570") ? "" : (stryCov_9fa48("570"), "website")))) || k.includes(stryMutAct_9fa48("571") ? "" : (stryCov_9fa48("571"), "homepage")))) || k.includes(stryMutAct_9fa48("572") ? "" : (stryCov_9fa48("572"), "avatar")))) || (stryMutAct_9fa48("574") ? k.includes("link") || !k.includes("unlink") : stryMutAct_9fa48("573") ? false : (stryCov_9fa48("573", "574"), k.includes(stryMutAct_9fa48("575") ? "" : (stryCov_9fa48("575"), "link")) && (stryMutAct_9fa48("576") ? k.includes("unlink") : (stryCov_9fa48("576"), !k.includes(stryMutAct_9fa48("577") ? "" : (stryCov_9fa48("577"), "unlink")))))))) {
      if (stryMutAct_9fa48("578")) {
        {}
      } else {
        stryCov_9fa48("578");
        return stryMutAct_9fa48("579") ? `` : (stryCov_9fa48("579"), `https://www.${pick(rng, pools.emailDomains)}/${pick(rng, pools.words)}`);
      }
    }
    if (stryMutAct_9fa48("582") ? (k.includes("birth") || k.includes("nascimento")) && k === "dob" : stryMutAct_9fa48("581") ? false : stryMutAct_9fa48("580") ? true : (stryCov_9fa48("580", "581", "582"), (stryMutAct_9fa48("584") ? k.includes("birth") && k.includes("nascimento") : stryMutAct_9fa48("583") ? false : (stryCov_9fa48("583", "584"), k.includes(stryMutAct_9fa48("585") ? "" : (stryCov_9fa48("585"), "birth")) || k.includes(stryMutAct_9fa48("586") ? "" : (stryCov_9fa48("586"), "nascimento")))) || (stryMutAct_9fa48("588") ? k !== "dob" : stryMutAct_9fa48("587") ? false : (stryCov_9fa48("587", "588"), k === (stryMutAct_9fa48("589") ? "" : (stryCov_9fa48("589"), "dob")))))) return isoDate(rng);
    // camelCase "…At" (createdAt), snake "…_at" or explicit timestamp —
    // deliberately NOT plain /at$/i so "format"/"that" don't match.
    if (stryMutAct_9fa48("592") ? (/[A-Z]t$/.test(key) || /[_-]at$/.test(k)) && k === "timestamp" : stryMutAct_9fa48("591") ? false : stryMutAct_9fa48("590") ? true : (stryCov_9fa48("590", "591", "592"), (stryMutAct_9fa48("594") ? /[A-Z]t$/.test(key) && /[_-]at$/.test(k) : stryMutAct_9fa48("593") ? false : (stryCov_9fa48("593", "594"), (stryMutAct_9fa48("596") ? /[^A-Z]t$/ : stryMutAct_9fa48("595") ? /[A-Z]t/ : (stryCov_9fa48("595", "596"), /[A-Z]t$/)).test(key) || (stryMutAct_9fa48("598") ? /[^_-]at$/ : stryMutAct_9fa48("597") ? /[_-]at/ : (stryCov_9fa48("597", "598"), /[_-]at$/)).test(k))) || (stryMutAct_9fa48("600") ? k !== "timestamp" : stryMutAct_9fa48("599") ? false : (stryCov_9fa48("599", "600"), k === (stryMutAct_9fa48("601") ? "" : (stryCov_9fa48("601"), "timestamp")))))) return isoDateTime(rng);
    if (stryMutAct_9fa48("604") ? (k.includes("date") || k.includes("data")) && !k.includes("update") && !k.includes("candidate") && !k.includes("validate") || !k.includes("mandate") : stryMutAct_9fa48("603") ? false : stryMutAct_9fa48("602") ? true : (stryCov_9fa48("602", "603", "604"), (stryMutAct_9fa48("606") ? (k.includes("date") || k.includes("data")) && !k.includes("update") && !k.includes("candidate") || !k.includes("validate") : stryMutAct_9fa48("605") ? true : (stryCov_9fa48("605", "606"), (stryMutAct_9fa48("608") ? (k.includes("date") || k.includes("data")) && !k.includes("update") || !k.includes("candidate") : stryMutAct_9fa48("607") ? true : (stryCov_9fa48("607", "608"), (stryMutAct_9fa48("610") ? k.includes("date") || k.includes("data") || !k.includes("update") : stryMutAct_9fa48("609") ? true : (stryCov_9fa48("609", "610"), (stryMutAct_9fa48("612") ? k.includes("date") && k.includes("data") : stryMutAct_9fa48("611") ? true : (stryCov_9fa48("611", "612"), k.includes(stryMutAct_9fa48("613") ? "" : (stryCov_9fa48("613"), "date")) || k.includes(stryMutAct_9fa48("614") ? "" : (stryCov_9fa48("614"), "data")))) && (stryMutAct_9fa48("615") ? k.includes("update") : (stryCov_9fa48("615"), !k.includes(stryMutAct_9fa48("616") ? "" : (stryCov_9fa48("616"), "update")))))) && (stryMutAct_9fa48("617") ? k.includes("candidate") : (stryCov_9fa48("617"), !k.includes(stryMutAct_9fa48("618") ? "" : (stryCov_9fa48("618"), "candidate")))))) && (stryMutAct_9fa48("619") ? k.includes("validate") : (stryCov_9fa48("619"), !k.includes(stryMutAct_9fa48("620") ? "" : (stryCov_9fa48("620"), "validate")))))) && (stryMutAct_9fa48("621") ? k.includes("mandate") : (stryCov_9fa48("621"), !k.includes(stryMutAct_9fa48("622") ? "" : (stryCov_9fa48("622"), "mandate")))))) {
      if (stryMutAct_9fa48("623")) {
        {}
      } else {
        stryCov_9fa48("623");
        return isoDate(rng);
      }
    }
    if (stryMutAct_9fa48("626") ? (k.includes("filename") || k.includes("file_name") || k.includes("filepath")) && k.includes("filetype") : stryMutAct_9fa48("625") ? false : stryMutAct_9fa48("624") ? true : (stryCov_9fa48("624", "625", "626"), (stryMutAct_9fa48("628") ? (k.includes("filename") || k.includes("file_name")) && k.includes("filepath") : stryMutAct_9fa48("627") ? false : (stryCov_9fa48("627", "628"), (stryMutAct_9fa48("630") ? k.includes("filename") && k.includes("file_name") : stryMutAct_9fa48("629") ? false : (stryCov_9fa48("629", "630"), k.includes(stryMutAct_9fa48("631") ? "" : (stryCov_9fa48("631"), "filename")) || k.includes(stryMutAct_9fa48("632") ? "" : (stryCov_9fa48("632"), "file_name")))) || k.includes(stryMutAct_9fa48("633") ? "" : (stryCov_9fa48("633"), "filepath")))) || k.includes(stryMutAct_9fa48("634") ? "" : (stryCov_9fa48("634"), "filetype")))) {
      if (stryMutAct_9fa48("635")) {
        {}
      } else {
        stryCov_9fa48("635");
        return stryMutAct_9fa48("636") ? `` : (stryCov_9fa48("636"), `${pick(rng, pools.words)}-${int(rng, 100, 9999)}`);
      }
    }
    if (stryMutAct_9fa48("639") ? (k.includes("firstname") || k.includes("first_name") || k.includes("givenname")) && k === "fname" : stryMutAct_9fa48("638") ? false : stryMutAct_9fa48("637") ? true : (stryCov_9fa48("637", "638", "639"), (stryMutAct_9fa48("641") ? (k.includes("firstname") || k.includes("first_name")) && k.includes("givenname") : stryMutAct_9fa48("640") ? false : (stryCov_9fa48("640", "641"), (stryMutAct_9fa48("643") ? k.includes("firstname") && k.includes("first_name") : stryMutAct_9fa48("642") ? false : (stryCov_9fa48("642", "643"), k.includes(stryMutAct_9fa48("644") ? "" : (stryCov_9fa48("644"), "firstname")) || k.includes(stryMutAct_9fa48("645") ? "" : (stryCov_9fa48("645"), "first_name")))) || k.includes(stryMutAct_9fa48("646") ? "" : (stryCov_9fa48("646"), "givenname")))) || (stryMutAct_9fa48("648") ? k !== "fname" : stryMutAct_9fa48("647") ? false : (stryCov_9fa48("647", "648"), k === (stryMutAct_9fa48("649") ? "" : (stryCov_9fa48("649"), "fname")))))) {
      if (stryMutAct_9fa48("650")) {
        {}
      } else {
        stryCov_9fa48("650");
        return pick(rng, pools.firstNames);
      }
    }
    if (stryMutAct_9fa48("653") ? (k.includes("lastname") || k.includes("last_name") || k.includes("surname") || k.includes("familyname")) && k === "lname" : stryMutAct_9fa48("652") ? false : stryMutAct_9fa48("651") ? true : (stryCov_9fa48("651", "652", "653"), (stryMutAct_9fa48("655") ? (k.includes("lastname") || k.includes("last_name") || k.includes("surname")) && k.includes("familyname") : stryMutAct_9fa48("654") ? false : (stryCov_9fa48("654", "655"), (stryMutAct_9fa48("657") ? (k.includes("lastname") || k.includes("last_name")) && k.includes("surname") : stryMutAct_9fa48("656") ? false : (stryCov_9fa48("656", "657"), (stryMutAct_9fa48("659") ? k.includes("lastname") && k.includes("last_name") : stryMutAct_9fa48("658") ? false : (stryCov_9fa48("658", "659"), k.includes(stryMutAct_9fa48("660") ? "" : (stryCov_9fa48("660"), "lastname")) || k.includes(stryMutAct_9fa48("661") ? "" : (stryCov_9fa48("661"), "last_name")))) || k.includes(stryMutAct_9fa48("662") ? "" : (stryCov_9fa48("662"), "surname")))) || k.includes(stryMutAct_9fa48("663") ? "" : (stryCov_9fa48("663"), "familyname")))) || (stryMutAct_9fa48("665") ? k !== "lname" : stryMutAct_9fa48("664") ? false : (stryCov_9fa48("664", "665"), k === (stryMutAct_9fa48("666") ? "" : (stryCov_9fa48("666"), "lname")))))) {
      if (stryMutAct_9fa48("667")) {
        {}
      } else {
        stryCov_9fa48("667");
        return pick(rng, pools.lastNames);
      }
    }
    if (stryMutAct_9fa48("670") ? (k.includes("socialname") || k.includes("nickname")) && k.includes("apelido") : stryMutAct_9fa48("669") ? false : stryMutAct_9fa48("668") ? true : (stryCov_9fa48("668", "669", "670"), (stryMutAct_9fa48("672") ? k.includes("socialname") && k.includes("nickname") : stryMutAct_9fa48("671") ? false : (stryCov_9fa48("671", "672"), k.includes(stryMutAct_9fa48("673") ? "" : (stryCov_9fa48("673"), "socialname")) || k.includes(stryMutAct_9fa48("674") ? "" : (stryCov_9fa48("674"), "nickname")))) || k.includes(stryMutAct_9fa48("675") ? "" : (stryCov_9fa48("675"), "apelido")))) {
      if (stryMutAct_9fa48("676")) {
        {}
      } else {
        stryCov_9fa48("676");
        return pick(rng, pools.firstNames);
      }
    }
    if (stryMutAct_9fa48("679") ? (k === "name" || k === "nome" || k.includes("fullname") || k.endsWith("name")) && k.endsWith("nome") : stryMutAct_9fa48("678") ? false : stryMutAct_9fa48("677") ? true : (stryCov_9fa48("677", "678", "679"), (stryMutAct_9fa48("681") ? (k === "name" || k === "nome" || k.includes("fullname")) && k.endsWith("name") : stryMutAct_9fa48("680") ? false : (stryCov_9fa48("680", "681"), (stryMutAct_9fa48("683") ? (k === "name" || k === "nome") && k.includes("fullname") : stryMutAct_9fa48("682") ? false : (stryCov_9fa48("682", "683"), (stryMutAct_9fa48("685") ? k === "name" && k === "nome" : stryMutAct_9fa48("684") ? false : (stryCov_9fa48("684", "685"), (stryMutAct_9fa48("687") ? k !== "name" : stryMutAct_9fa48("686") ? false : (stryCov_9fa48("686", "687"), k === (stryMutAct_9fa48("688") ? "" : (stryCov_9fa48("688"), "name")))) || (stryMutAct_9fa48("690") ? k !== "nome" : stryMutAct_9fa48("689") ? false : (stryCov_9fa48("689", "690"), k === (stryMutAct_9fa48("691") ? "" : (stryCov_9fa48("691"), "nome")))))) || k.includes(stryMutAct_9fa48("692") ? "" : (stryCov_9fa48("692"), "fullname")))) || (stryMutAct_9fa48("693") ? k.startsWith("name") : (stryCov_9fa48("693"), k.endsWith(stryMutAct_9fa48("694") ? "" : (stryCov_9fa48("694"), "name")))))) || (stryMutAct_9fa48("695") ? k.startsWith("nome") : (stryCov_9fa48("695"), k.endsWith(stryMutAct_9fa48("696") ? "" : (stryCov_9fa48("696"), "nome")))))) {
      if (stryMutAct_9fa48("697")) {
        {}
      } else {
        stryCov_9fa48("697");
        return fullName(ctx);
      }
    }
    if (stryMutAct_9fa48("700") ? (k.includes("city") || k.includes("cidade") || k.includes("town")) && k.includes("municipio") : stryMutAct_9fa48("699") ? false : stryMutAct_9fa48("698") ? true : (stryCov_9fa48("698", "699", "700"), (stryMutAct_9fa48("702") ? (k.includes("city") || k.includes("cidade")) && k.includes("town") : stryMutAct_9fa48("701") ? false : (stryCov_9fa48("701", "702"), (stryMutAct_9fa48("704") ? k.includes("city") && k.includes("cidade") : stryMutAct_9fa48("703") ? false : (stryCov_9fa48("703", "704"), k.includes(stryMutAct_9fa48("705") ? "" : (stryCov_9fa48("705"), "city")) || k.includes(stryMutAct_9fa48("706") ? "" : (stryCov_9fa48("706"), "cidade")))) || k.includes(stryMutAct_9fa48("707") ? "" : (stryCov_9fa48("707"), "town")))) || k.includes(stryMutAct_9fa48("708") ? "" : (stryCov_9fa48("708"), "municipio")))) {
      if (stryMutAct_9fa48("709")) {
        {}
      } else {
        stryCov_9fa48("709");
        return pick(rng, pools.cities);
      }
    }
    if (stryMutAct_9fa48("712") ? (k === "uf" || k === "state" || k.endsWith("state")) && k.includes("estado") : stryMutAct_9fa48("711") ? false : stryMutAct_9fa48("710") ? true : (stryCov_9fa48("710", "711", "712"), (stryMutAct_9fa48("714") ? (k === "uf" || k === "state") && k.endsWith("state") : stryMutAct_9fa48("713") ? false : (stryCov_9fa48("713", "714"), (stryMutAct_9fa48("716") ? k === "uf" && k === "state" : stryMutAct_9fa48("715") ? false : (stryCov_9fa48("715", "716"), (stryMutAct_9fa48("718") ? k !== "uf" : stryMutAct_9fa48("717") ? false : (stryCov_9fa48("717", "718"), k === (stryMutAct_9fa48("719") ? "" : (stryCov_9fa48("719"), "uf")))) || (stryMutAct_9fa48("721") ? k !== "state" : stryMutAct_9fa48("720") ? false : (stryCov_9fa48("720", "721"), k === (stryMutAct_9fa48("722") ? "" : (stryCov_9fa48("722"), "state")))))) || (stryMutAct_9fa48("723") ? k.startsWith("state") : (stryCov_9fa48("723"), k.endsWith(stryMutAct_9fa48("724") ? "" : (stryCov_9fa48("724"), "state")))))) || k.includes(stryMutAct_9fa48("725") ? "" : (stryCov_9fa48("725"), "estado")))) {
      if (stryMutAct_9fa48("726")) {
        {}
      } else {
        stryCov_9fa48("726");
        return pick(rng, pools.states);
      }
    }
    if (stryMutAct_9fa48("729") ? (k.includes("district") || k.includes("bairro") || k.includes("neighborhood")) && k.includes("suburb") : stryMutAct_9fa48("728") ? false : stryMutAct_9fa48("727") ? true : (stryCov_9fa48("727", "728", "729"), (stryMutAct_9fa48("731") ? (k.includes("district") || k.includes("bairro")) && k.includes("neighborhood") : stryMutAct_9fa48("730") ? false : (stryCov_9fa48("730", "731"), (stryMutAct_9fa48("733") ? k.includes("district") && k.includes("bairro") : stryMutAct_9fa48("732") ? false : (stryCov_9fa48("732", "733"), k.includes(stryMutAct_9fa48("734") ? "" : (stryCov_9fa48("734"), "district")) || k.includes(stryMutAct_9fa48("735") ? "" : (stryCov_9fa48("735"), "bairro")))) || k.includes(stryMutAct_9fa48("736") ? "" : (stryCov_9fa48("736"), "neighborhood")))) || k.includes(stryMutAct_9fa48("737") ? "" : (stryCov_9fa48("737"), "suburb")))) {
      if (stryMutAct_9fa48("738")) {
        {}
      } else {
        stryCov_9fa48("738");
        return pick(rng, pools.neighborhoods);
      }
    }
    // number before address so "addressNumber"/"streetNumber" → digits.
    if (stryMutAct_9fa48("741") ? (k.includes("number") || k.includes("numero")) && k === "num" : stryMutAct_9fa48("740") ? false : stryMutAct_9fa48("739") ? true : (stryCov_9fa48("739", "740", "741"), (stryMutAct_9fa48("743") ? k.includes("number") && k.includes("numero") : stryMutAct_9fa48("742") ? false : (stryCov_9fa48("742", "743"), k.includes(stryMutAct_9fa48("744") ? "" : (stryCov_9fa48("744"), "number")) || k.includes(stryMutAct_9fa48("745") ? "" : (stryCov_9fa48("745"), "numero")))) || (stryMutAct_9fa48("747") ? k !== "num" : stryMutAct_9fa48("746") ? false : (stryCov_9fa48("746", "747"), k === (stryMutAct_9fa48("748") ? "" : (stryCov_9fa48("748"), "num")))))) {
      if (stryMutAct_9fa48("749")) {
        {}
      } else {
        stryCov_9fa48("749");
        return String(int(rng, 1, 20000));
      }
    }
    if (stryMutAct_9fa48("752") ? (k.includes("address") || k.includes("endereco") || k.includes("logradouro") || k.includes("street")) && k.includes("avenue") : stryMutAct_9fa48("751") ? false : stryMutAct_9fa48("750") ? true : (stryCov_9fa48("750", "751", "752"), (stryMutAct_9fa48("754") ? (k.includes("address") || k.includes("endereco") || k.includes("logradouro")) && k.includes("street") : stryMutAct_9fa48("753") ? false : (stryCov_9fa48("753", "754"), (stryMutAct_9fa48("756") ? (k.includes("address") || k.includes("endereco")) && k.includes("logradouro") : stryMutAct_9fa48("755") ? false : (stryCov_9fa48("755", "756"), (stryMutAct_9fa48("758") ? k.includes("address") && k.includes("endereco") : stryMutAct_9fa48("757") ? false : (stryCov_9fa48("757", "758"), k.includes(stryMutAct_9fa48("759") ? "" : (stryCov_9fa48("759"), "address")) || k.includes(stryMutAct_9fa48("760") ? "" : (stryCov_9fa48("760"), "endereco")))) || k.includes(stryMutAct_9fa48("761") ? "" : (stryCov_9fa48("761"), "logradouro")))) || k.includes(stryMutAct_9fa48("762") ? "" : (stryCov_9fa48("762"), "street")))) || k.includes(stryMutAct_9fa48("763") ? "" : (stryCov_9fa48("763"), "avenue")))) {
      if (stryMutAct_9fa48("764")) {
        {}
      } else {
        stryCov_9fa48("764");
        return stryMutAct_9fa48("765") ? `` : (stryCov_9fa48("765"), `${pick(rng, stryMutAct_9fa48("766") ? [] : (stryCov_9fa48("766"), [stryMutAct_9fa48("767") ? "" : (stryCov_9fa48("767"), "Rua"), stryMutAct_9fa48("768") ? "" : (stryCov_9fa48("768"), "Avenida"), stryMutAct_9fa48("769") ? "" : (stryCov_9fa48("769"), "Travessa"), stryMutAct_9fa48("770") ? "" : (stryCov_9fa48("770"), "Alameda")]))} ${pick(rng, pools.streets)}`);
      }
    }
    if (stryMutAct_9fa48("773") ? k.includes("complement") && k.includes("complemento") : stryMutAct_9fa48("772") ? false : stryMutAct_9fa48("771") ? true : (stryCov_9fa48("771", "772", "773"), k.includes(stryMutAct_9fa48("774") ? "" : (stryCov_9fa48("774"), "complement")) || k.includes(stryMutAct_9fa48("775") ? "" : (stryCov_9fa48("775"), "complemento")))) {
      if (stryMutAct_9fa48("776")) {
        {}
      } else {
        stryCov_9fa48("776");
        return (stryMutAct_9fa48("779") ? pools.phoneStyle !== "br" : stryMutAct_9fa48("778") ? false : stryMutAct_9fa48("777") ? true : (stryCov_9fa48("777", "778", "779"), pools.phoneStyle === (stryMutAct_9fa48("780") ? "" : (stryCov_9fa48("780"), "br")))) ? stryMutAct_9fa48("781") ? `` : (stryCov_9fa48("781"), `Apto ${int(rng, 1, 500)}`) : stryMutAct_9fa48("782") ? `` : (stryCov_9fa48("782"), `Apt ${int(rng, 1, 500)}`);
      }
    }
    if (stryMutAct_9fa48("785") ? (k.includes("country") || k === "pais") && k.includes("nationality") : stryMutAct_9fa48("784") ? false : stryMutAct_9fa48("783") ? true : (stryCov_9fa48("783", "784", "785"), (stryMutAct_9fa48("787") ? k.includes("country") && k === "pais" : stryMutAct_9fa48("786") ? false : (stryCov_9fa48("786", "787"), k.includes(stryMutAct_9fa48("788") ? "" : (stryCov_9fa48("788"), "country")) || (stryMutAct_9fa48("790") ? k !== "pais" : stryMutAct_9fa48("789") ? false : (stryCov_9fa48("789", "790"), k === (stryMutAct_9fa48("791") ? "" : (stryCov_9fa48("791"), "pais")))))) || k.includes(stryMutAct_9fa48("792") ? "" : (stryCov_9fa48("792"), "nationality")))) return pools.countryCode;
    if (stryMutAct_9fa48("795") ? (k.includes("gender") || k.includes("sexo")) && k === "sex" : stryMutAct_9fa48("794") ? false : stryMutAct_9fa48("793") ? true : (stryCov_9fa48("793", "794", "795"), (stryMutAct_9fa48("797") ? k.includes("gender") && k.includes("sexo") : stryMutAct_9fa48("796") ? false : (stryCov_9fa48("796", "797"), k.includes(stryMutAct_9fa48("798") ? "" : (stryCov_9fa48("798"), "gender")) || k.includes(stryMutAct_9fa48("799") ? "" : (stryCov_9fa48("799"), "sexo")))) || (stryMutAct_9fa48("801") ? k !== "sex" : stryMutAct_9fa48("800") ? false : (stryCov_9fa48("800", "801"), k === (stryMutAct_9fa48("802") ? "" : (stryCov_9fa48("802"), "sex")))))) {
      if (stryMutAct_9fa48("803")) {
        {}
      } else {
        stryCov_9fa48("803");
        return (stryMutAct_9fa48("806") ? pools.phoneStyle !== "br" : stryMutAct_9fa48("805") ? false : stryMutAct_9fa48("804") ? true : (stryCov_9fa48("804", "805", "806"), pools.phoneStyle === (stryMutAct_9fa48("807") ? "" : (stryCov_9fa48("807"), "br")))) ? pick(rng, stryMutAct_9fa48("808") ? [] : (stryCov_9fa48("808"), [stryMutAct_9fa48("809") ? "" : (stryCov_9fa48("809"), "F"), stryMutAct_9fa48("810") ? "" : (stryCov_9fa48("810"), "M")])) : pick(rng, stryMutAct_9fa48("811") ? [] : (stryCov_9fa48("811"), [stryMutAct_9fa48("812") ? "" : (stryCov_9fa48("812"), "female"), stryMutAct_9fa48("813") ? "" : (stryCov_9fa48("813"), "male"), stryMutAct_9fa48("814") ? "" : (stryCov_9fa48("814"), "other")]));
      }
    }
    if (stryMutAct_9fa48("817") ? (k.includes("language") || k.includes("idioma")) && k === "locale" : stryMutAct_9fa48("816") ? false : stryMutAct_9fa48("815") ? true : (stryCov_9fa48("815", "816", "817"), (stryMutAct_9fa48("819") ? k.includes("language") && k.includes("idioma") : stryMutAct_9fa48("818") ? false : (stryCov_9fa48("818", "819"), k.includes(stryMutAct_9fa48("820") ? "" : (stryCov_9fa48("820"), "language")) || k.includes(stryMutAct_9fa48("821") ? "" : (stryCov_9fa48("821"), "idioma")))) || (stryMutAct_9fa48("823") ? k !== "locale" : stryMutAct_9fa48("822") ? false : (stryCov_9fa48("822", "823"), k === (stryMutAct_9fa48("824") ? "" : (stryCov_9fa48("824"), "locale")))))) return pools.localeTag;
    if (stryMutAct_9fa48("826") ? false : stryMutAct_9fa48("825") ? true : (stryCov_9fa48("825", "826"), k.includes(stryMutAct_9fa48("827") ? "" : (stryCov_9fa48("827"), "currency")))) return (stryMutAct_9fa48("830") ? pools.countryCode !== "BR" : stryMutAct_9fa48("829") ? false : stryMutAct_9fa48("828") ? true : (stryCov_9fa48("828", "829", "830"), pools.countryCode === (stryMutAct_9fa48("831") ? "" : (stryCov_9fa48("831"), "BR")))) ? stryMutAct_9fa48("832") ? "" : (stryCov_9fa48("832"), "BRL") : stryMutAct_9fa48("833") ? "" : (stryCov_9fa48("833"), "USD");
    if (stryMutAct_9fa48("836") ? (k === "id" || k === "uuid" || k === "guid" || k === "uid" || k.endsWith("_id") || k.endsWith("uuid")) && k.endsWith("guid") : stryMutAct_9fa48("835") ? false : stryMutAct_9fa48("834") ? true : (stryCov_9fa48("834", "835", "836"), (stryMutAct_9fa48("838") ? (k === "id" || k === "uuid" || k === "guid" || k === "uid" || k.endsWith("_id")) && k.endsWith("uuid") : stryMutAct_9fa48("837") ? false : (stryCov_9fa48("837", "838"), (stryMutAct_9fa48("840") ? (k === "id" || k === "uuid" || k === "guid" || k === "uid") && k.endsWith("_id") : stryMutAct_9fa48("839") ? false : (stryCov_9fa48("839", "840"), (stryMutAct_9fa48("842") ? (k === "id" || k === "uuid" || k === "guid") && k === "uid" : stryMutAct_9fa48("841") ? false : (stryCov_9fa48("841", "842"), (stryMutAct_9fa48("844") ? (k === "id" || k === "uuid") && k === "guid" : stryMutAct_9fa48("843") ? false : (stryCov_9fa48("843", "844"), (stryMutAct_9fa48("846") ? k === "id" && k === "uuid" : stryMutAct_9fa48("845") ? false : (stryCov_9fa48("845", "846"), (stryMutAct_9fa48("848") ? k !== "id" : stryMutAct_9fa48("847") ? false : (stryCov_9fa48("847", "848"), k === (stryMutAct_9fa48("849") ? "" : (stryCov_9fa48("849"), "id")))) || (stryMutAct_9fa48("851") ? k !== "uuid" : stryMutAct_9fa48("850") ? false : (stryCov_9fa48("850", "851"), k === (stryMutAct_9fa48("852") ? "" : (stryCov_9fa48("852"), "uuid")))))) || (stryMutAct_9fa48("854") ? k !== "guid" : stryMutAct_9fa48("853") ? false : (stryCov_9fa48("853", "854"), k === (stryMutAct_9fa48("855") ? "" : (stryCov_9fa48("855"), "guid")))))) || (stryMutAct_9fa48("857") ? k !== "uid" : stryMutAct_9fa48("856") ? false : (stryCov_9fa48("856", "857"), k === (stryMutAct_9fa48("858") ? "" : (stryCov_9fa48("858"), "uid")))))) || (stryMutAct_9fa48("859") ? k.startsWith("_id") : (stryCov_9fa48("859"), k.endsWith(stryMutAct_9fa48("860") ? "" : (stryCov_9fa48("860"), "_id")))))) || (stryMutAct_9fa48("861") ? k.startsWith("uuid") : (stryCov_9fa48("861"), k.endsWith(stryMutAct_9fa48("862") ? "" : (stryCov_9fa48("862"), "uuid")))))) || (stryMutAct_9fa48("863") ? k.startsWith("guid") : (stryCov_9fa48("863"), k.endsWith(stryMutAct_9fa48("864") ? "" : (stryCov_9fa48("864"), "guid")))))) {
      if (stryMutAct_9fa48("865")) {
        {}
      } else {
        stryCov_9fa48("865");
        return uuid(rng);
      }
    }
    return randomWords(ctx, stryMutAct_9fa48("866") ? 1 - int(rng, 0, 2) : (stryCov_9fa48("866"), 1 + int(rng, 0, 2)));
  }
};

/** Enforce minLength/maxLength by padding with words / hard-trimming. */
const fitLength = (value: string, s: JsonSchemaObject, ctx: Ctx): string => {
  if (stryMutAct_9fa48("867")) {
    {}
  } else {
    stryCov_9fa48("867");
    const min = stryMutAct_9fa48("868") ? s.minLength && 0 : (stryCov_9fa48("868"), s.minLength ?? 0);
    const max = s.maxLength;
    if (stryMutAct_9fa48("871") ? max !== undefined || min > max : stryMutAct_9fa48("870") ? false : stryMutAct_9fa48("869") ? true : (stryCov_9fa48("869", "870", "871"), (stryMutAct_9fa48("873") ? max === undefined : stryMutAct_9fa48("872") ? true : (stryCov_9fa48("872", "873"), max !== undefined)) && (stryMutAct_9fa48("876") ? min <= max : stryMutAct_9fa48("875") ? min >= max : stryMutAct_9fa48("874") ? true : (stryCov_9fa48("874", "875", "876"), min > max)))) {
      if (stryMutAct_9fa48("877")) {
        {}
      } else {
        stryCov_9fa48("877");
        throw new SeedError(stryMutAct_9fa48("879") ? `` : (stryCov_9fa48("879"), `minLength ${min} > maxLength ${max}`), ctx.path);
      }
    }
    let out = value;
    if (stryMutAct_9fa48("882") ? max !== undefined || out.length > max : stryMutAct_9fa48("881") ? false : stryMutAct_9fa48("880") ? true : (stryCov_9fa48("880", "881", "882"), (stryMutAct_9fa48("884") ? max === undefined : stryMutAct_9fa48("883") ? true : (stryCov_9fa48("883", "884"), max !== undefined)) && (stryMutAct_9fa48("887") ? out.length <= max : stryMutAct_9fa48("886") ? out.length >= max : stryMutAct_9fa48("885") ? true : (stryCov_9fa48("885", "886", "887"), out.length > max)))) {
      if (stryMutAct_9fa48("888")) {
        {}
      } else {
        stryCov_9fa48("888");
        out = stryMutAct_9fa48("890") ? out.trimEnd() : stryMutAct_9fa48("889") ? out.slice(0, max).trimStart() : (stryCov_9fa48("889", "890"), out.slice(0, max).trimEnd());
      }
    }
    let guard = 0;
    while (stryMutAct_9fa48("892") ? out.length < min || guard++ < 1000 : stryMutAct_9fa48("891") ? false : (stryCov_9fa48("891", "892"), (stryMutAct_9fa48("895") ? out.length >= min : stryMutAct_9fa48("894") ? out.length <= min : stryMutAct_9fa48("893") ? true : (stryCov_9fa48("893", "894", "895"), out.length < min)) && (stryMutAct_9fa48("898") ? guard++ >= 1000 : stryMutAct_9fa48("897") ? guard++ <= 1000 : stryMutAct_9fa48("896") ? true : (stryCov_9fa48("896", "897", "898"), (stryMutAct_9fa48("899") ? guard-- : (stryCov_9fa48("899"), guard++)) < 1000)))) {
      if (stryMutAct_9fa48("900")) {
        {}
      } else {
        stryCov_9fa48("900");
        out = stryMutAct_9fa48("901") ? `` : (stryCov_9fa48("901"), `${out} ${pick(ctx.rng, ctx.pools.words)}`);
      }
    }
    if (stryMutAct_9fa48("905") ? out.length >= min : stryMutAct_9fa48("904") ? out.length <= min : stryMutAct_9fa48("903") ? false : stryMutAct_9fa48("902") ? true : (stryCov_9fa48("902", "903", "904", "905"), out.length < min)) throw new SeedError(stryMutAct_9fa48("907") ? `` : (stryCov_9fa48("907"), `could not reach minLength ${min}`), ctx.path);
    if (stryMutAct_9fa48("910") ? max !== undefined || out.length > max : stryMutAct_9fa48("909") ? false : stryMutAct_9fa48("908") ? true : (stryCov_9fa48("908", "909", "910"), (stryMutAct_9fa48("912") ? max === undefined : stryMutAct_9fa48("911") ? true : (stryCov_9fa48("911", "912"), max !== undefined)) && (stryMutAct_9fa48("915") ? out.length <= max : stryMutAct_9fa48("914") ? out.length >= max : stryMutAct_9fa48("913") ? true : (stryCov_9fa48("913", "914", "915"), out.length > max)))) out = stryMutAct_9fa48("916") ? out : (stryCov_9fa48("916"), out.slice(0, max));
    return out;
  }
};
const genString = (s: JsonSchemaObject, ctx: Ctx): string => {
  if (stryMutAct_9fa48("917")) {
    {}
  } else {
    stryCov_9fa48("917");
    const min = stryMutAct_9fa48("918") ? s.minLength && 0 : (stryCov_9fa48("918"), s.minLength ?? 0);
    const max = s.maxLength;
    if (stryMutAct_9fa48("921") ? typeof s.pattern !== "string" : stryMutAct_9fa48("920") ? false : stryMutAct_9fa48("919") ? true : (stryCov_9fa48("919", "920", "921"), typeof s.pattern === (stryMutAct_9fa48("922") ? "" : (stryCov_9fa48("922"), "string")))) {
      if (stryMutAct_9fa48("923")) {
        {}
      } else {
        stryCov_9fa48("923");
        // ReDoS screen BEFORE any candidate work: `re.test` below is a
        // synchronous, uninterruptible call — an alternation/nested-
        // quantifier repetition like `(a|aa)+b` can hang the event loop
        // on a near-miss candidate. Reject loudly instead (dev tooling:
        // a rare SeedError beats a hang-forever).
        if (stryMutAct_9fa48("925") ? false : stryMutAct_9fa48("924") ? true : (stryCov_9fa48("924", "925"), patternHasUnsafeRepetition(s.pattern))) {
          if (stryMutAct_9fa48("926")) {
            {}
          } else {
            stryCov_9fa48("926");
            throw new SeedError(stryMutAct_9fa48("928") ? `` : (stryCov_9fa48("928"), `pattern /${s.pattern}/ has unsafe repetition (catastrophic backtracking risk)`), ctx.path);
          }
        }
        let re: RegExp;
        try {
          if (stryMutAct_9fa48("929")) {
            {}
          } else {
            stryCov_9fa48("929");
            re = new RegExp(s.pattern);
          }
        } catch {
          if (stryMutAct_9fa48("930")) {
            {}
          } else {
            stryCov_9fa48("930");
            throw new SeedError(stryMutAct_9fa48("932") ? `` : (stryCov_9fa48("932"), `invalid pattern /${s.pattern}/`), ctx.path);
          }
        }
        const limit = stryMutAct_9fa48("933") ? max && 1024 : (stryCov_9fa48("933"), max ?? 1024);
        let lastErr: unknown;
        for (let i = 0; stryMutAct_9fa48("936") ? i >= PATTERN_ATTEMPTS : stryMutAct_9fa48("935") ? i <= PATTERN_ATTEMPTS : stryMutAct_9fa48("934") ? false : (stryCov_9fa48("934", "935", "936"), i < PATTERN_ATTEMPTS); stryMutAct_9fa48("937") ? i-- : (stryCov_9fa48("937"), i++)) {
          if (stryMutAct_9fa48("938")) {
            {}
          } else {
            stryCov_9fa48("938");
            let cand: string;
            try {
              if (stryMutAct_9fa48("939")) {
                {}
              } else {
                stryCov_9fa48("939");
                cand = generateFromPattern(s.pattern, ctx.rng, limit);
              }
            } catch (e) {
              if (stryMutAct_9fa48("940")) {
                {}
              } else {
                stryCov_9fa48("940");
                lastErr = e;
                continue;
              }
            }
            if (stryMutAct_9fa48("943") ? cand.length >= min && (max === undefined || cand.length <= max) || re.test(cand) : stryMutAct_9fa48("942") ? false : stryMutAct_9fa48("941") ? true : (stryCov_9fa48("941", "942", "943"), (stryMutAct_9fa48("945") ? cand.length >= min || max === undefined || cand.length <= max : stryMutAct_9fa48("944") ? true : (stryCov_9fa48("944", "945"), (stryMutAct_9fa48("948") ? cand.length < min : stryMutAct_9fa48("947") ? cand.length > min : stryMutAct_9fa48("946") ? true : (stryCov_9fa48("946", "947", "948"), cand.length >= min)) && (stryMutAct_9fa48("950") ? max === undefined && cand.length <= max : stryMutAct_9fa48("949") ? true : (stryCov_9fa48("949", "950"), (stryMutAct_9fa48("952") ? max !== undefined : stryMutAct_9fa48("951") ? false : (stryCov_9fa48("951", "952"), max === undefined)) || (stryMutAct_9fa48("955") ? cand.length > max : stryMutAct_9fa48("954") ? cand.length < max : stryMutAct_9fa48("953") ? false : (stryCov_9fa48("953", "954", "955"), cand.length <= max)))))) && re.test(cand))) {
              if (stryMutAct_9fa48("956")) {
                {}
              } else {
                stryCov_9fa48("956");
                return cand;
              }
            }
          }
        }
        throw new SeedError(stryMutAct_9fa48("958") ? `` : (stryCov_9fa48("958"), `could not generate a string matching /${s.pattern}/ (${lastErr instanceof Error ? lastErr.message : stryMutAct_9fa48("959") ? "" : (stryCov_9fa48("959"), "no candidate verified")})`), ctx.path);
      }
    }
    const raw = stringForKey(stryMutAct_9fa48("960") ? ctx.key && "" : (stryCov_9fa48("960"), ctx.key ?? (stryMutAct_9fa48("961") ? "Stryker was here!" : (stryCov_9fa48("961"), ""))), ctx);
    return fitLength(raw, s, ctx);
  }
};
const genNumber = (s: JsonSchemaObject, isInt: boolean, ctx: Ctx): number => {
  if (stryMutAct_9fa48("962")) {
    {}
  } else {
    stryCov_9fa48("962");
    const lo = stryMutAct_9fa48("963") ? s.minimum && 0 : (stryCov_9fa48("963"), s.minimum ?? 0);
    const hi = stryMutAct_9fa48("964") ? s.maximum && lo + 100 : (stryCov_9fa48("964"), s.maximum ?? (stryMutAct_9fa48("965") ? lo - 100 : (stryCov_9fa48("965"), lo + 100)));
    if (stryMutAct_9fa48("967") ? false : stryMutAct_9fa48("966") ? true : (stryCov_9fa48("966", "967"), isInt)) {
      if (stryMutAct_9fa48("968")) {
        {}
      } else {
        stryCov_9fa48("968");
        const ilo = Math.ceil(lo);
        const ihi = Math.floor(hi);
        if (stryMutAct_9fa48("972") ? ihi >= ilo : stryMutAct_9fa48("971") ? ihi <= ilo : stryMutAct_9fa48("970") ? false : stryMutAct_9fa48("969") ? true : (stryCov_9fa48("969", "970", "971", "972"), ihi < ilo)) throw new SeedError(stryMutAct_9fa48("974") ? `` : (stryCov_9fa48("974"), `no integer in [${lo}, ${hi}]`), ctx.path);
        return int(ctx.rng, ilo, ihi);
      }
    }
    if (stryMutAct_9fa48("978") ? hi >= lo : stryMutAct_9fa48("977") ? hi <= lo : stryMutAct_9fa48("976") ? false : stryMutAct_9fa48("975") ? true : (stryCov_9fa48("975", "976", "977", "978"), hi < lo)) throw new SeedError(stryMutAct_9fa48("980") ? `` : (stryCov_9fa48("980"), `maximum ${hi} < minimum ${lo}`), ctx.path);
    if (stryMutAct_9fa48("983") ? hi !== lo : stryMutAct_9fa48("982") ? false : stryMutAct_9fa48("981") ? true : (stryCov_9fa48("981", "982", "983"), hi === lo)) return lo;
    return stryMutAct_9fa48("984") ? lo - ctx.rng() * (hi - lo) : (stryCov_9fa48("984"), lo + (stryMutAct_9fa48("985") ? ctx.rng() / (hi - lo) : (stryCov_9fa48("985"), ctx.rng() * (stryMutAct_9fa48("986") ? hi + lo : (stryCov_9fa48("986"), hi - lo)))));
  }
};
const genArray = (s: JsonSchemaObject, ctx: Ctx): unknown[] => {
  if (stryMutAct_9fa48("987")) {
    {}
  } else {
    stryCov_9fa48("987");
    const items = s.items;
    const min = stryMutAct_9fa48("988") ? s.minItems && 0 : (stryCov_9fa48("988"), s.minItems ?? 0);
    const max = stryMutAct_9fa48("989") ? s.maxItems && min + 3 : (stryCov_9fa48("989"), s.maxItems ?? (stryMutAct_9fa48("990") ? min - 3 : (stryCov_9fa48("990"), min + 3)));
    if (stryMutAct_9fa48("994") ? max >= min : stryMutAct_9fa48("993") ? max <= min : stryMutAct_9fa48("992") ? false : stryMutAct_9fa48("991") ? true : (stryCov_9fa48("991", "992", "993", "994"), max < min)) throw new SeedError(stryMutAct_9fa48("996") ? `` : (stryCov_9fa48("996"), `maxItems ${max} < minItems ${min}`), ctx.path);
    if (stryMutAct_9fa48("999") ? items !== false : stryMutAct_9fa48("998") ? false : stryMutAct_9fa48("997") ? true : (stryCov_9fa48("997", "998", "999"), items === (stryMutAct_9fa48("1000") ? true : (stryCov_9fa48("1000"), false)))) {
      if (stryMutAct_9fa48("1001")) {
        {}
      } else {
        stryCov_9fa48("1001");
        if (stryMutAct_9fa48("1005") ? min <= 0 : stryMutAct_9fa48("1004") ? min >= 0 : stryMutAct_9fa48("1003") ? false : stryMutAct_9fa48("1002") ? true : (stryCov_9fa48("1002", "1003", "1004", "1005"), min > 0)) throw new SeedError(stryMutAct_9fa48("1007") ? "" : (stryCov_9fa48("1007"), "items:false with minItems > 0 is unsatisfiable"), ctx.path);
        return stryMutAct_9fa48("1008") ? ["Stryker was here"] : (stryCov_9fa48("1008"), []);
      }
    }
    const child: Ctx = stryMutAct_9fa48("1009") ? {} : (stryCov_9fa48("1009"), {
      ...ctx,
      depth: stryMutAct_9fa48("1010") ? ctx.depth + 1 : (stryCov_9fa48("1010"), ctx.depth - 1),
      path: stryMutAct_9fa48("1011") ? `` : (stryCov_9fa48("1011"), `${ctx.path}/*`)
    });
    if (stryMutAct_9fa48("1015") ? child.depth >= 0 : stryMutAct_9fa48("1014") ? child.depth <= 0 : stryMutAct_9fa48("1013") ? false : stryMutAct_9fa48("1012") ? true : (stryCov_9fa48("1012", "1013", "1014", "1015"), child.depth < 0)) throw new SeedError(stryMutAct_9fa48("1017") ? "" : (stryCov_9fa48("1017"), "max depth exceeded"), ctx.path);
    const len = int(ctx.rng, min, max);
    const itemSchema = stryMutAct_9fa48("1018") ? items && true : (stryCov_9fa48("1018"), items ?? (stryMutAct_9fa48("1019") ? false : (stryCov_9fa48("1019"), true)));
    return Array.from(stryMutAct_9fa48("1020") ? {} : (stryCov_9fa48("1020"), {
      length: len
    }), stryMutAct_9fa48("1021") ? () => undefined : (stryCov_9fa48("1021"), () => generateValue(itemSchema, child)));
  }
};
const genObject = (s: JsonSchemaObject, ctx: Ctx): Record<string, unknown> => {
  if (stryMutAct_9fa48("1022")) {
    {}
  } else {
    stryCov_9fa48("1022");
    const props = stryMutAct_9fa48("1023") ? s.properties && {} : (stryCov_9fa48("1023"), s.properties ?? {});
    const required = stryMutAct_9fa48("1024") ? s.required && [] : (stryCov_9fa48("1024"), s.required ?? (stryMutAct_9fa48("1025") ? ["Stryker was here"] : (stryCov_9fa48("1025"), [])));
    const minP = stryMutAct_9fa48("1026") ? s.minProperties && 0 : (stryCov_9fa48("1026"), s.minProperties ?? 0);
    const maxP = s.maxProperties;
    const ap = s.additionalProperties;
    if (stryMutAct_9fa48("1029") ? maxP !== undefined || minP > maxP : stryMutAct_9fa48("1028") ? false : stryMutAct_9fa48("1027") ? true : (stryCov_9fa48("1027", "1028", "1029"), (stryMutAct_9fa48("1031") ? maxP === undefined : stryMutAct_9fa48("1030") ? true : (stryCov_9fa48("1030", "1031"), maxP !== undefined)) && (stryMutAct_9fa48("1034") ? minP <= maxP : stryMutAct_9fa48("1033") ? minP >= maxP : stryMutAct_9fa48("1032") ? true : (stryCov_9fa48("1032", "1033", "1034"), minP > maxP)))) {
      if (stryMutAct_9fa48("1035")) {
        {}
      } else {
        stryCov_9fa48("1035");
        throw new SeedError(stryMutAct_9fa48("1037") ? `` : (stryCov_9fa48("1037"), `minProperties ${minP} > maxProperties ${maxP}`), ctx.path);
      }
    }
    const apSchema = (stryMutAct_9fa48("1040") ? ap !== undefined || ap !== false : stryMutAct_9fa48("1039") ? false : stryMutAct_9fa48("1038") ? true : (stryCov_9fa48("1038", "1039", "1040"), (stryMutAct_9fa48("1042") ? ap === undefined : stryMutAct_9fa48("1041") ? true : (stryCov_9fa48("1041", "1042"), ap !== undefined)) && (stryMutAct_9fa48("1044") ? ap === false : stryMutAct_9fa48("1043") ? true : (stryCov_9fa48("1043", "1044"), ap !== (stryMutAct_9fa48("1045") ? true : (stryCov_9fa48("1045"), false)))))) ? ap : undefined;
    const apAllows = stryMutAct_9fa48("1048") ? ap === false : stryMutAct_9fa48("1047") ? false : stryMutAct_9fa48("1046") ? true : (stryCov_9fa48("1046", "1047", "1048"), ap !== (stryMutAct_9fa48("1049") ? true : (stryCov_9fa48("1049"), false))); // undefined | true | schema

    // Candidate keys, deduped, required first for stable trimming.
    const keys: string[] = stryMutAct_9fa48("1050") ? ["Stryker was here"] : (stryCov_9fa48("1050"), []);
    const seen = new Set<string>();
    const push = (k: string) => {
      if (stryMutAct_9fa48("1051")) {
        {}
      } else {
        stryCov_9fa48("1051");
        if (stryMutAct_9fa48("1054") ? false : stryMutAct_9fa48("1053") ? true : stryMutAct_9fa48("1052") ? seen.has(k) : (stryCov_9fa48("1052", "1053", "1054"), !seen.has(k))) {
          if (stryMutAct_9fa48("1055")) {
            {}
          } else {
            stryCov_9fa48("1055");
            if (stryMutAct_9fa48("1056")) {
              ;
            } else {
              stryCov_9fa48("1056");
              seen.add(k);
            }
            if (stryMutAct_9fa48("1057")) {
              ;
            } else {
              stryCov_9fa48("1057");
              keys.push(k);
            }
          }
        }
      }
    };
    for (const k of required) if (stryMutAct_9fa48("1058")) {
      ;
    } else {
      stryCov_9fa48("1058");
      push(k);
    }
    if (stryMutAct_9fa48("1061") ? false : stryMutAct_9fa48("1060") ? true : stryMutAct_9fa48("1059") ? ctx.requiredOnly : (stryCov_9fa48("1059", "1060", "1061"), !ctx.requiredOnly)) for (const k of Object.keys(props)) if (stryMutAct_9fa48("1062")) {
      ;
    } else {
      stryCov_9fa48("1062");
      push(k);
    }

    // minProperties: top up with remaining property names, then extras.
    for (const k of Object.keys(props)) {
      if (stryMutAct_9fa48("1063")) {
        {}
      } else {
        stryCov_9fa48("1063");
        if (stryMutAct_9fa48("1067") ? keys.length < minP : stryMutAct_9fa48("1066") ? keys.length > minP : stryMutAct_9fa48("1065") ? false : stryMutAct_9fa48("1064") ? true : (stryCov_9fa48("1064", "1065", "1066", "1067"), keys.length >= minP)) break;
        if (stryMutAct_9fa48("1068")) {
          ;
        } else {
          stryCov_9fa48("1068");
          push(k);
        }
      }
    }
    let extraN = 0;
    const extraKey = (): string => {
      if (stryMutAct_9fa48("1069")) {
        {}
      } else {
        stryCov_9fa48("1069");
        // "extra<i>" keys always exist eventually — `seen` is finite.
        let i = stryMutAct_9fa48("1070") ? extraN-- : (stryCov_9fa48("1070"), extraN++);
        while (stryMutAct_9fa48("1071") ? false : (stryCov_9fa48("1071"), seen.has(stryMutAct_9fa48("1072") ? `` : (stryCov_9fa48("1072"), `extra${i}`)))) i = stryMutAct_9fa48("1073") ? extraN-- : (stryCov_9fa48("1073"), extraN++);
        return stryMutAct_9fa48("1074") ? `` : (stryCov_9fa48("1074"), `extra${i}`);
      }
    };
    while (stryMutAct_9fa48("1077") ? keys.length >= minP : stryMutAct_9fa48("1076") ? keys.length <= minP : stryMutAct_9fa48("1075") ? false : (stryCov_9fa48("1075", "1076", "1077"), keys.length < minP)) {
      if (stryMutAct_9fa48("1078")) {
        {}
      } else {
        stryCov_9fa48("1078");
        if (stryMutAct_9fa48("1081") ? false : stryMutAct_9fa48("1080") ? true : stryMutAct_9fa48("1079") ? apAllows : (stryCov_9fa48("1079", "1080", "1081"), !apAllows)) {
          if (stryMutAct_9fa48("1082")) {
            {}
          } else {
            stryCov_9fa48("1082");
            throw new SeedError(stryMutAct_9fa48("1084") ? `` : (stryCov_9fa48("1084"), `cannot reach minProperties ${minP} with additionalProperties:false`), ctx.path);
          }
        }
        if (stryMutAct_9fa48("1085")) {
          ;
        } else {
          stryCov_9fa48("1085");
          push(extraKey());
        }
      }
    }
    // A few bonus extras when additionalProperties is an actual schema.
    if (stryMutAct_9fa48("1088") ? apSchema !== undefined || apSchema !== true : stryMutAct_9fa48("1087") ? false : stryMutAct_9fa48("1086") ? true : (stryCov_9fa48("1086", "1087", "1088"), (stryMutAct_9fa48("1090") ? apSchema === undefined : stryMutAct_9fa48("1089") ? true : (stryCov_9fa48("1089", "1090"), apSchema !== undefined)) && (stryMutAct_9fa48("1092") ? apSchema === true : stryMutAct_9fa48("1091") ? true : (stryCov_9fa48("1091", "1092"), apSchema !== (stryMutAct_9fa48("1093") ? false : (stryCov_9fa48("1093"), true)))))) {
      if (stryMutAct_9fa48("1094")) {
        {}
      } else {
        stryCov_9fa48("1094");
        const room = (stryMutAct_9fa48("1097") ? maxP !== undefined : stryMutAct_9fa48("1096") ? false : stryMutAct_9fa48("1095") ? true : (stryCov_9fa48("1095", "1096", "1097"), maxP === undefined)) ? MAX_EXTRA_KEYS : stryMutAct_9fa48("1098") ? Math.min(0, maxP - keys.length) : (stryCov_9fa48("1098"), Math.max(0, stryMutAct_9fa48("1099") ? maxP + keys.length : (stryCov_9fa48("1099"), maxP - keys.length)));
        for (let i = 0; stryMutAct_9fa48("1102") ? i >= Math.min(int(ctx.rng, 0, MAX_EXTRA_KEYS), room) : stryMutAct_9fa48("1101") ? i <= Math.min(int(ctx.rng, 0, MAX_EXTRA_KEYS), room) : stryMutAct_9fa48("1100") ? false : (stryCov_9fa48("1100", "1101", "1102"), i < (stryMutAct_9fa48("1103") ? Math.max(int(ctx.rng, 0, MAX_EXTRA_KEYS), room) : (stryCov_9fa48("1103"), Math.min(int(ctx.rng, 0, MAX_EXTRA_KEYS), room)))); stryMutAct_9fa48("1104") ? i-- : (stryCov_9fa48("1104"), i++)) {
          if (stryMutAct_9fa48("1105")) {
            {}
          } else {
            stryCov_9fa48("1105");
            if (stryMutAct_9fa48("1106")) {
              ;
            } else {
              stryCov_9fa48("1106");
              push(extraKey());
            }
          }
        }
      }
    }

    // maxProperties: trim non-required overflow.
    if (stryMutAct_9fa48("1109") ? maxP !== undefined || keys.length > maxP : stryMutAct_9fa48("1108") ? false : stryMutAct_9fa48("1107") ? true : (stryCov_9fa48("1107", "1108", "1109"), (stryMutAct_9fa48("1111") ? maxP === undefined : stryMutAct_9fa48("1110") ? true : (stryCov_9fa48("1110", "1111"), maxP !== undefined)) && (stryMutAct_9fa48("1114") ? keys.length <= maxP : stryMutAct_9fa48("1113") ? keys.length >= maxP : stryMutAct_9fa48("1112") ? true : (stryCov_9fa48("1112", "1113", "1114"), keys.length > maxP)))) {
      if (stryMutAct_9fa48("1115")) {
        {}
      } else {
        stryCov_9fa48("1115");
        const requiredSet = new Set(required);
        const kept = stryMutAct_9fa48("1116") ? keys : (stryCov_9fa48("1116"), keys.filter(stryMutAct_9fa48("1117") ? () => undefined : (stryCov_9fa48("1117"), k => requiredSet.has(k))));
        for (const k of keys) {
          if (stryMutAct_9fa48("1118")) {
            {}
          } else {
            stryCov_9fa48("1118");
            if (stryMutAct_9fa48("1122") ? kept.length < maxP : stryMutAct_9fa48("1121") ? kept.length > maxP : stryMutAct_9fa48("1120") ? false : stryMutAct_9fa48("1119") ? true : (stryCov_9fa48("1119", "1120", "1121", "1122"), kept.length >= maxP)) break;
            if (stryMutAct_9fa48("1125") ? false : stryMutAct_9fa48("1124") ? true : stryMutAct_9fa48("1123") ? requiredSet.has(k) : (stryCov_9fa48("1123", "1124", "1125"), !requiredSet.has(k))) if (stryMutAct_9fa48("1126")) {
              ;
            } else {
              stryCov_9fa48("1126");
              kept.push(k);
            }
          }
        }
        if (stryMutAct_9fa48("1130") ? kept.length <= maxP : stryMutAct_9fa48("1129") ? kept.length >= maxP : stryMutAct_9fa48("1128") ? false : stryMutAct_9fa48("1127") ? true : (stryCov_9fa48("1127", "1128", "1129", "1130"), kept.length > maxP)) {
          if (stryMutAct_9fa48("1131")) {
            {}
          } else {
            stryCov_9fa48("1131");
            throw new SeedError(stryMutAct_9fa48("1133") ? `` : (stryCov_9fa48("1133"), `required properties exceed maxProperties ${maxP}`), ctx.path);
          }
        }
        keys.length = 0;
        if (stryMutAct_9fa48("1134")) {
          ;
        } else {
          stryCov_9fa48("1134");
          keys.push(...kept);
        }
      }
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (stryMutAct_9fa48("1135")) {
        {}
      } else {
        stryCov_9fa48("1135");
        let vs: JsonSchema;
        if (stryMutAct_9fa48("1137") ? false : stryMutAct_9fa48("1136") ? true : (stryCov_9fa48("1136", "1137"), Object.hasOwn(props, key))) {
          if (stryMutAct_9fa48("1138")) {
            {}
          } else {
            stryCov_9fa48("1138");
            vs = props[key] as JsonSchema;
          }
        } else if (stryMutAct_9fa48("1141") ? ap !== false : stryMutAct_9fa48("1140") ? false : stryMutAct_9fa48("1139") ? true : (stryCov_9fa48("1139", "1140", "1141"), ap === (stryMutAct_9fa48("1142") ? true : (stryCov_9fa48("1142"), false)))) {
          if (stryMutAct_9fa48("1143")) {
            {}
          } else {
            stryCov_9fa48("1143");
            throw new SeedError(stryMutAct_9fa48("1145") ? `` : (stryCov_9fa48("1145"), `required key "${key}" has no schema and additionalProperties:false`), ctx.path);
          }
        } else {
          if (stryMutAct_9fa48("1146")) {
            {}
          } else {
            stryCov_9fa48("1146");
            vs = stryMutAct_9fa48("1147") ? apSchema && true : (stryCov_9fa48("1147"), apSchema ?? (stryMutAct_9fa48("1148") ? false : (stryCov_9fa48("1148"), true)));
          }
        }
        const child: Ctx = stryMutAct_9fa48("1149") ? {} : (stryCov_9fa48("1149"), {
          ...ctx,
          depth: stryMutAct_9fa48("1150") ? ctx.depth + 1 : (stryCov_9fa48("1150"), ctx.depth - 1),
          path: stryMutAct_9fa48("1151") ? `` : (stryCov_9fa48("1151"), `${ctx.path}/${ptrEscape(key)}`),
          key
        });
        if (stryMutAct_9fa48("1155") ? child.depth >= 0 : stryMutAct_9fa48("1154") ? child.depth <= 0 : stryMutAct_9fa48("1153") ? false : stryMutAct_9fa48("1152") ? true : (stryCov_9fa48("1152", "1153", "1154", "1155"), child.depth < 0)) throw new SeedError(stryMutAct_9fa48("1157") ? "" : (stryCov_9fa48("1157"), "max depth exceeded"), ctx.path);
        out[key] = generateValue(vs, child);
      }
    }
    return out;
  }
};
const randomScalar = stryMutAct_9fa48("1158") ? () => undefined : (stryCov_9fa48("1158"), (() => {
  const randomScalar = (ctx: Ctx): unknown => pick(ctx.rng, stryMutAct_9fa48("1159") ? [] : (stryCov_9fa48("1159"), [stryMutAct_9fa48("1160") ? () => undefined : (stryCov_9fa48("1160"), () => randomWords(ctx, stryMutAct_9fa48("1161") ? 1 - int(ctx.rng, 0, 2) : (stryCov_9fa48("1161"), 1 + int(ctx.rng, 0, 2)))), stryMutAct_9fa48("1162") ? () => undefined : (stryCov_9fa48("1162"), () => int(ctx.rng, 0, 1000)), stryMutAct_9fa48("1163") ? () => undefined : (stryCov_9fa48("1163"), () => chance(ctx.rng, 0.5)), stryMutAct_9fa48("1164") ? () => undefined : (stryCov_9fa48("1164"), () => null)]))();
  return randomScalar;
})());
const generateValue = (schema: JsonSchema, ctx: Ctx): unknown => {
  if (stryMutAct_9fa48("1165")) {
    {}
  } else {
    stryCov_9fa48("1165");
    if (stryMutAct_9fa48("1169") ? --ctx.nodes.left >= 0 : stryMutAct_9fa48("1168") ? --ctx.nodes.left <= 0 : stryMutAct_9fa48("1167") ? false : stryMutAct_9fa48("1166") ? true : (stryCov_9fa48("1166", "1167", "1168", "1169"), (stryMutAct_9fa48("1170") ? ++ctx.nodes.left : (stryCov_9fa48("1170"), --ctx.nodes.left)) < 0)) throw new SeedError(stryMutAct_9fa48("1172") ? "" : (stryCov_9fa48("1172"), "node budget exceeded"), ctx.path);
    let s = deref(schema, ctx);
    if (stryMutAct_9fa48("1175") ? s !== true : stryMutAct_9fa48("1174") ? false : stryMutAct_9fa48("1173") ? true : (stryCov_9fa48("1173", "1174", "1175"), s === (stryMutAct_9fa48("1176") ? false : (stryCov_9fa48("1176"), true)))) return randomScalar(ctx);
    if (stryMutAct_9fa48("1179") ? s !== false : stryMutAct_9fa48("1178") ? false : stryMutAct_9fa48("1177") ? true : (stryCov_9fa48("1177", "1178", "1179"), s === (stryMutAct_9fa48("1180") ? true : (stryCov_9fa48("1180"), false)))) throw new SeedError(stryMutAct_9fa48("1182") ? "" : (stryCov_9fa48("1182"), "schema accepts nothing (false)"), ctx.path);
    if (stryMutAct_9fa48("1184") ? false : stryMutAct_9fa48("1183") ? true : (stryCov_9fa48("1183", "1184"), Object.hasOwn(s, stryMutAct_9fa48("1185") ? "" : (stryCov_9fa48("1185"), "const")))) return clone(s.const);
    if (stryMutAct_9fa48("1188") ? s.enum || s.enum.length > 0 : stryMutAct_9fa48("1187") ? false : stryMutAct_9fa48("1186") ? true : (stryCov_9fa48("1186", "1187", "1188"), s.enum && (stryMutAct_9fa48("1191") ? s.enum.length <= 0 : stryMutAct_9fa48("1190") ? s.enum.length >= 0 : stryMutAct_9fa48("1189") ? true : (stryCov_9fa48("1189", "1190", "1191"), s.enum.length > 0)))) return clone(pick(ctx.rng, s.enum));
    if (stryMutAct_9fa48("1194") ? s.enum || s.enum.length === 0 : stryMutAct_9fa48("1193") ? false : stryMutAct_9fa48("1192") ? true : (stryCov_9fa48("1192", "1193", "1194"), s.enum && (stryMutAct_9fa48("1196") ? s.enum.length !== 0 : stryMutAct_9fa48("1195") ? true : (stryCov_9fa48("1195", "1196"), s.enum.length === 0)))) throw new SeedError(stryMutAct_9fa48("1198") ? "" : (stryCov_9fa48("1198"), "empty enum"), ctx.path);
    if (stryMutAct_9fa48("1201") ? s.not === undefined : stryMutAct_9fa48("1200") ? false : stryMutAct_9fa48("1199") ? true : (stryCov_9fa48("1199", "1200", "1201"), s.not !== undefined)) {
      if (stryMutAct_9fa48("1202")) {
        {}
      } else {
        stryCov_9fa48("1202");
        throw new SeedError(stryMutAct_9fa48("1204") ? "" : (stryCov_9fa48("1204"), "`not` schemas cannot be generated"), ctx.path);
      }
    }

    // Combinators: merge into an effective schema and recurse. The
    // merged schema may still carry other combinators — each pass
    // consumes one, so this terminates.
    if (stryMutAct_9fa48("1207") ? s.allOf || s.allOf.length > 0 : stryMutAct_9fa48("1206") ? false : stryMutAct_9fa48("1205") ? true : (stryCov_9fa48("1205", "1206", "1207"), s.allOf && (stryMutAct_9fa48("1210") ? s.allOf.length <= 0 : stryMutAct_9fa48("1209") ? s.allOf.length >= 0 : stryMutAct_9fa48("1208") ? true : (stryCov_9fa48("1208", "1209", "1210"), s.allOf.length > 0)))) {
      if (stryMutAct_9fa48("1211")) {
        {}
      } else {
        stryCov_9fa48("1211");
        const rest = omitKeys(s, stryMutAct_9fa48("1212") ? [] : (stryCov_9fa48("1212"), [stryMutAct_9fa48("1213") ? "" : (stryCov_9fa48("1213"), "allOf")]));
        const merged = (stryMutAct_9fa48("1214") ? [] : (stryCov_9fa48("1214"), [rest as JsonSchema, ...s.allOf])).reduce<JsonSchema>(stryMutAct_9fa48("1215") ? () => undefined : (stryCov_9fa48("1215"), (acc, part) => mergeTwo(acc, part, ctx)), stryMutAct_9fa48("1216") ? false : (stryCov_9fa48("1216"), true));
        return generateValue(merged, ctx);
      }
    }
    if (stryMutAct_9fa48("1219") ? s.anyOf || s.anyOf.length > 0 : stryMutAct_9fa48("1218") ? false : stryMutAct_9fa48("1217") ? true : (stryCov_9fa48("1217", "1218", "1219"), s.anyOf && (stryMutAct_9fa48("1222") ? s.anyOf.length <= 0 : stryMutAct_9fa48("1221") ? s.anyOf.length >= 0 : stryMutAct_9fa48("1220") ? true : (stryCov_9fa48("1220", "1221", "1222"), s.anyOf.length > 0)))) {
      if (stryMutAct_9fa48("1223")) {
        {}
      } else {
        stryCov_9fa48("1223");
        const rest = omitKeys(s, stryMutAct_9fa48("1224") ? [] : (stryCov_9fa48("1224"), [stryMutAct_9fa48("1225") ? "" : (stryCov_9fa48("1225"), "anyOf")]));
        const branch = pick(ctx.rng, s.anyOf);
        return generateValue(mergeTwo(rest, branch, ctx), ctx);
      }
    }
    if (stryMutAct_9fa48("1228") ? s.oneOf || s.oneOf.length > 0 : stryMutAct_9fa48("1227") ? false : stryMutAct_9fa48("1226") ? true : (stryCov_9fa48("1226", "1227", "1228"), s.oneOf && (stryMutAct_9fa48("1231") ? s.oneOf.length <= 0 : stryMutAct_9fa48("1230") ? s.oneOf.length >= 0 : stryMutAct_9fa48("1229") ? true : (stryCov_9fa48("1229", "1230", "1231"), s.oneOf.length > 0)))) {
      if (stryMutAct_9fa48("1232")) {
        {}
      } else {
        stryCov_9fa48("1232");
        const rest = omitKeys(s, stryMutAct_9fa48("1233") ? [] : (stryCov_9fa48("1233"), [stryMutAct_9fa48("1234") ? "" : (stryCov_9fa48("1234"), "oneOf")]));
        const branch = pick(ctx.rng, s.oneOf);
        return generateValue(mergeTwo(rest, branch, ctx), ctx);
      }
    }

    // Resolve effective type.
    const types = normTypes(s.type);
    const type = (stryMutAct_9fa48("1237") ? types || types.length > 0 : stryMutAct_9fa48("1236") ? false : stryMutAct_9fa48("1235") ? true : (stryCov_9fa48("1235", "1236", "1237"), types && (stryMutAct_9fa48("1240") ? types.length <= 0 : stryMutAct_9fa48("1239") ? types.length >= 0 : stryMutAct_9fa48("1238") ? true : (stryCov_9fa48("1238", "1239", "1240"), types.length > 0)))) ? pick(ctx.rng, types) : inferType(s);
    switch (type) {
      case stryMutAct_9fa48("1242") ? "" : (stryCov_9fa48("1242"), "null"):
        if (stryMutAct_9fa48("1241")) {} else {
          stryCov_9fa48("1241");
          return null;
        }
      case stryMutAct_9fa48("1244") ? "" : (stryCov_9fa48("1244"), "boolean"):
        if (stryMutAct_9fa48("1243")) {} else {
          stryCov_9fa48("1243");
          return chance(ctx.rng, 0.5);
        }
      case stryMutAct_9fa48("1246") ? "" : (stryCov_9fa48("1246"), "number"):
        if (stryMutAct_9fa48("1245")) {} else {
          stryCov_9fa48("1245");
          return genNumber(s, stryMutAct_9fa48("1247") ? true : (stryCov_9fa48("1247"), false), ctx);
        }
      case stryMutAct_9fa48("1249") ? "" : (stryCov_9fa48("1249"), "integer"):
        if (stryMutAct_9fa48("1248")) {} else {
          stryCov_9fa48("1248");
          return genNumber(s, stryMutAct_9fa48("1250") ? false : (stryCov_9fa48("1250"), true), ctx);
        }
      case stryMutAct_9fa48("1252") ? "" : (stryCov_9fa48("1252"), "array"):
        if (stryMutAct_9fa48("1251")) {} else {
          stryCov_9fa48("1251");
          return genArray(s, ctx);
        }
      case stryMutAct_9fa48("1254") ? "" : (stryCov_9fa48("1254"), "object"):
        if (stryMutAct_9fa48("1253")) {} else {
          stryCov_9fa48("1253");
          return genObject(s, ctx);
        }
      case stryMutAct_9fa48("1255") ? "" : (stryCov_9fa48("1255"), "string"):
      default:
        if (stryMutAct_9fa48("1256")) {} else {
          stryCov_9fa48("1256");
          return genString(s, ctx);
        }
    }
  }
};

/** Infer a type from constraint keywords when `type` is absent. */
const inferType = (s: JsonSchemaObject): string => {
  if (stryMutAct_9fa48("1257")) {
    {}
  } else {
    stryCov_9fa48("1257");
    if (stryMutAct_9fa48("1260") ? (s.properties || s.required || s.additionalProperties !== undefined || s.minProperties !== undefined) && s.maxProperties !== undefined : stryMutAct_9fa48("1259") ? false : stryMutAct_9fa48("1258") ? true : (stryCov_9fa48("1258", "1259", "1260"), (stryMutAct_9fa48("1262") ? (s.properties || s.required || s.additionalProperties !== undefined) && s.minProperties !== undefined : stryMutAct_9fa48("1261") ? false : (stryCov_9fa48("1261", "1262"), (stryMutAct_9fa48("1264") ? (s.properties || s.required) && s.additionalProperties !== undefined : stryMutAct_9fa48("1263") ? false : (stryCov_9fa48("1263", "1264"), (stryMutAct_9fa48("1266") ? s.properties && s.required : stryMutAct_9fa48("1265") ? false : (stryCov_9fa48("1265", "1266"), s.properties || s.required)) || (stryMutAct_9fa48("1268") ? s.additionalProperties === undefined : stryMutAct_9fa48("1267") ? false : (stryCov_9fa48("1267", "1268"), s.additionalProperties !== undefined)))) || (stryMutAct_9fa48("1270") ? s.minProperties === undefined : stryMutAct_9fa48("1269") ? false : (stryCov_9fa48("1269", "1270"), s.minProperties !== undefined)))) || (stryMutAct_9fa48("1272") ? s.maxProperties === undefined : stryMutAct_9fa48("1271") ? false : (stryCov_9fa48("1271", "1272"), s.maxProperties !== undefined)))) {
      if (stryMutAct_9fa48("1273")) {
        {}
      } else {
        stryCov_9fa48("1273");
        return stryMutAct_9fa48("1274") ? "" : (stryCov_9fa48("1274"), "object");
      }
    }
    if (stryMutAct_9fa48("1277") ? (s.items !== undefined || s.minItems !== undefined) && s.maxItems !== undefined : stryMutAct_9fa48("1276") ? false : stryMutAct_9fa48("1275") ? true : (stryCov_9fa48("1275", "1276", "1277"), (stryMutAct_9fa48("1279") ? s.items !== undefined && s.minItems !== undefined : stryMutAct_9fa48("1278") ? false : (stryCov_9fa48("1278", "1279"), (stryMutAct_9fa48("1281") ? s.items === undefined : stryMutAct_9fa48("1280") ? false : (stryCov_9fa48("1280", "1281"), s.items !== undefined)) || (stryMutAct_9fa48("1283") ? s.minItems === undefined : stryMutAct_9fa48("1282") ? false : (stryCov_9fa48("1282", "1283"), s.minItems !== undefined)))) || (stryMutAct_9fa48("1285") ? s.maxItems === undefined : stryMutAct_9fa48("1284") ? false : (stryCov_9fa48("1284", "1285"), s.maxItems !== undefined)))) return stryMutAct_9fa48("1286") ? "" : (stryCov_9fa48("1286"), "array");
    if (stryMutAct_9fa48("1289") ? (s.pattern !== undefined || s.minLength !== undefined) && s.maxLength !== undefined : stryMutAct_9fa48("1288") ? false : stryMutAct_9fa48("1287") ? true : (stryCov_9fa48("1287", "1288", "1289"), (stryMutAct_9fa48("1291") ? s.pattern !== undefined && s.minLength !== undefined : stryMutAct_9fa48("1290") ? false : (stryCov_9fa48("1290", "1291"), (stryMutAct_9fa48("1293") ? s.pattern === undefined : stryMutAct_9fa48("1292") ? false : (stryCov_9fa48("1292", "1293"), s.pattern !== undefined)) || (stryMutAct_9fa48("1295") ? s.minLength === undefined : stryMutAct_9fa48("1294") ? false : (stryCov_9fa48("1294", "1295"), s.minLength !== undefined)))) || (stryMutAct_9fa48("1297") ? s.maxLength === undefined : stryMutAct_9fa48("1296") ? false : (stryCov_9fa48("1296", "1297"), s.maxLength !== undefined)))) return stryMutAct_9fa48("1298") ? "" : (stryCov_9fa48("1298"), "string");
    if (stryMutAct_9fa48("1301") ? s.minimum !== undefined && s.maximum !== undefined : stryMutAct_9fa48("1300") ? false : stryMutAct_9fa48("1299") ? true : (stryCov_9fa48("1299", "1300", "1301"), (stryMutAct_9fa48("1303") ? s.minimum === undefined : stryMutAct_9fa48("1302") ? false : (stryCov_9fa48("1302", "1303"), s.minimum !== undefined)) || (stryMutAct_9fa48("1305") ? s.maximum === undefined : stryMutAct_9fa48("1304") ? false : (stryCov_9fa48("1304", "1305"), s.maximum !== undefined)))) return stryMutAct_9fa48("1306") ? "" : (stryCov_9fa48("1306"), "number");
    return stryMutAct_9fa48("1307") ? "" : (stryCov_9fa48("1307"), "string");
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate one JSON value satisfying `schema`. Deterministic for a
 * given seed/rng; throws {@link SeedError} on ungeneratable features.
 */
export const generate = (schema: JsonSchema, opts: GenerateOptions = {}): unknown => {
  if (stryMutAct_9fa48("1308")) {
    {}
  } else {
    stryCov_9fa48("1308");
    const rng = stryMutAct_9fa48("1309") ? opts.rng && makeRng(opts.seed ?? Math.floor(Math.random() * 0x1_0000_0000)) : (stryCov_9fa48("1309"), opts.rng ?? makeRng(stryMutAct_9fa48("1310") ? opts.seed && Math.floor(Math.random() * 0x1_0000_0000) : (stryCov_9fa48("1310"), opts.seed ?? Math.floor(stryMutAct_9fa48("1311") ? Math.random() / 0x1_0000_0000 : (stryCov_9fa48("1311"), Math.random() * 0x1_0000_0000)))));
    const ctx: Ctx = stryMutAct_9fa48("1312") ? {} : (stryCov_9fa48("1312"), {
      rng,
      pools: poolsFor(opts.locale),
      root: schema,
      requiredOnly: stryMutAct_9fa48("1313") ? opts.requiredOnly && false : (stryCov_9fa48("1313"), opts.requiredOnly ?? (stryMutAct_9fa48("1314") ? true : (stryCov_9fa48("1314"), false))),
      path: stryMutAct_9fa48("1315") ? "" : (stryCov_9fa48("1315"), "$"),
      depth: stryMutAct_9fa48("1316") ? opts.depth && DEFAULT_MAX_DEPTH : (stryCov_9fa48("1316"), opts.depth ?? DEFAULT_MAX_DEPTH),
      nodes: stryMutAct_9fa48("1317") ? {} : (stryCov_9fa48("1317"), {
        left: stryMutAct_9fa48("1318") ? opts.maxNodes && DEFAULT_MAX_NODES : (stryCov_9fa48("1318"), opts.maxNodes ?? DEFAULT_MAX_NODES)
      })
    });
    const value = generateValue(schema, ctx);
    if (stryMutAct_9fa48("1320") ? false : stryMutAct_9fa48("1319") ? true : (stryCov_9fa48("1319", "1320"), opts.assertValid)) {
      if (stryMutAct_9fa48("1321")) {
        {}
      } else {
        stryCov_9fa48("1321");
        const issues = validate(schema, value);
        if (stryMutAct_9fa48("1325") ? issues.length <= 0 : stryMutAct_9fa48("1324") ? issues.length >= 0 : stryMutAct_9fa48("1323") ? false : stryMutAct_9fa48("1322") ? true : (stryCov_9fa48("1322", "1323", "1324", "1325"), issues.length > 0)) {
          if (stryMutAct_9fa48("1326")) {
            {}
          } else {
            stryCov_9fa48("1326");
            throw new SeedError(stryMutAct_9fa48("1328") ? `` : (stryCov_9fa48("1328"), `generated value failed validation: ${issues[0].message}`), stryMutAct_9fa48("1329") ? "" : (stryCov_9fa48("1329"), "$"));
          }
        }
      }
    }
    return value;
  }
};

/** Hard cap on `generateMany` count — each value runs the full
 * generator (pattern retries included), so an unbounded count is an
 * unbounded hang/DoS surface even for benign schemas. */
export const MAX_GENERATE_MANY = 10_000;

/** Generate `count` independent values (rng advances between calls).
 * `count` is capped at {@link MAX_GENERATE_MANY} — SeedError beyond. */
export const generateMany = (schema: JsonSchema, count: number, opts: GenerateOptions = {}): unknown[] => {
  if (stryMutAct_9fa48("1330")) {
    {}
  } else {
    stryCov_9fa48("1330");
    if (stryMutAct_9fa48("1333") ? !Number.isInteger(count) && count < 0 : stryMutAct_9fa48("1332") ? false : stryMutAct_9fa48("1331") ? true : (stryCov_9fa48("1331", "1332", "1333"), (stryMutAct_9fa48("1334") ? Number.isInteger(count) : (stryCov_9fa48("1334"), !Number.isInteger(count))) || (stryMutAct_9fa48("1337") ? count >= 0 : stryMutAct_9fa48("1336") ? count <= 0 : stryMutAct_9fa48("1335") ? false : (stryCov_9fa48("1335", "1336", "1337"), count < 0)))) {
      if (stryMutAct_9fa48("1338")) {
        {}
      } else {
        stryCov_9fa48("1338");
        throw new SeedError(stryMutAct_9fa48("1340") ? `` : (stryCov_9fa48("1340"), `count must be a non-negative integer, got ${count}`));
      }
    }
    if (stryMutAct_9fa48("1344") ? count <= MAX_GENERATE_MANY : stryMutAct_9fa48("1343") ? count >= MAX_GENERATE_MANY : stryMutAct_9fa48("1342") ? false : stryMutAct_9fa48("1341") ? true : (stryCov_9fa48("1341", "1342", "1343", "1344"), count > MAX_GENERATE_MANY)) {
      if (stryMutAct_9fa48("1345")) {
        {}
      } else {
        stryCov_9fa48("1345");
        throw new SeedError(stryMutAct_9fa48("1347") ? `` : (stryCov_9fa48("1347"), `count ${count} exceeds MAX_GENERATE_MANY (${MAX_GENERATE_MANY})`));
      }
    }
    const rng = stryMutAct_9fa48("1348") ? opts.rng && makeRng(opts.seed ?? Math.floor(Math.random() * 0x1_0000_0000)) : (stryCov_9fa48("1348"), opts.rng ?? makeRng(stryMutAct_9fa48("1349") ? opts.seed && Math.floor(Math.random() * 0x1_0000_0000) : (stryCov_9fa48("1349"), opts.seed ?? Math.floor(stryMutAct_9fa48("1350") ? Math.random() / 0x1_0000_0000 : (stryCov_9fa48("1350"), Math.random() * 0x1_0000_0000)))));
    return Array.from(stryMutAct_9fa48("1351") ? {} : (stryCov_9fa48("1351"), {
      length: count
    }), stryMutAct_9fa48("1352") ? () => undefined : (stryCov_9fa48("1352"), () => generate(schema, stryMutAct_9fa48("1353") ? {} : (stryCov_9fa48("1353"), {
      ...opts,
      rng
    }))));
  }
};

/**
 * Generate an object record — `schema` must effectively produce an
 * object (type object, or inferable from `properties`/`required`).
 */
export const generateRecord = (schema: JsonSchema, opts: GenerateOptions = {}): Record<string, unknown> => {
  if (stryMutAct_9fa48("1354")) {
    {}
  } else {
    stryCov_9fa48("1354");
    const value = generate(schema, opts);
    if (stryMutAct_9fa48("1357") ? (typeof value !== "object" || value === null) && Array.isArray(value) : stryMutAct_9fa48("1356") ? false : stryMutAct_9fa48("1355") ? true : (stryCov_9fa48("1355", "1356", "1357"), (stryMutAct_9fa48("1359") ? typeof value !== "object" && value === null : stryMutAct_9fa48("1358") ? false : (stryCov_9fa48("1358", "1359"), (stryMutAct_9fa48("1361") ? typeof value === "object" : stryMutAct_9fa48("1360") ? false : (stryCov_9fa48("1360", "1361"), typeof value !== (stryMutAct_9fa48("1362") ? "" : (stryCov_9fa48("1362"), "object")))) || (stryMutAct_9fa48("1364") ? value !== null : stryMutAct_9fa48("1363") ? false : (stryCov_9fa48("1363", "1364"), value === null)))) || Array.isArray(value))) {
      if (stryMutAct_9fa48("1365")) {
        {}
      } else {
        stryCov_9fa48("1365");
        throw new SeedError(stryMutAct_9fa48("1367") ? "" : (stryCov_9fa48("1367"), "generateRecord requires an object-producing schema"));
      }
    }
    return value as Record<string, unknown>;
  }
};