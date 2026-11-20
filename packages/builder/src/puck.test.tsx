// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

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
			{ id: "a", elementKinds: [{ nope: true }, headingKind] },
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

	it("is SSR-safe (renderToString)", () => {
		const html = renderToString(
			<BuilderDocument builderJson={json} elementKinds={[headingKind]} />,
		);
		expect(html).toContain("Built with Puck");
	});
});
