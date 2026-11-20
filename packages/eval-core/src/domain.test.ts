import { describe, expect, it } from "vitest";

import {
	defineDomain,
	domainChain,
	DomainResolutionError,
	mergeDomainDefinitions,
	mergeDomainParams,
	mergeJson,
	resolveDomainDefinition,
	validateDomain,
	validateDomainOverrides,
	type DomainDefinition,
} from "./domain.ts";

const base: DomainDefinition = defineDomain({
	id: "eval.base",
	version: "1",
	provides: {
		stages: ["s1", { id: "s2", config: { a: 1 } }],
		metrics: ["m1"],
		gates: [{ id: "g1", config: { x: 1 } }],
		gatePresets: ["p1"],
		conditions: ["c1"],
		capabilities: { tts: "plug.a" },
	},
	locale: { profile: "ptbr-v1", tag: "pt-BR" },
	templates: { dir: "templates", name: "consultation" },
	personas: { regions: ["r1"], ageBands: ["a"], registers: ["f"], specialties: ["s"] },
	phi: { categories: ["cpf"] },
	params: { dataset: { count: 8, step: 7 }, voices: ["v1"], cohort: "base" },
});

describe("validateDomain / defineDomain", () => {
	it("accepts a full definition and rejects bad shapes", () => {
		expect(validateDomain(base)).not.toBeNull();
		expect(validateDomain(base)?.locale?.profile).toBe("ptbr-v1");
		expect(validateDomain(base)?.templates?.dir).toBe("templates");
		expect(validateDomain(base)?.phi?.categories).toEqual(["cpf"]);
		expect(validateDomain(base)?.provides?.stages).toHaveLength(2);
		expect(validateDomain(null)).toBeNull();
		expect(validateDomain({ id: "x" })).toBeNull();
		expect(validateDomain({ ...base, bogus: 1 })).toBeNull();
		expect(validateDomain({ ...base, personas: { regions: "nope" } })).toBeNull();
		expect(() => defineDomain({ nope: true })).toThrow();
	});

	it("rejects wrongly-typed section contents — sections are not free-form", () => {
		// Each section schema must actually validate: a Struct({})
		// mutant would accept these.
		expect(validateDomain({ ...base, locale: {} })).toBeNull();
		expect(validateDomain({ ...base, locale: { profile: 1 } })).toBeNull();
		expect(validateDomain({ ...base, templates: { dir: 1 } })).toBeNull();
		expect(validateDomain({ ...base, phi: { categories: "cpf" } })).toBeNull();
		expect(validateDomain({ ...base, provides: { stages: "s1" } })).toBeNull();
		expect(validateDomain({ ...base, provides: { capabilities: { tts: 1 } } })).toBeNull();
		// `extends` is a legal top-level key.
		expect(validateDomain({ ...base, extends: "eval.parent" })).not.toBeNull();
		expect(validateDomain(undefined)).toBeNull();
	});
});

describe("validateDomainOverrides", () => {
	it("accepts the overridable subset only", () => {
		expect(validateDomainOverrides({ params: { a: 1 }, locale: { profile: "p" } })).not.toBeNull();
		expect(validateDomainOverrides({ provides: {} })).toBeNull();
		expect(validateDomainOverrides({ extends: "x" })).toBeNull();
		expect(validateDomainOverrides({ id: "x" })).toBeNull();
		expect(validateDomainOverrides("nope")).toBeNull();
		expect(validateDomainOverrides({ personas: { regions: 1 } })).toBeNull();
		// Every overridable section key is accepted — a key dropped
		// from OVERRIDE_KEYS would reject it as unknown.
		expect(
			validateDomainOverrides({
				templates: { dir: "t" },
				personas: { regions: [], ageBands: [], registers: [], specialties: [] },
				phi: { categories: [] },
			}),
		).not.toBeNull();
		expect(validateDomainOverrides(null)).toBeNull();
		expect(validateDomainOverrides(undefined)).toBeNull();
	});
});

describe("mergeJson / mergeDomainParams", () => {
	it("deep-merges records, replaces arrays/scalars", () => {
		expect(mergeJson(undefined, undefined)).toBeUndefined();
		expect(mergeJson({ a: 1 }, undefined)).toEqual({ a: 1 });
		expect(mergeJson(undefined, { a: 1 })).toEqual({ a: 1 });
		expect(
			mergeJson(
				{ nested: { x: 1, y: 2 }, list: [1, 2], keep: "a" },
				{ nested: { y: 3, z: 4 }, list: [9], keep: "b" },
			),
		).toEqual({ nested: { x: 1, y: 3, z: 4 }, list: [9], keep: "b" });
		expect(mergeJson({ a: [1] }, { a: null })).toEqual({ a: null });
		// Null-prototype records still count as plain objects.
		const nilProto = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
		expect(mergeJson(nilProto as never, { b: 2 })).toEqual({ a: 1, b: 2 });
		// Non-plain objects are replaced wholesale, never key-merged:
		// arrays, null, and class instances all lose to `over`.
		expect(mergeJson({ a: 1 }, [1, 2])).toEqual([1, 2]);
		expect(mergeJson({ a: 1 }, null)).toBeNull();
		const date = new Date(0);
		expect(mergeJson({ a: 1 }, date as never)).toBe(date);
		expect(mergeJson(date as never, { b: 2 })).toEqual({ b: 2 });
	});

	it("mergeDomainParams treats undefined as absent", () => {
		expect(mergeDomainParams(undefined, undefined)).toBeUndefined();
		expect(mergeDomainParams(undefined, { a: 1 })).toEqual({ a: 1 });
		expect(mergeDomainParams({ a: 1 }, undefined)).toEqual({ a: 1 });
		expect(mergeDomainParams({ d: { x: 1 } }, { d: { y: 2 } })).toEqual({
			d: { x: 1, y: 2 },
		});
		// A base-less merge still returns a fresh record, not the
		// caller's object.
		const over = { a: { b: 1 } };
		const merged = mergeDomainParams(undefined, over);
		expect(merged).toEqual(over);
		expect(merged).not.toBe(over);
		// Same for an over-less merge — `{...base}` is a copy.
		const baseOnly = { a: { b: 1 } };
		const mergedBase = mergeDomainParams(baseOnly, undefined);
		expect(mergedBase).toEqual(baseOnly);
		expect(mergedBase).not.toBe(baseOnly);
	});
});

describe("mergeDomainDefinitions", () => {
	const child = defineDomain({
		id: "eval.child",
		version: "2",
		extends: "eval.base",
		provides: {
			stages: ["s3", { id: "s2", config: { a: 9 } }],
			metrics: ["m2"],
		},
		personas: { regions: ["r2"], ageBands: ["b"], registers: ["c"], specialties: ["t"] },
		params: { dataset: { count: 4 }, extra: true },
	});

	it("unions provides by id with child config winning", () => {
		const m = mergeDomainDefinitions(base, child);
		expect(m.id).toBe("eval.child");
		expect(m.version).toBe("2");
		// The child's `extends` declaration wins over the parent's.
		expect(m.extends).toBe("eval.base");
		// stages: s1 kept, s2 child's config wins, s3 appended.
		expect(m.provides?.stages).toEqual(["s1", { id: "s2", config: { a: 9 } }, "s3"]);
		// metrics union preserves order.
		expect(m.provides?.metrics).toEqual(["m1", "m2"]);
		// untouched kinds inherit wholesale.
		expect(m.provides?.gates).toEqual([{ id: "g1", config: { x: 1 } }]);
		expect(m.provides?.gatePresets).toEqual(["p1"]);
		expect(m.provides?.conditions).toEqual(["c1"]);
		expect(m.provides?.capabilities).toEqual({ tts: "plug.a" });
	});

	it("replaces declared sections wholesale, inherits the rest", () => {
		const m = mergeDomainDefinitions(base, child);
		expect(m.personas?.regions).toEqual(["r2"]);
		// locale/templates/phi not redeclared → inherited.
		expect(m.locale).toEqual({ profile: "ptbr-v1", tag: "pt-BR" });
		expect(m.templates).toEqual({ dir: "templates", name: "consultation" });
		expect(m.phi).toEqual({ categories: ["cpf"] });
	});

	it("deep-merges params with child winning leaf conflicts", () => {
		const m = mergeDomainDefinitions(base, child);
		expect(m.params).toEqual({
			dataset: { count: 4, step: 7 },
			voices: ["v1"],
			cohort: "base",
			extra: true,
		});
	});

	it("gate entries union by id/preset key", () => {
		const p = defineDomain({
			id: "p",
			version: "1",
			provides: { gates: [{ id: "g1", config: { old: true } }, { preset: "px" }] },
		});
		const c = defineDomain({
			id: "c",
			version: "1",
			provides: { gates: [{ id: "g1", config: { new: true } }, { id: "g2" }] },
		});
		const m = mergeDomainDefinitions(p, c);
		expect(m.provides?.gates).toEqual([
			{ id: "g1", config: { new: true } },
			{ preset: "px" },
			{ id: "g2" },
		]);
	});

	it("handles one-sided provides sections and absent capabilities", () => {
		// provides only on the child → inherited wholesale.
		const onlyChild = mergeDomainDefinitions(
			defineDomain({ id: "p", version: "1" }),
			defineDomain({
				id: "c",
				version: "1",
				provides: {
					gates: [{ preset: "px" }],
					capabilities: { llm: "plug.b" },
				},
			}),
		);
		expect(onlyChild.provides?.gates).toEqual([{ preset: "px" }]);
		expect(onlyChild.provides?.capabilities).toEqual({ llm: "plug.b" });

		// provides only on the parent → inherited wholesale; kinds the
		// child redeclares union, undeclared kinds pass through.
		const onlyParent = mergeDomainDefinitions(base, defineDomain({ id: "c", version: "1" }));
		expect(onlyParent.provides?.stages).toEqual(base.provides?.stages);
		expect(onlyParent.provides?.capabilities).toEqual({ tts: "plug.a" });

		// Both declare provides but neither names capabilities → the
		// merged provides omits the key entirely.
		const noCaps = mergeDomainDefinitions(
			defineDomain({ id: "p", version: "1", provides: { metrics: ["m"] } }),
			defineDomain({ id: "c", version: "1", provides: { conditions: ["k"] } }),
		);
		expect(noCaps.provides).toEqual({ metrics: ["m"], conditions: ["k"] });
		expect(noCaps.provides && "capabilities" in noCaps.provides).toBe(false);
		// Only the declared kinds appear — no undefined-valued keys.
		expect(Object.keys(noCaps.provides!).sort()).toEqual(["conditions", "metrics"]);

		// Complementary case: stages+gates only — metrics, conditions,
		// gatePresets and capabilities must stay absent.
		const sparse = mergeDomainDefinitions(
			defineDomain({ id: "p", version: "1", provides: { stages: ["s1"] } }),
			defineDomain({ id: "c", version: "1", provides: { gates: [{ id: "g" }] } }),
		);
		expect(Object.keys(sparse.provides!).sort()).toEqual(["gates", "stages"]);

		// Gates declared only on the child union into parent provides
		// that lacks the kind entirely.
		const childGates = mergeDomainDefinitions(
			defineDomain({ id: "p", version: "1", provides: { metrics: ["m"] } }),
			defineDomain({ id: "c", version: "1", provides: { gates: [{ id: "g" }] } }),
		);
		expect(childGates.provides?.gates).toEqual([{ id: "g" }]);
	});

	it("merges capabilities when only the child declares them", () => {
		// Both sides have `provides`, parent lacks capabilities — the
		// child's map must survive the merge.
		const m = mergeDomainDefinitions(
			defineDomain({ id: "p", version: "1", provides: { metrics: ["m"] } }),
			defineDomain({
				id: "c",
				version: "1",
				provides: { capabilities: { llm: "plug.b" } },
			}),
		);
		expect(m.provides?.capabilities).toEqual({ llm: "plug.b" });
	});

	it("keeps id-gates and presets distinct when merging", () => {
		const m = mergeDomainDefinitions(
			defineDomain({
				id: "p",
				version: "1",
				provides: {
					gates: [{ id: "g1" }, { id: "g2" }],
				},
			}),
			defineDomain({
				id: "c",
				version: "1",
				provides: {
					gates: [{ preset: "p1" }, { preset: "p2" }],
				},
			}),
		);
		expect(m.provides?.gates).toEqual([
			{ id: "g1" },
			{ id: "g2" },
			{ preset: "p1" },
			{ preset: "p2" },
		]);
		// Same keys on the child override in place; distinct keys append.
		const m2 = mergeDomainDefinitions(
			defineDomain({
				id: "p",
				version: "1",
				provides: {
					gates: [{ id: "g1", config: { old: true } }, { preset: "p1" }, { preset: "p2" }],
				},
			}),
			defineDomain({
				id: "c",
				version: "1",
				provides: { gates: [{ id: "g1", config: { new: true } }, { preset: "p1" }] },
			}),
		);
		expect(m2.provides?.gates).toEqual([
			{ id: "g1", config: { new: true } },
			{ preset: "p1" },
			{ preset: "p2" },
		]);
	});

	it("child sections replace parent sections; absent sections inherit nothing", () => {
		// Neither side declares templates/personas/phi → merged omits them.
		const bare = mergeDomainDefinitions(
			defineDomain({ id: "p", version: "1", params: { a: 1 } }),
			defineDomain({ id: "c", version: "1", params: { b: 2 } }),
		);
		expect(bare.templates).toBeUndefined();
		expect(bare.personas).toBeUndefined();
		expect(bare.phi).toBeUndefined();
		expect(bare.locale).toBeUndefined();
		expect(bare.params).toEqual({ a: 1, b: 2 });
		// Absent sections stay absent — no undefined-valued keys leak in.
		expect(bare.provides).toBeUndefined();
		expect(Object.keys(bare).sort()).toEqual(["id", "params", "version"]);

		// Fully minimal inputs merge to exactly {id, version}.
		const minimal = mergeDomainDefinitions(
			defineDomain({ id: "p", version: "1" }),
			defineDomain({ id: "c", version: "2" }),
		);
		expect(Object.keys(minimal).sort()).toEqual(["id", "version"]);
	});
});

describe("domainChain / resolveDomainDefinition", () => {
	const defs = [
		base,
		defineDomain({
			id: "eval.mid",
			version: "1",
			extends: "eval.base",
			params: { mid: true },
		}),
		defineDomain({
			id: "eval.leaf",
			version: "1",
			extends: "eval.mid",
			params: { leaf: true },
		}),
	];

	it("returns leaf→root order", () => {
		const chain = domainChain(defs, "eval.leaf");
		expect(chain.map((d) => d.id)).toEqual(["eval.leaf", "eval.mid", "eval.base"]);
	});

	it("merges root→leaf", () => {
		const m = resolveDomainDefinition(defs, "eval.leaf");
		expect(m.id).toBe("eval.leaf");
		expect(m.params).toEqual({
			dataset: { count: 8, step: 7 },
			voices: ["v1"],
			cohort: "base",
			mid: true,
			leaf: true,
		});
		expect(m.provides?.metrics).toEqual(["m1"]);
	});

	it("throws on unknown id, unknown parent, and cycles", () => {
		const capture = (fn: () => unknown): DomainResolutionError => {
			try {
				fn();
			} catch (e) {
				expect(e).toBeInstanceOf(DomainResolutionError);
				return e as DomainResolutionError;
			}
			throw new Error("expected DomainResolutionError");
		};
		// Empty registry → the "(none)" known-list fallback.
		expect(capture(() => domainChain([], "ghost")).message).toBe(
			'unknown domain "ghost" — known: (none)',
		);
		// Non-empty registry lists known ids in declaration order.
		expect(capture(() => domainChain(defs, "ghost")).message).toBe(
			'unknown domain "ghost" — known: eval.base, eval.mid, eval.leaf',
		);
		expect(capture(() => domainChain(defs, "ghost"))._tag).toBe("DomainResolutionError");
		expect(() => domainChain([{ id: "a", version: "1", extends: "ghost" }], "a")).toThrowError(
			/extends unknown domain "ghost"/,
		);
		const cyc = [
			{ id: "a", version: "1", extends: "b" },
			{ id: "b", version: "1", extends: "a" },
		];
		expect(() => domainChain(cyc, "a")).toThrowError(/cycle/);
	});
});
