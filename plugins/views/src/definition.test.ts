import { describe, expect, it } from "vitest";
import { definePlugin } from "@ktb/kernel";

import {
	assertViewDef,
	collectViewDefinitions,
	defineView,
	makeViewDefinitions,
	parseViewPath,
	toViewDefinition,
	VIEW_DEF_KIND,
	VIEW_PATH_PATTERN,
	viewDefContribution,
	ViewDefinitions,
	viewKey,
	viewPathFor,
	type ViewDef,
} from "./definition.ts";

const VALID: ViewDef = {
	id: "patients",
	title: "Patients",
	collection: "clinic.patients",
	kind: "table",
	fields: [{ field: "name" }, { field: "born", format: "date", label: "Born", width: "8rem" }],
};

describe("assertViewDef", () => {
	it("accepts a minimal valid def and returns it", () => {
		expect(assertViewDef(VALID, "test")).toEqual(VALID);
	});

	it("accepts a fully-loaded def", () => {
		const def: ViewDef = {
			...VALID,
			path: "/v/clinic-patients",
			context: "portal",
			permission: "patient.read",
			filters: [
				{ field: "active", op: "$eq", value: true },
				{ field: "name", op: "$regex", param: "q", label: "Search" },
			],
			sort: [{ field: "name", dir: "desc" }],
			pageSize: 50,
			detailFields: [{ field: "name", format: "ref", refCollection: "x.y", refLabelField: "a.b" }],
			cardTitleField: "name",
			owner: "plugin.x",
		};
		expect(assertViewDef(def, "test")).toEqual(def);
	});

	it("rejects non-object payloads", () => {
		for (const bad of [null, "x", 42, [VALID]]) {
			expect(() => assertViewDef(bad, "ctx")).toThrow("ctx: view definition must be an object");
		}
	});

	it("rejects bad ids", () => {
		expect(() => assertViewDef({ ...VALID, id: "Bad Id" }, "c")).toThrow(/view id must match/);
		expect(() => assertViewDef({ ...VALID, id: 7 }, "c")).toThrow(/view id must match/);
	});

	it("rejects empty/non-string titles", () => {
		expect(() => assertViewDef({ ...VALID, title: "" }, "c")).toThrow(/title must be/);
		expect(() => assertViewDef({ ...VALID, title: 3 }, "c")).toThrow(/title must be/);
	});

	it("rejects invalid collection names", () => {
		expect(() => assertViewDef({ ...VALID, collection: "BAD NAME" }, "c")).toThrow(
			/collection is not a valid/,
		);
		expect(() => assertViewDef({ ...VALID, collection: 9 }, "c")).toThrow(
			/collection is not a valid/,
		);
	});

	it("rejects paths outside the /v/ subtree", () => {
		expect(() => assertViewDef({ ...VALID, path: "/admin/x" }, "c")).toThrow(/path must match/);
		expect(() => assertViewDef({ ...VALID, path: "/v/a/b" }, "c")).toThrow(/path must match/);
		expect(() => assertViewDef({ ...VALID, path: 4 }, "c")).toThrow(/path must match/);
	});

	it("rejects unknown contexts", () => {
		expect(() => assertViewDef({ ...VALID, context: "cli" as never }, "c")).toThrow(
			/context must be/,
		);
	});

	it("rejects malformed permissions", () => {
		expect(() => assertViewDef({ ...VALID, permission: "nospace" }, "c")).toThrow(
			/resource\.action/,
		);
		expect(() => assertViewDef({ ...VALID, permission: 1 as never }, "c")).toThrow(
			/resource\.action/,
		);
	});

	it("rejects unknown kinds", () => {
		expect(() => assertViewDef({ ...VALID, kind: "grid" as never }, "c")).toThrow(/kind must be/);
	});

	it("rejects malformed fields lists", () => {
		expect(() => assertViewDef({ ...VALID, fields: [] }, "c")).toThrow(/non-empty array/);
		expect(() => assertViewDef({ ...VALID, fields: "x" as never }, "c")).toThrow(/non-empty array/);
		expect(() => assertViewDef({ ...VALID, fields: ["name"] as never }, "c")).toThrow(
			/must be an object/,
		);
	});

	it("rejects bad field paths and forbidden segments", () => {
		for (const field of ["", "a..b", ".a", "a.", "__proto__.x", "a.constructor"]) {
			expect(() => assertViewDef({ ...VALID, fields: [{ field }] }, "c")).toThrow(
				/dotted field path/,
			);
		}
	});

	it("rejects bad field attributes", () => {
		expect(() =>
			assertViewDef({ ...VALID, fields: [{ field: "a", label: 1 as never }] }, "c"),
		).toThrow(/label must be a string/);
		expect(() =>
			assertViewDef({ ...VALID, fields: [{ field: "a", format: "rich" as never }] }, "c"),
		).toThrow(/format .* is not supported/);
		expect(() =>
			assertViewDef({ ...VALID, fields: [{ field: "a", width: 3 as never }] }, "c"),
		).toThrow(/width must be a string/);
		expect(() =>
			assertViewDef(
				{ ...VALID, fields: [{ field: "a", format: "ref", refCollection: "BAD!" }] },
				"c",
			),
		).toThrow(/refCollection is not a valid/);
		expect(() => assertViewDef({ ...VALID, fields: [{ field: "a", format: "ref" }] }, "c")).toThrow(
			/without refCollection/,
		);
		expect(() =>
			assertViewDef(
				{
					...VALID,
					fields: [{ field: "a", refCollection: "x.y", refLabelField: ".." }],
				},
				"c",
			),
		).toThrow(/refLabelField must be/);
	});

	it("rejects malformed filters", () => {
		expect(() => assertViewDef({ ...VALID, filters: {} as never }, "c")).toThrow(
			/filters must be an array/,
		);
		expect(() => assertViewDef({ ...VALID, filters: ["x"] as never }, "c")).toThrow(
			/must be an object/,
		);
		expect(() =>
			assertViewDef({ ...VALID, filters: [{ field: "a", op: "$eq", value: 1 }] }, "c"),
		).not.toThrow();
		expect(() => assertViewDef({ ...VALID, filters: [{ field: "..", op: "$eq" }] }, "c")).toThrow(
			/\.field must be/,
		);
		expect(() =>
			assertViewDef({ ...VALID, filters: [{ field: "a", op: "$nope" as never }] }, "c"),
		).toThrow(/is not a document-store operator/);
		expect(() =>
			assertViewDef({ ...VALID, filters: [{ field: "a", op: "$eq", param: "bad param!" }] }, "c"),
		).toThrow(/\.param must match/);
		expect(() =>
			assertViewDef({ ...VALID, filters: [{ field: "a", op: "$eq", label: 2 as never }] }, "c"),
		).toThrow(/\.label must be a string/);
	});

	it("rejects fixed filters whose operand violates the operator contract", () => {
		for (const filter of [
			{ field: "a", op: "$in", value: "x" }, // needs an array
			{ field: "a", op: "$nin", value: 5 },
			{ field: "a", op: "$exists", value: "yes" }, // needs a boolean
			{ field: "a", op: "$regex", value: 5 }, // needs a string
			{ field: "a", op: "$regex", value: "(a+)+" }, // unsafe pattern
		]) {
			expect(() => assertViewDef({ ...VALID, filters: [filter] }, "c")).toThrow(/operand/);
		}
		// Valid fixed operands — including interactive filters, which
		// carry no operand at def time — still pass.
		expect(() =>
			assertViewDef(
				{
					...VALID,
					filters: [
						{ field: "a", op: "$in", value: [1, 2] },
						{ field: "b", op: "$exists", value: true },
						{ field: "c", op: "$regex", value: "^x" },
						{ field: "d", op: "$in", param: "p" },
					],
				},
				"c",
			),
		).not.toThrow();
	});

	it("rejects malformed sort terms", () => {
		expect(() => assertViewDef({ ...VALID, sort: "name" as never }, "c")).toThrow(
			/sort must be an array/,
		);
		expect(() => assertViewDef({ ...VALID, sort: ["name"] as never }, "c")).toThrow(
			/must be an object/,
		);
		expect(() =>
			assertViewDef({ ...VALID, sort: [{ field: "a", dir: "up" as never }] }, "c"),
		).toThrow(/dir must be/);
		expect(() => assertViewDef({ ...VALID, sort: [{ field: "..", dir: "asc" }] }, "c")).toThrow(
			/\.field must be/,
		);
	});

	it("rejects bad pageSize values", () => {
		expect(() => assertViewDef({ ...VALID, pageSize: 1.5 }, "c")).toThrow(/pageSize must be/);
		expect(() => assertViewDef({ ...VALID, pageSize: 0 }, "c")).toThrow(/pageSize must be/);
		expect(() => assertViewDef({ ...VALID, pageSize: 501 }, "c")).toThrow(/pageSize must be/);
		expect(() => assertViewDef({ ...VALID, pageSize: "x" as never }, "c")).toThrow(
			/pageSize must be/,
		);
	});

	it("rejects bad detailFields and cardTitleField", () => {
		expect(() => assertViewDef({ ...VALID, detailFields: [] }, "c")).toThrow(/non-empty array/);
		expect(() => assertViewDef({ ...VALID, cardTitleField: ".." }, "c")).toThrow(
			/cardTitleField must be/,
		);
	});

	it("rejects non-string owner", () => {
		expect(() => assertViewDef({ ...VALID, owner: 4 as never }, "c")).toThrow(
			/owner must be a string/,
		);
	});
});

describe("defineView", () => {
	it("returns the asserted def", () => {
		expect(defineView(VALID)).toEqual(VALID);
	});
	it("throws on invalid defs", () => {
		expect(() => defineView({ ...VALID, id: "X" })).toThrow(/view id must match/);
	});
});

describe("viewDefContribution / toViewDefinition", () => {
	it("builds a manifest entry carrying the def as meta", () => {
		const entry = viewDefContribution(VALID);
		expect(entry.kind).toBe(VIEW_DEF_KIND.id);
		expect(entry.id).toBe("patients");
		expect(entry.meta).toEqual(VALID);
	});

	it("round-trips through toViewDefinition and stamps owner", () => {
		const entry = viewDefContribution(VALID);
		const def = toViewDefinition(entry, "clinic.plugin");
		expect(def.owner).toBe("clinic.plugin");
		expect(def.id).toBe("patients");
		const owned = toViewDefinition(viewDefContribution({ ...VALID, owner: "explicit" }), "p");
		expect(owned.owner).toBe("explicit");
	});

	it("throws on malformed contribution meta", () => {
		expect(() =>
			toViewDefinition({ kind: VIEW_DEF_KIND.id, id: "x", version: "1", meta: 42 as never }, "p"),
		).toThrow(/view definition must be an object/);
	});
});

describe("viewKey / viewPathFor", () => {
	it("defaults the key to the id and honors custom paths", () => {
		expect(viewKey(VALID)).toBe("patients");
		expect(viewPathFor(VALID)).toBe("/v/patients");
		const custom = { ...VALID, path: "/v/clinic-list" };
		expect(viewKey(custom)).toBe("clinic-list");
		expect(viewPathFor(custom)).toBe("/v/clinic-list");
	});
});

describe("collectViewDefinitions / makeViewDefinitions", () => {
	const contributor = (id: string, def: ViewDef) =>
		definePlugin({ id, contributions: [viewDefContribution(def)] });

	it("collects defs in plugin order and stamps owners", () => {
		const a = contributor("a.plugin", VALID);
		const b = contributor("b.plugin", { ...VALID, id: "other", title: "Other" });
		expect(collectViewDefinitions([a, b])).toHaveLength(2);
		expect(collectViewDefinitions([])).toEqual([]);
		const defs = collectViewDefinitions([a]);
		expect(defs[0]?.owner).toBe("a.plugin");
	});

	it("throws on duplicate URL keys", () => {
		const a = contributor("a.plugin", VALID);
		const b = contributor("b.plugin", { ...VALID, id: "patients-2", path: "/v/patients" });
		expect(() => collectViewDefinitions([a, b])).toThrow(/duplicate view key/);
	});

	it("makeViewDefinitions wraps the collection for the service", () => {
		const registry = makeViewDefinitions([contributor("p", VALID)]);
		expect(registry.views).toHaveLength(1);
		expect(ViewDefinitions.key).toBe("@ktb/views/ViewDefinitions");
	});
});

describe("parseViewPath", () => {
	it("parses list and detail paths", () => {
		expect(parseViewPath("/v/patients")).toEqual({ key: "patients", docId: null });
		expect(parseViewPath("/v/patients/42")).toEqual({ key: "patients", docId: 42 });
		expect(parseViewPath("  /v/patients/42/  ")).toEqual({ key: "patients", docId: 42 });
		expect(parseViewPath("/v/patients?x=1#f")).toEqual({ key: "patients", docId: null });
	});

	it("rejects paths outside the subtree or malformed", () => {
		for (const bad of [
			"/",
			"/admin",
			"/v",
			"/v/",
			"/v/a/b/c",
			"/v//x",
			"/v/a/xy",
			"/v/a/0",
			"/v/a/-3",
			"/v/a/99999999999999999999",
		]) {
			expect(parseViewPath(bad)).toBeNull();
		}
	});
});

describe("VIEW_PATH_PATTERN", () => {
	it("matches single-segment /v/ paths only", () => {
		expect(VIEW_PATH_PATTERN.test("/v/a-b")).toBe(true);
		expect(VIEW_PATH_PATTERN.test("/v/a/b")).toBe(false);
	});
});
