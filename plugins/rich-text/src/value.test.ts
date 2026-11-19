import { describe, expect, it } from "vitest";

import { isRichTextEmpty, parseRichTextValue, richTextPlainText } from "./value.ts";

describe("parseRichTextValue", () => {
	it("returns non-empty arrays and rejects everything else", () => {
		const doc = [{ type: "p", children: [{ text: "hi" }] }];
		expect(parseRichTextValue(JSON.stringify(doc))).toEqual(doc);
		expect(parseRichTextValue("{}")).toBeNull();
		expect(parseRichTextValue("[]")).toBeNull();
		expect(parseRichTextValue('"str"')).toBeNull();
		expect(parseRichTextValue("42")).toBeNull();
		expect(parseRichTextValue("not json")).toBeNull();
		expect(parseRichTextValue("")).toBeNull();
	});
});

describe("isRichTextEmpty", () => {
	it("treats non-arrays and text-less docs as empty", () => {
		expect(isRichTextEmpty(null)).toBe(true);
		expect(isRichTextEmpty(undefined)).toBe(true);
		expect(isRichTextEmpty("x")).toBe(true);
		expect(isRichTextEmpty([])).toBe(true);
		expect(isRichTextEmpty([{ type: "p", children: [{ text: "" }] }])).toBe(true);
		expect(isRichTextEmpty([{ type: "p", children: [] }])).toBe(true);
		expect(isRichTextEmpty([{ type: "p" }])).toBe(true);
	});

	it("ignores non-object nodes in the tree", () => {
		expect(isRichTextEmpty(["str", null, 42])).toBe(true);
		expect(isRichTextEmpty(["str", { type: "p", children: [null, "x", { text: "hi" }] }])).toBe(
			false,
		);
	});

	it("detects text anywhere in the tree", () => {
		expect(isRichTextEmpty([{ type: "p", children: [{ text: "hi" }] }])).toBe(false);
		expect(
			isRichTextEmpty([
				{ type: "h2", children: [{ text: "" }] },
				{ type: "p", children: [{ text: "deep", bold: true }] },
			]),
		).toBe(false);
		// Whitespace counts as content (length > 0).
		expect(isRichTextEmpty([{ type: "p", children: [{ text: " " }] }])).toBe(false);
		// Nested element children are searched too.
		expect(
			isRichTextEmpty([
				{
					type: "p",
					children: [{ type: "a", url: "https://x.com", children: [{ text: "link" }] }],
				},
			]),
		).toBe(false);
	});
});

describe("richTextPlainText", () => {
	it("concatenates text leaves and truncates", () => {
		const doc = [
			{ type: "h2", children: [{ text: "Title " }] },
			{ type: "p", children: [{ text: "body" }] },
		];
		expect(richTextPlainText(doc)).toBe("Title body");
		expect(richTextPlainText(doc, 5)).toBe("Title");
	});

	it("returns empty string for non-arrays", () => {
		expect(richTextPlainText(null)).toBe("");
		expect(richTextPlainText("x")).toBe("");
		expect(richTextPlainText([{ type: "p" }])).toBe("");
	});
});
