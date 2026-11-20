import type { JsonSchemaObject } from "@ktb/json-schema";

/**
 * Prop schemas (`ElementKind.fields`, P-108) for the builder-blocks
 * element kinds. Each schema is an object-typed JSON Schema in the
 * @ktb/json-schema draft-2020-12 subset — the same profile `form.def`
 * contributions use — so palettes can compile it into editor field
 * configs and consumers can validate stored props with
 * `compileSchema`/`validate`.
 *
 * Conventions:
 * - every editable prop is optional with a schema `default`; renderers
 *   fall back to the same defaults so `{}` previews correctly;
 * - `title` on a property is the palette/editor label;
 * - `additionalProperties: false` keeps stored props honest — unknown
 *   keys are a packaging bug, not silent data.
 */

const ENUM = <T extends string>(values: readonly T[], fallback: T) => ({
	type: "string" as const,
	enum: values,
	default: fallback,
});

export const SECTION_FIELDS: JsonSchemaObject = {
	type: "object",
	title: "Section",
	description: "A full-width band with vertical padding and an optional muted background.",
	properties: {
		padding: { ...ENUM(["none", "sm", "md", "lg"], "md"), title: "Padding" },
		tone: { ...ENUM(["default", "muted"], "default"), title: "Background" },
	},
	additionalProperties: false,
};

export const CONTAINER_FIELDS: JsonSchemaObject = {
	type: "object",
	title: "Container",
	description: "Centers content inside a max-width column.",
	properties: {
		maxWidth: {
			...ENUM(["sm", "md", "lg", "full"], "lg"),
			title: "Max width",
		},
	},
	additionalProperties: false,
};

export const COLUMNS_FIELDS: JsonSchemaObject = {
	type: "object",
	title: "Columns",
	description: "An N-column grid; cells are placeholders until the editor adds children.",
	properties: {
		columns: {
			type: "integer",
			minimum: 1,
			maximum: 4,
			default: 2,
			title: "Columns",
		},
		gap: { ...ENUM(["sm", "md", "lg"], "md"), title: "Gap" },
	},
	additionalProperties: false,
};

export const DIVIDER_FIELDS: JsonSchemaObject = {
	type: "object",
	title: "Divider",
	description: "A horizontal rule with vertical breathing room.",
	properties: {
		spacing: { ...ENUM(["sm", "md", "lg"], "md"), title: "Spacing" },
	},
	additionalProperties: false,
};

export const SPACER_FIELDS: JsonSchemaObject = {
	type: "object",
	title: "Spacer",
	description: "Vertical whitespace between blocks.",
	properties: {
		size: { ...ENUM(["sm", "md", "lg", "xl"], "md"), title: "Size" },
	},
	additionalProperties: false,
};

export const HEADING_FIELDS: JsonSchemaObject = {
	type: "object",
	title: "Heading",
	description: "A semantic heading at h1–h4 with alignment.",
	properties: {
		text: { type: "string", default: "Heading", title: "Text", maxLength: 200 },
		level: {
			...ENUM(["h1", "h2", "h3", "h4"], "h2"),
			title: "Level",
		},
		align: { ...ENUM(["left", "center", "right"], "left"), title: "Align" },
	},
	required: ["text"],
	additionalProperties: false,
};

export const CTA_FIELDS: JsonSchemaObject = {
	type: "object",
	title: "Call to action",
	description: "A button that links somewhere when `href` is set.",
	properties: {
		label: { type: "string", default: "Learn more", title: "Label", maxLength: 80 },
		href: { type: "string", title: "Link", maxLength: 500 },
		variant: {
			...ENUM(["default", "outline", "secondary", "ghost"], "default"),
			title: "Variant",
		},
		size: { ...ENUM(["sm", "default", "lg"], "default"), title: "Size" },
		align: { ...ENUM(["left", "center", "right"], "left"), title: "Align" },
	},
	required: ["label"],
	additionalProperties: false,
};

export const METRIC_FIELDS: JsonSchemaObject = {
	type: "object",
	title: "Metric",
	description: "A headline stat: big value, label, optional hint.",
	properties: {
		value: {
			type: ["string", "number"],
			default: "1,234",
			title: "Value",
		},
		label: { type: "string", default: "Metric", title: "Label", maxLength: 120 },
		hint: { type: "string", title: "Hint", maxLength: 200 },
	},
	required: ["value", "label"],
	additionalProperties: false,
};

export const TABLE_FIELDS: JsonSchemaObject = {
	type: "object",
	title: "Table",
	description: "A simple data table with string headers and rows.",
	properties: {
		headers: {
			type: "array",
			items: { type: "string", maxLength: 80 },
			default: ["Name", "Value"],
			title: "Headers",
		},
		rows: {
			type: "array",
			items: {
				type: "array",
				items: { type: "string", maxLength: 200 },
			},
			default: [
				["Appointments", "1,204"],
				["New patients", "86"],
			],
			title: "Rows",
		},
	},
	required: ["headers", "rows"],
	additionalProperties: false,
};
