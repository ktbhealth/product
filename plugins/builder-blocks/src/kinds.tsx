import {
	ChartColumnIcon,
	Columns3Icon,
	ContainerIcon,
	Heading2Icon,
	MinusIcon,
	MousePointerClickIcon,
	MoveVerticalIcon,
	PanelTopIcon,
	TableIcon,
	type LucideIcon,
} from "lucide-react";

import type { ElementKind } from "@ktb/kernel";
import type { JsonSchemaObject } from "@ktb/json-schema";

import {
	COLUMNS_FIELDS,
	CONTAINER_FIELDS,
	CTA_FIELDS,
	DIVIDER_FIELDS,
	HEADING_FIELDS,
	METRIC_FIELDS,
	SECTION_FIELDS,
	SPACER_FIELDS,
	TABLE_FIELDS,
} from "./fields.ts";
import {
	ColumnsBlock,
	ContainerBlock,
	CtaBlock,
	DividerBlock,
	HeadingBlock,
	MetricBlock,
	SectionBlock,
	SpacerBlock,
	TableBlock,
} from "./renderers.tsx";
import { schemaEditor } from "./schema-editor.tsx";

/**
 * The `builder-blocks` element kinds (P-108): core site-builder
 * primitives contributed through the `elementKinds` manifest — the same
 * entries ./index.ts (server parity) and ./client.ts (browser bundle)
 * carry, so keep this module free of server-only imports.
 *
 * `kind` strings are the stable ids consumers store; `fields` is the
 * prop schema builder palettes compile (PL-014) and the catalog page
 * documents. `rich-text` and `image` are deliberately absent — they are
 * owned by plugins/rich-text and plugins/image (P-111).
 */

interface BlockSpec {
	readonly kind: string;
	readonly label: string;
	readonly description: string;
	readonly category: ElementKind["category"];
	readonly icon: LucideIcon;
	readonly fields: JsonSchemaObject;
	readonly renderer: ElementKind["renderer"];
}

const BLOCK_SPECS: readonly BlockSpec[] = [
	{
		kind: "section",
		label: "Section",
		description: "A full-width band with vertical padding and an optional muted background.",
		category: "layout",
		icon: PanelTopIcon,
		fields: SECTION_FIELDS,
		renderer: SectionBlock,
	},
	{
		kind: "container",
		label: "Container",
		description: "Centers content inside a max-width column.",
		category: "layout",
		icon: ContainerIcon,
		fields: CONTAINER_FIELDS,
		renderer: ContainerBlock,
	},
	{
		kind: "columns",
		label: "Columns",
		description: "An N-column grid for side-by-side content.",
		category: "layout",
		icon: Columns3Icon,
		fields: COLUMNS_FIELDS,
		renderer: ColumnsBlock,
	},
	{
		kind: "divider",
		label: "Divider",
		description: "A horizontal rule with vertical breathing room.",
		category: "layout",
		icon: MinusIcon,
		fields: DIVIDER_FIELDS,
		renderer: DividerBlock,
	},
	{
		kind: "spacer",
		label: "Spacer",
		description: "Vertical whitespace between blocks.",
		category: "layout",
		icon: MoveVerticalIcon,
		fields: SPACER_FIELDS,
		renderer: SpacerBlock,
	},
	{
		kind: "heading",
		label: "Heading",
		description: "A semantic heading at h1–h4 with alignment.",
		category: "content",
		icon: Heading2Icon,
		fields: HEADING_FIELDS,
		renderer: HeadingBlock,
	},
	{
		kind: "cta",
		label: "Call to action",
		description: "A button that links somewhere when a URL is set.",
		category: "content",
		icon: MousePointerClickIcon,
		fields: CTA_FIELDS,
		renderer: CtaBlock,
	},
	{
		kind: "metric",
		label: "Metric",
		description: "A headline stat: big value, label, optional hint.",
		category: "data",
		icon: ChartColumnIcon,
		fields: METRIC_FIELDS,
		renderer: MetricBlock,
	},
	{
		kind: "table",
		label: "Table",
		description: "A simple data table with string headers and rows.",
		category: "data",
		icon: TableIcon,
		fields: TABLE_FIELDS,
		renderer: TableBlock,
	},
];

/** The manifest entries — `editor` is the shared schema-driven editor
 * bound to each kind's `fields` schema. */
export const BUILDER_BLOCK_KINDS: readonly ElementKind[] = BLOCK_SPECS.map((spec) => ({
	kind: spec.kind,
	label: spec.label,
	description: spec.description,
	category: spec.category,
	icon: spec.icon,
	renderer: spec.renderer,
	editor: schemaEditor(spec.fields),
	fields: spec.fields,
}));
