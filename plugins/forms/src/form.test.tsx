// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonSchemaObject, ValidationIssue } from "@ktb/json-schema";

import type { FormDefinition } from "./definition.ts";
import { SchemaForm } from "./form.tsx";
import { formsMessages } from "./i18n.ts";

const def = (schema: JsonSchemaObject, over: Partial<FormDefinition> = {}): FormDefinition => ({
	id: "test-form",
	schema,
	...over,
});

const submit = () => fireEvent.click(screen.getByRole("button", { name: /submit/i }));

afterEach(cleanup);

describe("SchemaForm rendering", () => {
	it("renders labels, descriptions, required markers and chrome copy", () => {
		render(
			<SchemaForm
				definition={def(
					{
						type: "object",
						properties: {
							name: { type: "string", title: "Full name", description: "As on ID" },
						},
						required: ["name"],
					},
					{ description: "Fill this in", submitLabel: "Send it" },
				)}
			/>,
		);
		expect(screen.getByText("Fill this in")).toBeDefined();
		const input = screen.getByLabelText(/Full name/);
		expect(input.id).toBe("form-name");
		expect(screen.getByText("As on ID").id).toBe("form-name-desc");
		expect(screen.getByRole("button", { name: "Send it" })).toBeDefined();
		expect(input.getAttribute("required")).not.toBeNull();
	});

	it("falls back to property name, default submit label and en catalog", () => {
		render(
			<SchemaForm definition={def({ type: "object", properties: { age: { type: "integer" } } })} />,
		);
		expect(screen.getByLabelText("age")).toBeDefined();
		expect(screen.getByRole("button", { name: "Submit" })).toBeDefined();
	});

	it("uses a custom messages catalog", () => {
		render(
			<SchemaForm
				definition={def({ type: "object", properties: {} })}
				messages={formsMessages("pt-BR")}
			/>,
		);
		expect(screen.getByRole("button", { name: "Enviar" })).toBeDefined();
	});

	it("honors disabled and idPrefix", () => {
		render(
			<SchemaForm
				definition={def({ type: "object", properties: { a: { type: "string" } } })}
				disabled
				idPrefix="custom"
			/>,
		);
		expect(screen.getByLabelText("a").id).toBe("custom-a");
		expect(screen.getByLabelText("a").hasAttribute("disabled")).toBe(true);
		expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});
});

describe("text / number / textarea widgets", () => {
	it("submits string values and honors initialValue + defaults", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: {
						name: { type: "string" },
						city: { type: "string", default: "Lisboa" },
					},
				})}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ana" } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ name: "Ana", city: "Lisboa" });
	});

	it("uses initialValue when provided (non-record falls back to defaults)", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		const { unmount } = render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: { n: { type: "string", default: "d" } },
				})}
				initialValue="not-a-record"
				onSubmit={onSubmit}
			/>,
		);
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ n: "d" });
		unmount();
	});

	it("renders textarea via ui.widget and collects text", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def(
					{ type: "object", properties: { bio: { type: "string" } } },
					{ ui: { bio: { widget: "textarea", placeholder: "Tell us" } } },
				)}
				onSubmit={onSubmit}
			/>,
		);
		const area = screen.getByLabelText("bio") as HTMLTextAreaElement;
		expect(area.tagName).toBe("TEXTAREA");
		expect(area.placeholder).toBe("Tell us");
		fireEvent.change(area, { target: { value: "hello" } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ bio: "hello" });
	});

	it("parses numbers, keeps intermediates, applies min/max/step", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: {
						age: { type: "integer", minimum: 0, maximum: 150 },
						score: { type: "number" },
					},
				})}
				onSubmit={onSubmit}
			/>,
		);
		const age = screen.getByLabelText("age") as HTMLInputElement;
		expect(age.type).toBe("number");
		expect(age.step).toBe("1");
		expect(age.min).toBe("0");
		expect(age.max).toBe("150");
		fireEvent.change(age, { target: { value: "42" } });
		fireEvent.change(screen.getByLabelText("score"), { target: { value: "2.5" } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ age: 42, score: 2.5 });
	});

	it("stores undefined for cleared number inputs", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: { n: { type: "number" } },
				})}
				initialValue={{ n: 5 }}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.change(screen.getByLabelText(/^n/), { target: { value: "" } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({});
	});
});

describe("choice widgets", () => {
	it("renders enum as select with encoded options and empty choice", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: { color: { type: "string", enum: ["red", "blue"] } },
				})}
				onSubmit={onSubmit}
			/>,
		);
		const select = screen.getByLabelText("color") as HTMLSelectElement;
		expect(select.tagName).toBe("SELECT");
		expect(select.options).toHaveLength(3);
		expect(select.options[1]?.value).toBe('"red"');
		expect(select.options[1]?.text).toBe("red");
		// the empty choice clears the value (undefined → pruned on submit)
		fireEvent.change(select, { target: { value: "" } });
		fireEvent.change(select, { target: { value: '"blue"' } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ color: "blue" });
	});

	it("supports numeric enums, const, ui.options and ui.placeholder", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def(
					{
						type: "object",
						properties: {
							level: { enum: [1, 2] },
							kind: { const: "fixed" },
							pick: { type: "string" },
						},
					},
					{
						ui: {
							pick: {
								widget: "select",
								placeholder: "Pick one",
								options: [
									{ value: "a", label: "Alpha" },
									{ value: "b", label: "Beta" },
								],
							},
						},
					},
				)}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.change(screen.getByLabelText("level"), { target: { value: "2" } });
		fireEvent.change(screen.getByLabelText("kind"), { target: { value: '"fixed"' } });
		const pick = screen.getByLabelText("pick") as HTMLSelectElement;
		expect(pick.options[0]?.text).toBe("Pick one");
		expect(pick.options[1]?.text).toBe("Alpha");
		fireEvent.change(pick, { target: { value: '"b"' } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ level: 2, kind: "fixed", pick: "b" });
	});

	it("renders radio groups and reports the chosen option", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def(
					{
						type: "object",
						properties: { size: { type: "string", enum: ["S", "M"] } },
					},
					{ ui: { size: { widget: "radio" } } },
				)}
				onSubmit={onSubmit}
			/>,
		);
		const radios = screen.getAllByRole("radio");
		expect(radios).toHaveLength(2);
		fireEvent.click(radios[1] as HTMLElement);
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ size: "M" });
	});

	it("falls back to a text input when select/radio have no options", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def(
					{ type: "object", properties: { free: { type: "string" } } },
					{ ui: { free: { widget: "select" } } },
				)}
				onSubmit={onSubmit}
			/>,
		);
		const input = screen.getByLabelText("free") as HTMLInputElement;
		expect(input.type).toBe("text");
		fireEvent.change(input, { target: { value: "typed" } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ free: "typed" });
		cleanup();
		render(
			<SchemaForm
				definition={def(
					{ type: "object", properties: { free: { type: "string" } } },
					{ ui: { free: { widget: "radio" } } },
				)}
				onSubmit={onSubmit}
			/>,
		);
		const input2 = screen.getByLabelText("free") as HTMLInputElement;
		expect(input2.type).toBe("text");
		fireEvent.change(input2, { target: { value: "typed2" } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ free: "typed2" });
	});

	it("renders checkbox and switch widgets", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: {
						agree: { type: "boolean" },
						notify: { type: "boolean" },
					},
					required: ["agree"],
				})}
				onSubmit={onSubmit}
			/>,
		);
		const boxes = screen.getAllByRole("checkbox");
		expect(boxes).toHaveLength(2); // agree + notify both infer checkbox
		fireEvent.click(boxes[0] as HTMLElement);
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ agree: true });
	});

	it("renders switch via ui.widget and toggles it", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def(
					{ type: "object", properties: { notify: { type: "boolean" } } },
					{ ui: { notify: { widget: "switch" } } },
				)}
				onSubmit={onSubmit}
			/>,
		);
		const control = screen.getByRole("switch");
		fireEvent.click(control);
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ notify: true });
	});
});

describe("json widget", () => {
	it("parses valid JSON into typed values", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: { meta: { anyOf: [{ type: "object" }, { type: "string" }] } },
				})}
				onSubmit={onSubmit}
			/>,
		);
		const area = screen.getByLabelText("meta") as HTMLTextAreaElement;
		expect(area.tagName).toBe("TEXTAREA");
		fireEvent.change(area, { target: { value: '{"a":1}' } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ meta: { a: 1 } });
	});

	it("blocks submit when raw JSON text fails the schema", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		const onInvalid = vi.fn<(issues: readonly ValidationIssue[]) => void>();
		render(
			<SchemaForm
				definition={def(
					{
						type: "object",
						properties: { meta: { type: "object" } },
					},
					{ ui: { meta: { widget: "json" } } },
				)}
				onSubmit={onSubmit}
				onInvalid={onInvalid}
			/>,
		);
		const area = screen.getByLabelText("meta") as HTMLTextAreaElement;
		fireEvent.change(area, { target: { value: "{oops" } });
		expect(area.value).toBe("{oops");
		submit();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onInvalid).toHaveBeenCalled();
	});
});

describe("list widget", () => {
	const listDef = (items: JsonSchemaObject["items"], over: Record<string, unknown> = {}) =>
		def({
			type: "object",
			properties: {
				tags: { type: "array", items, ...over },
			},
		} as JsonSchemaObject);

	it("adds and removes string items within min/max bounds", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={listDef({ type: "string" }, { minItems: 1, maxItems: 2 })}
				onSubmit={onSubmit}
			/>,
		);
		const add = screen.getByRole("button", { name: /add item/i });
		// empty array: add enabled (0 < max)
		fireEvent.click(add);
		fireEvent.click(add);
		// maxItems reached → disabled
		expect((add as HTMLButtonElement).disabled).toBe(true);
		const inputs = screen.getAllByLabelText(/tags \d/);
		expect(inputs).toHaveLength(2);
		fireEvent.change(inputs[0] as HTMLElement, { target: { value: "a" } });
		fireEvent.change(inputs[1] as HTMLElement, { target: { value: "b" } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ tags: ["a", "b"] });
		// minItems=1 → one remove disabled at length 1
		const removes = screen.getAllByRole("button", { name: /remove item/i });
		expect((removes[0] as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(removes[0] as HTMLElement);
		expect(screen.getAllByLabelText(/tags \d/)).toHaveLength(1);
		expect(
			(screen.getAllByRole("button", { name: /remove item/i })[0] as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it("renders enum items as selects and defaults boolean items to false", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: {
						levels: { type: "array", items: { enum: ["low", "high"] } },
						flags: { type: "array", items: { type: "boolean" } },
					},
				})}
				initialValue={{ levels: ["low"], flags: [] }}
				onSubmit={onSubmit}
			/>,
		);
		const levelSelect = screen.getByLabelText("levels 1") as HTMLSelectElement;
		expect(levelSelect.tagName).toBe("SELECT");
		// two "Add item" buttons exist (levels + flags) — click the second
		const adds = screen.getAllByRole("button", { name: /add item/i });
		expect(adds).toHaveLength(2);
		fireEvent.click(adds[1] as HTMLElement);
		const flagBox = screen.getAllByRole("checkbox")[0] as HTMLElement;
		expect(flagBox).toBeDefined();
		submit();
		expect(onSubmit).toHaveBeenCalled();
	});
});

describe("object widget", () => {
	it("nests fields, submits deep values and reports nested issues", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		const onInvalid = vi.fn<(issues: readonly ValidationIssue[]) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: {
						address: {
							type: "object",
							title: "Address",
							description: "Where you live",
							properties: { zip: { type: "string", pattern: "^[0-9]{4}$" } },
							required: ["zip"],
						},
					},
				})}
				onSubmit={onSubmit}
				onInvalid={onInvalid}
			/>,
		);
		expect(screen.getByText("Address")).toBeDefined();
		expect(screen.getByText("Where you live")).toBeDefined();
		const zip = screen.getByLabelText(/zip/);
		expect(zip.id).toBe("form-address-zip");
		fireEvent.change(zip, { target: { value: "abcd" } });
		submit();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onInvalid).toHaveBeenCalled();
		// nested issue renders on the zip field + summary
		expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
		fireEvent.change(zip, { target: { value: "1000" } });
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ address: { zip: "1000" } });
	});

	it("surfaces a missing-required-object error on the fieldset", () => {
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: {
						address: { type: "object", properties: { zip: { type: "string" } } },
					},
					required: ["address"],
				})}
				initialValue={{}}
			/>,
		);
		submit();
		expect(screen.getByText(/must have required property 'address'/)).toBeDefined();
	});

	it("renders an empty fieldset for object schemas without properties", () => {
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: { anything: { type: "object" } },
				})}
			/>,
		);
		expect(screen.getByText("anything")).toBeDefined();
	});
});

describe("validation & a11y", () => {
	it("flags required fields, wires aria and summarizes issues", () => {
		const onInvalid = vi.fn<(issues: readonly ValidationIssue[]) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: {
						name: { type: "string", description: "Your name" },
					},
					required: ["name"],
					additionalProperties: false,
				})}
				initialValue={{ extra: "surprise" }}
				onInvalid={onInvalid}
			/>,
		);
		submit();
		expect(onInvalid).toHaveBeenCalled();
		const input = screen.getByLabelText(/name/);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		// description + error both wired into aria-describedby
		expect(input.getAttribute("aria-describedby")).toContain("form-name-desc");
		expect(input.getAttribute("aria-describedby")).toContain("form-name-err");
		// field error + summary alert present; stray "extra" listed
		const alerts = screen.getAllByRole("alert");
		expect(alerts.length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText(/needs? attention|problems? need/)).toBeDefined();
		expect(screen.getByText(/must NOT have additional properties/)).toBeDefined();
	});

	it("reports a root-level ($) issue in the summary", () => {
		render(
			<SchemaForm
				definition={def({
					type: "object",
					minProperties: 2,
					properties: { a: { type: "string" } },
				})}
			/>,
		);
		submit();
		expect(screen.getByText(/form: must NOT have fewer than 2 properties/)).toBeDefined();
	});

	it("clears nothing prematurely: issues persist until next submit", () => {
		const onSubmit = vi.fn<(value: unknown) => void>();
		render(
			<SchemaForm
				definition={def({
					type: "object",
					properties: { n: { type: "integer" } },
					required: ["n"],
				})}
				onSubmit={onSubmit}
			/>,
		);
		submit();
		expect(screen.getByLabelText(/^n/).getAttribute("aria-invalid")).toBe("true");
		fireEvent.change(screen.getByLabelText(/^n/), { target: { value: "3" } });
		// error stays visible until resubmit (documented v1 behavior)
		expect(screen.getByLabelText(/^n/).getAttribute("aria-invalid")).toBe("true");
		submit();
		expect(onSubmit).toHaveBeenCalledWith({ n: 3 });
		expect(screen.getByLabelText(/^n/).getAttribute("aria-invalid")).toBeNull();
	});

	it("submits without handlers attached", () => {
		render(
			<SchemaForm definition={def({ type: "object", properties: { a: { type: "string" } } })} />,
		);
		expect(() => submit()).not.toThrow();
	});
});

describe("widget edge cases", () => {
	it("downgrades forced list/object widgets on non-matching schemas", () => {
		const { unmount } = render(
			<SchemaForm
				definition={def(
					{ type: "object", properties: { v: { type: "string" } } },
					{ ui: { v: { widget: "list" } } },
				)}
			/>,
		);
		expect((screen.getByLabelText("v") as HTMLElement).tagName).toBe("TEXTAREA");
		unmount();
		render(
			<SchemaForm
				definition={def(
					{ type: "object", properties: { v: { type: "string" } } },
					{ ui: { v: { widget: "object" } } },
				)}
			/>,
		);
		expect((screen.getByLabelText("v") as HTMLElement).tagName).toBe("TEXTAREA");
	});

	it("renders a list widget whose items schema is absent", () => {
		render(
			<SchemaForm
				definition={def(
					{ type: "object", properties: { tags: { type: "array" } } },
					{ ui: { tags: { widget: "list" } } },
				)}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /add item/i }));
		// items ?? true → boolean schema → json widget (textarea)
		expect(document.querySelector("textarea")).not.toBeNull();
	});

	it("applies item schema defaults when adding list entries", () => {
		const { container } = render(
			<SchemaForm
				definition={def(
					{
						type: "object",
						properties: {
							tags: { type: "array", items: { type: "string", default: "d" } },
						},
					},
					{ ui: { tags: { widget: "list" } } },
				)}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /add item/i }));
		expect((container.querySelector("input") as HTMLInputElement).value).toBe("d");
	});

	it("honors a forced number widget on a boolean property schema", () => {
		render(
			<SchemaForm
				definition={def(
					{ type: "object", properties: { n: true } },
					{ ui: { n: { widget: "number" } } },
				)}
			/>,
		);
		expect((screen.getByLabelText("n") as HTMLInputElement).type).toBe("number");
	});
});
