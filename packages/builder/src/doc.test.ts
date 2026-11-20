import { describe, expect, it } from "vitest";

import {
	builderDocFromData,
	BUILDER_DOC_VERSION,
	emptyBuilderData,
	migrateBuilderDoc,
	normalizeBuilderData,
	parseBuilderDoc,
	serializeBuilderDoc,
} from "./doc.ts";

describe("parseBuilderDoc", () => {
	it("returns null for absent and blank input", () => {
		expect(parseBuilderDoc(null)).toBeNull();
		expect(parseBuilderDoc(undefined)).toBeNull();
		expect(parseBuilderDoc("")).toBeNull();
		expect(parseBuilderDoc("   ")).toBeNull();
	});

	it("returns null for malformed JSON and non-object payloads", () => {
		expect(parseBuilderDoc("not json")).toBeNull();
		expect(parseBuilderDoc("[1,2]")).toBeNull();
		expect(parseBuilderDoc('"str"')).toBeNull();
		expect(parseBuilderDoc("null")).toBeNull();
	});

	it("returns null for missing/invalid version or data", () => {
		expect(parseBuilderDoc("{}")).toBeNull();
		expect(parseBuilderDoc('{"version":"1","data":{}}')).toBeNull();
		expect(parseBuilderDoc('{"version":0,"data":{}}')).toBeNull();
		expect(parseBuilderDoc('{"version":1.5,"data":{}}')).toBeNull();
		expect(parseBuilderDoc('{"version":1}')).toBeNull();
	});

	it("parses a well-formed document", () => {
		const doc = parseBuilderDoc('{"version":1,"data":{"content":[]}}');
		expect(doc).toEqual({ version: 1, data: { content: [] } });
	});
});

describe("serializeBuilderDoc", () => {
	it("round-trips through parseBuilderDoc", () => {
		const doc = builderDocFromData({ content: [{ type: "heading" }] });
		expect(parseBuilderDoc(serializeBuilderDoc(doc))).toEqual(doc);
	});
});

describe("emptyBuilderData", () => {
	it("produces the Puck empty shape", () => {
		expect(emptyBuilderData()).toEqual({
			root: { props: {} },
			content: [],
			zones: {},
		});
	});
});

describe("migrateBuilderDoc", () => {
	it("passes current-version docs through untouched", () => {
		const doc = { version: BUILDER_DOC_VERSION, data: { a: 1 } };
		expect(migrateBuilderDoc(doc)).toBe(doc);
	});

	it("passes future-version docs through (forward compat)", () => {
		const doc = { version: 99, data: { a: 1 } };
		expect(migrateBuilderDoc(doc)).toBe(doc);
	});

	it("applies migration steps in order", () => {
		const migrations = [
			(data: unknown) => ({ ...(data as object), step: 1 }),
			(data: unknown) => ({ ...(data as object), step: 2 }),
		];
		const doc = { version: 1, data: { base: true } };
		const migrated = migrateBuilderDoc(doc, migrations, 3);
		expect(migrated.version).toBe(3);
		expect(migrated.data).toMatchObject({ base: true });
		expect((migrated.data as { step?: number }).step).toBe(2);
	});

	it("stops when the step chain runs out", () => {
		const doc = { version: 1, data: {} };
		const migrated = migrateBuilderDoc(doc, [], 3);
		expect(migrated.version).toBe(1);
	});
});

describe("normalizeBuilderData", () => {
	it("defaults missing containers and preserves component props", () => {
		expect(
			normalizeBuilderData({
				content: [{ type: "heading", props: { id: "h1", text: "Hi" } }],
			}),
		).toEqual({
			root: {},
			content: [{ type: "heading", props: { id: "h1", text: "Hi" } }],
			zones: {},
		});
	});

	it("preserves a valid zones map", () => {
		const zones = { "c:z": [{ type: "heading", props: { id: "z1" } }] };
		expect(normalizeBuilderData({ zones })).toEqual({
			root: {},
			content: [],
			zones,
		});
	});

	it("returns null for malformed containers and component entries", () => {
		expect(normalizeBuilderData(null)).toBeNull();
		expect(normalizeBuilderData({ root: null })).toBeNull();
		expect(normalizeBuilderData({ root: { props: null } })).toBeNull();
		expect(normalizeBuilderData({ content: {} })).toBeNull();
		expect(normalizeBuilderData({ content: [{ type: "heading" }] })).toBeNull();
		expect(normalizeBuilderData({ content: [{ type: "heading", props: null }] })).toBeNull();
		expect(normalizeBuilderData({ zones: { "c:z": {} } })).toBeNull();
		expect(normalizeBuilderData({ zones: { "c:z": [{ type: "heading" }] } })).toBeNull();
		expect(normalizeBuilderData({ zones: [] })).toBeNull();
	});
});
