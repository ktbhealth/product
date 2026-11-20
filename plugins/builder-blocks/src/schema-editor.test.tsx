// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonSchemaObject } from "@ktb/json-schema";

import { defaultPropsFor, schemaEditor } from "./schema-editor.tsx";

afterEach(cleanup);

/** One schema exercising every widget branch: text, number, checkbox,
 * enum-select, const-select, mixed-type select, JSON (array+object),
 * boolean-schema text fallback, union-type text fallback. */
const ALL_WIDGETS: JsonSchemaObject = {
	type: "object",
	properties: {
		title: { type: "string", title: "Title" },
		level: { type: "integer" },
		dark: { type: "boolean" },
		size: { type: "string", enum: ["sm", "lg"], default: "sm" },
		mode: { type: "string", const: "auto" },
		pick: { enum: [1, "two"] },
		rows: { type: "array", items: { type: "string" } },
		meta: { type: "object" },
		note: true,
		free: { type: ["string", "number"] },
	},
	required: ["title"],
};

const renderEditor = (fields: JsonSchemaObject, value: unknown = {}) => {
	const onChange = vi.fn<(value: unknown) => void>();
	const Editor = schemaEditor(fields);
	const utils = render(<Editor value={value} onChange={onChange} />);
	return { onChange, ...utils };
};

describe("schemaEditor widgets", () => {
	it("renders every widget kind with schema-driven labels", () => {
		renderEditor(ALL_WIDGETS);
		// text input (title has a schema title; note falls back to key)
		expect(screen.getByLabelText(/Title/)).toBeTruthy();
		expect(screen.getByLabelText("note")).toBeTruthy();
		// number input
		expect(document.getElementById("builder-block-field-level")?.getAttribute("type")).toBe(
			"number",
		);
		// checkbox
		expect(screen.getByRole("checkbox")).toBeTruthy();
		// selects: enum, const and mixed-type enum
		const selects = document.querySelectorAll("select");
		expect(selects.length).toBe(3);
		// JSON textareas for array/object props
		expect(document.querySelectorAll("textarea").length).toBe(2);
	});

	it("marks required props and summarizes a single issue", () => {
		renderEditor(ALL_WIDGETS, {});
		// `title` is required and missing → exactly one issue
		expect(screen.getByText("1 validation issue")).toBeTruthy();
	});

	it("summarizes multiple issues with plural copy", () => {
		const fields: JsonSchemaObject = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "string" } },
			required: ["a", "b"],
		};
		renderEditor(fields, {});
		expect(screen.getByText("2 validation issues")).toBeTruthy();
	});

	it("shows no issue summary when the payload is valid", () => {
		renderEditor(ALL_WIDGETS, { title: "Hi" });
		expect(screen.queryByText(/validation issue/)).toBeNull();
	});

	it("tolerates a non-object value and a fields schema without properties/required", () => {
		const { container } = renderEditor({ type: "object" }, "garbage");
		expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
	});
});

describe("schemaEditor interactions", () => {
	it("text input commits string values", () => {
		const { onChange } = renderEditor(ALL_WIDGETS, { title: "Hi" });
		fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Bye" } });
		expect(onChange).toHaveBeenCalledWith({ title: "Bye" });
	});

	it("number input commits numbers and clears to undefined", () => {
		const { onChange } = renderEditor(ALL_WIDGETS, { level: 2 });
		const input = document.getElementById("builder-block-field-level") as HTMLInputElement;
		expect(input.value).toBe("2");
		fireEvent.change(input, { target: { value: "5" } });
		expect(onChange).toHaveBeenLastCalledWith({ level: 5 });
		fireEvent.change(input, { target: { value: "" } });
		expect(onChange).toHaveBeenLastCalledWith({ level: undefined });
	});

	it("select commits the matched option value (string and non-string)", () => {
		const { onChange } = renderEditor(ALL_WIDGETS, { size: "lg", pick: 1 });
		const selects = document.querySelectorAll("select");
		// enum select: sm/lg — pick "sm"
		fireEvent.change(selects[0]!, { target: { value: "sm" } });
		expect(onChange).toHaveBeenCalledWith({ size: "sm", pick: 1 });
		// const select has a single option; mixed enum exposes "1"/"two"
		const mixed = selects[2]!;
		expect(mixed.querySelectorAll("option").length).toBe(2);
		fireEvent.change(mixed, { target: { value: "two" } });
		expect(onChange).toHaveBeenLastCalledWith({ size: "lg", pick: "two" });
		// no matching option → commits undefined
		fireEvent.change(mixed, { target: { value: "" } });
		expect(onChange).toHaveBeenLastCalledWith({ size: "lg", pick: undefined });
	});

	it("checkbox toggles boolean values", () => {
		const { onChange } = renderEditor(ALL_WIDGETS, { dark: false });
		const box = screen.getByRole("checkbox");
		fireEvent.click(box);
		expect(onChange).toHaveBeenCalledWith({ dark: true });
	});

	it("displays object/array/boolean prop values as stable strings", () => {
		renderEditor(ALL_WIDGETS, { free: { a: 1 }, note: true, title: null });
		const free = document.getElementById("builder-block-field-free") as HTMLInputElement;
		expect(free.value).toBe('{"a":1}');
		const note = document.getElementById("builder-block-field-note") as HTMLInputElement;
		expect(note.value).toBe("true");
		const title = screen.getByLabelText(/Title/) as HTMLInputElement;
		expect(title.value).toBe("");
	});
});

describe("JsonField", () => {
	const jsonEditor = () => {
		const Editor = schemaEditor({
			type: "object",
			properties: { rows: { type: "array", items: { type: "string" } } },
		});
		return Editor;
	};

	it("shows pretty-printed JSON for structured values and empty for undefined", () => {
		const Editor = jsonEditor();
		const { rerender } = render(
			<Editor value={{ rows: ["a", "b"] }} onChange={vi.fn<(value: unknown) => void>()} />,
		);
		const area = document.getElementById("builder-block-field-rows") as HTMLTextAreaElement;
		expect(area.value).toBe('[\n  "a",\n  "b"\n]');
		rerender(<Editor value={{}} onChange={vi.fn<(value: unknown) => void>()} />);
		expect(area.value).toBe("");
	});

	it("commits parsed JSON on blur", () => {
		const onChange = vi.fn<(value: unknown) => void>();
		const Editor = jsonEditor();
		render(<Editor value={{}} onChange={onChange} />);
		const area = document.getElementById("builder-block-field-rows") as HTMLTextAreaElement;
		fireEvent.change(area, { target: { value: '["x", "y"]' } });
		fireEvent.blur(area);
		expect(onChange).toHaveBeenLastCalledWith({ rows: ["x", "y"] });
	});

	it("commits undefined for blank input and raw text for invalid JSON", () => {
		const onChange = vi.fn<(value: unknown) => void>();
		const Editor = jsonEditor();
		render(<Editor value={{ rows: ["a"] }} onChange={onChange} />);
		const area = document.getElementById("builder-block-field-rows") as HTMLTextAreaElement;
		// blur without editing is a no-op
		fireEvent.blur(area);
		expect(onChange).not.toHaveBeenCalled();
		// blank draft → undefined
		fireEvent.change(area, { target: { value: "   " } });
		fireEvent.blur(area);
		expect(onChange).toHaveBeenLastCalledWith({ rows: undefined });
		// invalid JSON → stored raw so schema validation flags it
		fireEvent.change(area, { target: { value: "[1,2" } });
		fireEvent.blur(area);
		expect(onChange).toHaveBeenLastCalledWith({ rows: "[1,2" });
	});
});

describe("defaultPropsFor", () => {
	it("skips properties without a default annotation", () => {
		const props = defaultPropsFor({
			type: "object",
			properties: {
				withDefault: { type: "string", default: "x" },
				withoutDefault: { type: "string" },
				boolSchema: true,
			},
		});
		expect(props).toEqual({ withDefault: "x" });
	});
});
