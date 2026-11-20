// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ElementKind, Plugin } from "@ktb/kernel";

import { builderDocFromData, serializeBuilderDoc } from "./doc.ts";
import { BuilderDocument, collectElementKinds, toPuckConfig } from "./puck.tsx";

afterEach(cleanup);

const HeadingRenderer = ({ value }: { value: unknown }) => {
	const text =
		typeof value === "object" && value !== null
			? String((value as { text?: unknown }).text ?? "")
			: "";
	return <h2 data-testid="heading">{text}</h2>;
};

const RichTextRenderer = ({ value }: { value: unknown }) => (
	<div data-testid="richtext">{JSON.stringify(value)}</div>
);

const HeadingEditor = ({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) => (
	<button data-testid="editor" onClick={() => onChange({ text: "edited" })}>
		{JSON.stringify(value)}
	</button>
);

const headingKind: ElementKind = {
	kind: "heading",
	label: "Heading",
	description: "A heading",
	category: "content",
	fields: {
		type: "object",
		properties: {
			text: { type: "string", default: "Hello", title: "Text" },
			level: { type: "string", enum: ["h1", "h2"], default: "h2", title: "Level" },
			tags: { type: "array", items: { type: "string" }, title: "Tags" },
		},
	},
	renderer: HeadingRenderer,
};

const richTextKind: ElementKind = {
	kind: "rich-text",
	label: "Rich text",
	renderer: RichTextRenderer,
	editor: HeadingEditor,
};

const MetaRenderer = ({ value }: { value: unknown }) => (
	<div data-testid="meta">{JSON.stringify(value)}</div>
);

const metaKind: ElementKind = {
	kind: "meta",
	label: "Meta",
	renderer: MetaRenderer,
	fields: {
		type: "object",
		properties: {
			featured: { type: "boolean", title: "Featured" },
			weight: { type: "integer" },
			ratio: { type: "number" },
			tone: { const: "brand", title: "Tone" },
			size: { enum: [1, 2], title: "Size" },
			flag: true,
			maybe: { type: ["string", "null"] },
		},
	},
};

const bannerKind: ElementKind = {
	kind: "banner",
	label: "Banner",
	renderer: MetaRenderer,
};

const emptyFieldsKind: ElementKind = {
	kind: "empty-fields",
	label: "Empty fields",
	renderer: MetaRenderer,
	fields: { type: "object" },
};

describe("collectElementKinds", () => {
	it("collects elementKinds payloads in plugin order", () => {
		const plugins = [
			{ id: "a", elementKinds: [headingKind] },
			{ id: "b", elementKinds: [richTextKind] },
		] as unknown as Plugin[];
		const kinds = collectElementKinds(plugins);
		expect(kinds.map((k) => k.kind)).toEqual(["heading", "rich-text"]);
	});

	it("skips malformed payloads", () => {
		const plugins = [
			{
				id: "a",
				elementKinds: [
					42,
					"x",
					null,
					{ nope: true },
					{ kind: 1, label: "L" },
					{ kind: "x" },
					headingKind,
				],
			},
		] as unknown as Plugin[];
		expect(collectElementKinds(plugins).map((k) => k.kind)).toEqual(["heading"]);
	});
});

describe("toPuckConfig", () => {
	it("compiles flat kinds with native fields and defaults", () => {
		const config = toPuckConfig([headingKind]);
		const component = (config.components as Record<string, any>).heading;
		expect(component.label).toBe("Heading");
		expect(component.fields.text.type).toBe("text");
		expect(component.fields.level.type).toBe("select");
		expect(component.fields.tags.type).toBe("custom");
		expect(component.defaultProps).toEqual({ text: "Hello", level: "h2" });
		expect(typeof component.render).toBe("function");
	});

	it("wraps editor-only kinds under a single value field", () => {
		const config = toPuckConfig([richTextKind]);
		const component = (config.components as Record<string, any>)["rich-text"];
		expect(Object.keys(component.fields)).toEqual(["value"]);
		expect(component.fields.value.type).toBe("custom");
	});

	it("groups components into categories", () => {
		const config = toPuckConfig([headingKind, richTextKind]);
		const categories = config.categories as Record<string, { components: string[] }>;
		expect(categories.content.components).toEqual(["heading"]);
		expect(categories.other.components).toEqual(["rich-text"]);
	});

	it("maps boolean/number props to native fields and const to select", () => {
		const config = toPuckConfig([metaKind]);
		const fields = (config.components as Record<string, any>).meta.fields;
		expect(fields.featured.type).toBe("checkbox");
		expect(fields.weight.type).toBe("number");
		expect(fields.ratio.type).toBe("number");
		expect(fields.tone.type).toBe("select");
		expect(fields.tone.options).toEqual([{ label: "brand", value: "brand" }]);
		// Non-string enums and union/boolean schemas can't be Puck
		// selects — JSON fallback.
		expect(fields.size.type).toBe("custom");
		expect(fields.flag.type).toBe("custom");
		expect(fields.maybe.type).toBe("custom");
	});

	it("gives render-only kinds an empty field map", () => {
		const config = toPuckConfig([bannerKind]);
		const component = (config.components as Record<string, any>).banner;
		expect(component.fields).toEqual({});
		expect(component.defaultProps).toBeUndefined();
	});

	it("tolerates field schemas without a properties map", () => {
		const config = toPuckConfig([emptyFieldsKind]);
		const component = (config.components as Record<string, any>)["empty-fields"];
		expect(component.fields).toEqual({});
		expect(component.defaultProps).toEqual({});
	});

	it("omits categories when no kind survives", () => {
		expect(toPuckConfig([]).categories).toBeUndefined();
	});

	it("skips kinds without a renderer", () => {
		const config = toPuckConfig([{ kind: "ghost", label: "Ghost" }]);
		expect(config.components).toEqual({});
	});

	it("flat render strips puck internals before calling the renderer", () => {
		const config = toPuckConfig([headingKind]);
		const render = (config.components as Record<string, any>).heading.render;
		const element = render({
			id: "abc",
			puck: {},
			editMode: true,
			text: "Hi",
			level: "h1",
		});
		// Renderer received only the payload props.
		expect(element.props.value).toEqual({ text: "Hi", level: "h1" });
	});

	it("wrapped render passes props.value to the renderer", () => {
		const config = toPuckConfig([richTextKind]);
		const render = (config.components as Record<string, any>)["rich-text"].render;
		const element = render({ id: "x", value: [{ type: "p" }] });
		expect(element.props.value).toEqual([{ type: "p" }]);
	});
});

describe("custom puck fields", () => {
	const fieldFor = (kind: ElementKind, prop: string) =>
		(toPuckConfig([kind]).components as Record<string, any>)[kind.kind].fields[prop];

	it("wrapped field mounts the kind editor with value/onChange", () => {
		const onChange = () => {};
		const field = fieldFor(richTextKind, "value");
		const element = field.render({ value: [{ type: "p" }], onChange });
		expect(element.type).toBe(HeadingEditor);
		expect(element.props.value).toEqual([{ type: "p" }]);
		expect(element.props.onChange).toBe(onChange);
	});

	it("JSON field commits parsed values on blur and stores raw text on parse failure", () => {
		const onChange = vi.fn();
		const FieldRender = fieldFor(headingKind, "tags").render;
		const { container } = render(
			<FieldRender value={["a"]} onChange={onChange} readOnly={false} />,
		);
		const area = container.querySelector("textarea")!;
		expect(area.value).toContain('"a"');

		// Empty draft → clears the prop.
		fireEvent.change(area, { target: { value: "   " } });
		fireEvent.blur(area);
		expect(onChange).toHaveBeenLastCalledWith(undefined);

		// Valid JSON → parsed value.
		fireEvent.change(area, { target: { value: '{"x":1}' } });
		fireEvent.blur(area);
		expect(onChange).toHaveBeenLastCalledWith({ x: 1 });

		// Invalid JSON → stored raw so schema validation can flag it.
		fireEvent.change(area, { target: { value: "{bad" } });
		fireEvent.blur(area);
		expect(onChange).toHaveBeenLastCalledWith("{bad");

		// Blur without an edit is a no-op.
		const calls = onChange.mock.calls.length;
		fireEvent.blur(area);
		expect(onChange).toHaveBeenCalledTimes(calls);
	});

	it("JSON field renders empty for absent values and honors readOnly", () => {
		const FieldRender = fieldFor(headingKind, "tags").render;
		const missing = render(<FieldRender value={null} onChange={() => {}} />);
		expect(missing.container.querySelector("textarea")!.value).toBe("");
		missing.unmount();
		const undef = render(<FieldRender value={undefined} onChange={() => {}} />);
		expect(undef.container.querySelector("textarea")!.value).toBe("");
		undef.unmount();
		const ro = render(<FieldRender value={["a"]} onChange={() => {}} readOnly={true} />);
		expect(ro.container.querySelector("textarea")!.readOnly).toBe(true);
	});
});

describe("BuilderDocument", () => {
	const doc = builderDocFromData({
		root: { props: {} },
		content: [{ type: "heading", props: { id: "h1", text: "Built with Puck" } }],
		zones: {},
	});
	const json = serializeBuilderDoc(doc);

	it("renders stored content through the kind renderer", () => {
		const { container } = render(
			<BuilderDocument builderJson={json} elementKinds={[headingKind]} />,
		);
		expect(screen.getByTestId("heading").textContent).toBe("Built with Puck");
		expect(container.querySelector("h2")).not.toBeNull();
	});

	it("returns null for absent or malformed builderJson", () => {
		const { container } = render(
			<BuilderDocument builderJson={null} elementKinds={[headingKind]} />,
		);
		expect(container.innerHTML).toBe("");
		const bad = render(<BuilderDocument builderJson="{oops" elementKinds={[headingKind]} />);
		expect(bad.container.innerHTML).toBe("");
	});

	it("returns null for malformed Puck data instead of crashing Render", () => {
		const malformed = serializeBuilderDoc(builderDocFromData({ content: [{}] }));
		const { container } = render(
			<BuilderDocument builderJson={malformed} elementKinds={[headingKind]} />,
		);
		expect(container.innerHTML).toBe("");
	});

	it("is SSR-safe (renderToString)", () => {
		const html = renderToString(
			<BuilderDocument builderJson={json} elementKinds={[headingKind]} />,
		);
		expect(html).toContain("Built with Puck");
	});
});
