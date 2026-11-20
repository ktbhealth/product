import { describe, expect, it } from "vitest";
import { assertSchema } from "@ktb/json-schema";

import { BUILDER_BLOCK_KINDS } from "./kinds.tsx";

const EXPECTED_KINDS = [
	"section",
	"container",
	"columns",
	"divider",
	"spacer",
	"heading",
	"cta",
	"metric",
	"table",
] as const;

describe("BUILDER_BLOCK_KINDS", () => {
	it("ships the nine core block kinds", () => {
		expect(BUILDER_BLOCK_KINDS.map((kind) => kind.kind)).toEqual(EXPECTED_KINDS);
	});

	it("has unique kind ids", () => {
		const ids = BUILDER_BLOCK_KINDS.map((kind) => kind.kind);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("gives every kind a label, description, category, icon, renderer, editor and fields", () => {
		for (const kind of BUILDER_BLOCK_KINDS) {
			expect(kind.label.length).toBeGreaterThan(0);
			expect(kind.description?.length).toBeGreaterThan(0);
			expect(kind.category).toBeTruthy();
			expect(kind.icon).toBeDefined();
			expect(kind.renderer).toBeDefined();
			expect(kind.editor).toBeDefined();
			expect(kind.fields?.type).toBe("object");
		}
	});

	it("declares schema-valid fields for every kind", () => {
		for (const kind of BUILDER_BLOCK_KINDS) {
			expect(() => assertSchema(kind.fields)).not.toThrow();
		}
	});

	it("excludes rich-text and image (owned by other plugins)", () => {
		const ids = BUILDER_BLOCK_KINDS.map((kind) => kind.kind);
		expect(ids).not.toContain("rich-text");
		expect(ids).not.toContain("image");
	});
});
