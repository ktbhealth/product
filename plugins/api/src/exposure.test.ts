import { describe, expect, it } from "vitest";

import { definePlugin } from "@ktb/kernel";

import {
	API_BASE_PATH,
	API_DEFAULT_METHODS,
	API_EXPOSE_KIND,
	ApiExposures,
	apiExposureContribution,
	assertApiExposure,
	collectApiExposures,
	defineApiExposure,
	exposureKey,
	exposureMethods,
	exposurePath,
	makeApiExposures,
	toApiExposure,
	type ApiExposure,
} from "./exposure.ts";

const base: ApiExposure = { collection: "notes" };

describe("assertApiExposure", () => {
	it("accepts a minimal def and applies defaults", () => {
		const def = assertApiExposure({ collection: "notes" }, "ctx");
		expect(def).toEqual({ collection: "notes" });
		expect(exposureKey(def)).toBe("notes");
		expect(exposureMethods(def)).toEqual(API_DEFAULT_METHODS);
		expect(exposureMethods(def)).toEqual(["list", "get"]);
		expect(exposurePath("notes")).toBe("/api/documents/notes");
	});

	it("accepts a full def", () => {
		const def = assertApiExposure(
			{
				collection: "notes",
				basePath: "/api/documents/note-feed",
				permission: "note.all",
				methods: ["list", "get", "create", "update", "delete"],
				public: true,
				owner: "p1",
			},
			"ctx",
		);
		expect(def.basePath).toBe("/api/documents/note-feed");
		expect(exposureKey(def)).toBe("note-feed");
		expect(def.methods).toHaveLength(5);
	});

	it("dedupes methods preserving first-seen order", () => {
		const def = assertApiExposure({ collection: "n", methods: ["get", "list", "get"] }, "ctx");
		expect(def.methods).toEqual(["get", "list"]);
	});

	it("rejects non-objects", () => {
		for (const value of [null, [], "x", 5]) {
			expect(() => assertApiExposure(value, "ctx")).toThrow("api exposure must be an object");
		}
	});

	it("rejects invalid collection names", () => {
		for (const collection of ["", "Notes", "1abc", "a/b", "a b", 5, undefined]) {
			expect(() => assertApiExposure({ collection }, "ctx")).toThrow(
				"collection is not a valid collection name",
			);
		}
	});

	it("rejects basePaths outside the mounted subtree", () => {
		for (const basePath of [
			"/api/other/x",
			"/api/documents",
			"/api/documents/",
			"/api/documents/a/b",
			"/api/documents/Bad",
			"/api/documents/-bad",
			"relative/path",
			5,
		]) {
			expect(() => assertApiExposure({ collection: "n", basePath }, "ctx")).toThrow(/basePath/);
		}
	});

	it("rejects malformed permissions", () => {
		for (const permission of ["nodot", "a.b.c.d!", "", 5]) {
			// "a.b.c.d!" fails the charset; "" and non-strings fail too.
			expect(() =>
				assertApiExposure({ collection: "n", permission: permission as never }, "ctx"),
			).toThrow(/permission/);
		}
	});

	it("accepts multi-segment permissions", () => {
		expect(
			assertApiExposure({ collection: "n", permission: "resource.action.extra" }, "ctx").permission,
		).toBe("resource.action.extra");
	});

	it("rejects empty or unknown methods", () => {
		expect(() => assertApiExposure({ collection: "n", methods: [] }, "ctx")).toThrow(
			"methods must be a non-empty array",
		);
		expect(() =>
			assertApiExposure({ collection: "n", methods: ["list", "exec"] as never }, "ctx"),
		).toThrow('method "exec" is not one of');
		expect(() => assertApiExposure({ collection: "n", methods: "list" as never }, "ctx")).toThrow(
			"methods must be a non-empty array",
		);
	});

	it("rejects non-boolean public and non-string owner", () => {
		expect(() => assertApiExposure({ collection: "n", public: "yes" as never }, "ctx")).toThrow(
			"public must be a boolean",
		);
		expect(() => assertApiExposure({ collection: "n", owner: 5 as never }, "ctx")).toThrow(
			"owner must be a string",
		);
	});
});

describe("defineApiExposure / apiExposureContribution", () => {
	it("validates and echoes the def", () => {
		expect(defineApiExposure(base)).toEqual(base);
		expect(() => defineApiExposure({ collection: "Bad Name" })).toThrow();
	});

	it("builds a contribution keyed by the URL key", () => {
		const entry = apiExposureContribution({
			collection: "notes",
			basePath: "/api/documents/feed",
		});
		expect(entry.kind).toBe(API_EXPOSE_KIND.id);
		expect(entry.id).toBe("feed");
		expect(entry.version).toBe("1");
		expect(entry.meta).toMatchObject({ collection: "notes", basePath: "/api/documents/feed" });
	});
});

describe("toApiExposure / collectApiExposures", () => {
	it("stamps the contributing plugin id as owner", () => {
		const entry = apiExposureContribution(base);
		const def = toApiExposure(entry, "owner.plugin");
		expect(def.owner).toBe("owner.plugin");
	});

	it("keeps an explicit owner", () => {
		const entry = apiExposureContribution({ ...base, owner: "explicit" });
		expect(toApiExposure(entry, "other").owner).toBe("explicit");
	});

	it("throws on malformed contribution meta", () => {
		expect(() =>
			toApiExposure({ kind: API_EXPOSE_KIND.id, id: "x", meta: { collection: 5 } }, "p"),
		).toThrow();
	});

	it("collects exposures in plugin order and rejects duplicate keys", () => {
		const p1 = definePlugin({
			id: "p.one",
			contributions: [apiExposureContribution({ collection: "a" })],
		});
		const p2 = definePlugin({
			id: "p.two",
			contributions: [
				apiExposureContribution({ collection: "b", basePath: "/api/documents/a-alias" }),
			],
		});
		const collected = collectApiExposures([p1, p2]);
		expect(collected.map(exposureKey)).toEqual(["a", "a-alias"]);
		expect(collected[0]?.owner).toBe("p.one");

		const dupe = definePlugin({
			id: "p.three",
			contributions: [apiExposureContribution({ collection: "a" })],
		});
		expect(() => collectApiExposures([p1, dupe])).toThrow('duplicate api exposure key "a"');
	});

	it("ignores contributions of other kinds", () => {
		const p = definePlugin({
			id: "p.other",
			contributions: [{ kind: "theme.tokens", id: "x", meta: {} }],
		});
		expect(collectApiExposures([p])).toEqual([]);
	});

	it("makeApiExposures builds the registry shape", () => {
		const p = definePlugin({
			id: "p.x",
			contributions: [apiExposureContribution(base)],
		});
		const built = makeApiExposures([p]);
		expect(built.exposures).toEqual(collectApiExposures([p]));
		// The owner→enablement index is always populated for the service.
		expect(built.ownerIndex?.pkgById.has("p.x")).toBe(true);
	});
});

describe("ApiExposures service tag", () => {
	it("has a stable service key", () => {
		expect(ApiExposures.key).toBe("@ktb/api/ApiExposures");
	});
});

describe("API_BASE_PATH", () => {
	it("is the mounted subtree", () => {
		expect(API_BASE_PATH).toBe("/api/documents");
	});
});
