import { describe, expect, it } from "vitest";

import type { Plugin } from "@ktb/kernel";

import {
	assertCollectionDef,
	collectDocumentCollections,
	defineCollection,
	documentCollectionContribution,
	DOCUMENT_COLLECTION_KIND,
	makeDocumentCollections,
	toDocumentCollection,
} from "./collection.ts";
import { f } from "./fields.ts";

const sample = defineCollection({
	name: "test.things",
	fields: { title: f.string({ required: true }) },
});

describe("defineCollection", () => {
	it("defaults version to 1 and keeps the def JSON-shaped", () => {
		expect(sample.version).toBe(1);
		expect(sample.name).toBe("test.things");
		expect(JSON.parse(JSON.stringify(sample))).toEqual(sample);
	});

	it("keeps explicit version/indexes/owner", () => {
		const def = defineCollection({
			name: "c",
			version: 3,
			fields: {},
			indexes: ["a.b"],
			owner: "x.services",
		});
		expect(def).toMatchObject({ version: 3, indexes: ["a.b"], owner: "x.services" });
		expect(def.indexes).toBeDefined();
	});
});

describe("documentCollectionContribution / toDocumentCollection", () => {
	it("round-trips a def through a PluginContribution", () => {
		const entry = documentCollectionContribution(sample);
		expect(entry.kind).toBe(DOCUMENT_COLLECTION_KIND.id);
		expect(entry.id).toBe("test.things");
		expect(entry.version).toBe("1");
		expect(entry.meta).toEqual(sample);
		const back = toDocumentCollection(entry, "owner.plugin");
		// Owner falls back to the contributing plugin id.
		expect(back).toEqual({ ...sample, owner: "owner.plugin" });
	});

	it("stamps the contributing plugin id as owner when absent", () => {
		const back = toDocumentCollection(documentCollectionContribution(sample), "p.services");
		expect(back.owner).toBe("p.services");
	});

	it("keeps an explicit owner", () => {
		const owned = defineCollection({
			name: "c",
			fields: {},
			owner: "explicit",
		});
		expect(toDocumentCollection(documentCollectionContribution(owned), "p").owner).toBe("explicit");
	});
});

describe("assertCollectionDef", () => {
	it("accepts a well-formed def", () => {
		expect(assertCollectionDef(sample, "test")).toEqual(sample);
	});

	it("rejects malformed defs", () => {
		for (const bad of [
			null,
			"x",
			[],
			{ name: "Bad Name", version: 1, fields: {} },
			{ name: "ok.name", version: "1", fields: {} },
			{ name: "ok.name", version: 1.5, fields: {} },
			{ name: "ok.name", version: 1, fields: [] },
			{ name: "ok.name", version: 1, fields: { x: 5 } },
			{ name: "ok.name", version: 1, fields: { x: {} } },
		]) {
			expect(() => assertCollectionDef(bad, "test")).toThrow();
		}
	});

	it("rejects unsafe or non-identifier field names", () => {
		for (const field of ["__proto__", "constructor", "prototype", "a.b", "a-b", "0x", ""]) {
			const def = { name: "ok.name", version: 1, fields: { [field]: { kind: "string" } } };
			expect(() => assertCollectionDef(def, "test")).toThrow();
		}
		// Identifier-shaped names pass.
		const good = {
			name: "ok.name",
			version: 1,
			fields: { _a: { kind: "string" }, B2: { kind: "number" } },
		};
		expect(() => assertCollectionDef(good, "test")).not.toThrow();
	});

	it("rejects defaults that fail the field's own validation", () => {
		const bad = {
			name: "ok.name",
			version: 1,
			fields: { n: { kind: "number", default: "abc" } },
		};
		expect(() => assertCollectionDef(bad, "test")).toThrow(/n/);
		const good = {
			name: "ok.name",
			version: 1,
			fields: { n: { kind: "number", default: 3 }, r: { kind: "ref", default: null } },
		};
		expect(() => assertCollectionDef(good, "test")).not.toThrow();
	});
});

describe("collectDocumentCollections", () => {
	const pluginWith = (id: string, defs: ReturnType<typeof documentCollectionContribution>[]) =>
		({
			id,
			contributions: defs,
		}) as unknown as Plugin;

	it("collects document.collection entries in plugin order and stamps owner", () => {
		const a = defineCollection({ name: "a", fields: {} });
		const b = defineCollection({ name: "b", fields: {}, owner: "custom" });
		const plugins = [
			pluginWith("p.one", [documentCollectionContribution(a)]),
			pluginWith("p.two", [documentCollectionContribution(b)]),
			pluginWith("p.other", []),
		] as const;
		const collected = collectDocumentCollections(plugins);
		expect(collected.map((d) => d.name)).toEqual(["a", "b"]);
		expect(collected[0]!.owner).toBe("p.one");
		expect(collected[1]!.owner).toBe("custom");
	});

	it("makeDocumentCollections wraps the collected defs", () => {
		const plugins = [pluginWith("p", [documentCollectionContribution(sample)])];
		const svc = makeDocumentCollections(plugins);
		expect(svc.collections).toHaveLength(1);
		expect(svc.collections[0]!.name).toBe("test.things");
	});

	it("throws on duplicate collection names across contributors", () => {
		const dup = defineCollection({ name: "same.name", fields: {} });
		const plugins = [
			pluginWith("p.one", [documentCollectionContribution(dup)]),
			pluginWith("p.two", [documentCollectionContribution({ ...dup, version: 2 })]),
		] as const;
		expect(() => collectDocumentCollections(plugins)).toThrow(/duplicate document collection/);
		// Same name twice within ONE plugin's contributions also throws.
		const single = [
			pluginWith("p.one", [
				documentCollectionContribution(dup),
				documentCollectionContribution(dup),
			]),
		] as const;
		expect(() => collectDocumentCollections(single)).toThrow(/duplicate/);
	});

	it("ignores contributions of other kinds", () => {
		const plugins = [
			{
				id: "p",
				contributions: [{ kind: "theme.tokens", id: "x", meta: {} }],
			} as unknown as Plugin,
		];
		expect(collectDocumentCollections(plugins)).toEqual([]);
	});
});
