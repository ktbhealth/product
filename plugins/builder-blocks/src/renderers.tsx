import { createElement } from "react";

import { Button, buttonVariants } from "@ktbhealth/ui/components/button";
import { Card, CardContent } from "@ktbhealth/ui/components/card";
import { Separator } from "@ktbhealth/ui/components/separator";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

/**
 * Renderer components for the `builder-blocks` element kinds (P-108).
 *
 * Every block is a pure function of its props payload: the elementKinds
 * contract hands the renderer `{ value }` where `value` is exactly what
 * the kind's `fields` JSON Schema describes (and what the schema-driven
 * editor edits). Renderers narrow `value` defensively — stored props may
 * predate a schema change or arrive hand-authored — and fall back to
 * the schema `default`s so a bare `{}` still renders sensibly (the
 * /platform/components catalog previews blocks with defaults only).
 *
 * Styling is exclusively @ktbhealth/ui components + Tailwind token
 * utilities (bg-muted, text-muted-foreground, border, …) — no hex, no
 * inline color styles — so blocks inherit theme tokens in both light
 * and dark mode.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown, fallback: string): string =>
	typeof value === "string" && value !== "" ? value : fallback;

const asStringArray = (value: unknown, fallback: readonly string[]): readonly string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string")
		? (value as readonly string[])
		: fallback;

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
	allowed.includes(value as T) ? (value as T) : fallback;

/* ------------------------------------------------------------------ */
/* Layout primitives                                                   */
/* ------------------------------------------------------------------ */

export type SectionPadding = "none" | "sm" | "md" | "lg";
export type SectionTone = "default" | "muted";

const SECTION_PADDING: Record<SectionPadding, string> = {
	none: "",
	sm: "py-2",
	md: "py-6",
	lg: "py-12",
};

const SECTION_TONE: Record<SectionTone, string> = {
	default: "",
	muted: "bg-muted",
};

const SECTION_PADDING_VALUES = ["none", "sm", "md", "lg"] as const;
const SECTION_TONE_VALUES = ["default", "muted"] as const;

/** `section` — a full-width band with vertical padding and an optional
 * muted background. Children composition lands with the Puck editor
 * (PL-014); v1 renders the band itself. */
export const SectionBlock = ({ value }: { readonly value: unknown }) => {
	const props = isRecord(value) ? value : {};
	const padding = pick(props.padding, SECTION_PADDING_VALUES, "md");
	const tone = pick(props.tone, SECTION_TONE_VALUES, "default");
	return <section className={`${SECTION_PADDING[padding]} ${SECTION_TONE[tone]}`.trim()} />;
};

export type ContainerWidth = "sm" | "md" | "lg" | "full";

const CONTAINER_WIDTH: Record<ContainerWidth, string> = {
	sm: "max-w-2xl",
	md: "max-w-4xl",
	lg: "max-w-6xl",
	full: "max-w-none",
};

const CONTAINER_WIDTH_VALUES = ["sm", "md", "lg", "full"] as const;

/** `container` — centers content inside a max-width column. */
export const ContainerBlock = ({ value }: { readonly value: unknown }) => {
	const props = isRecord(value) ? value : {};
	const width = pick(props.maxWidth, CONTAINER_WIDTH_VALUES, "lg");
	return (
		<div className={`mx-auto w-full px-4 md:px-6 ${CONTAINER_WIDTH[width]}`}>
			<div className="min-h-8 rounded-lg border border-dashed border-border" />
		</div>
	);
};

export type ColumnsGap = "sm" | "md" | "lg";

const COLUMNS_GAP: Record<ColumnsGap, string> = {
	sm: "gap-2",
	md: "gap-4",
	lg: "gap-8",
};

const COLUMNS_COLS: Record<number, string> = {
	1: "grid-cols-1",
	2: "grid-cols-2",
	3: "grid-cols-3",
	4: "grid-cols-4",
};

const COLUMNS_GAP_VALUES = ["sm", "md", "lg"] as const;

/** `columns` — an N-column grid. Cells are dashed placeholders until the
 * editor supplies droppable children (PL-014). */
export const ColumnsBlock = ({ value }: { readonly value: unknown }) => {
	const props = isRecord(value) ? value : {};
	const count =
		typeof props.columns === "number" && Number.isInteger(props.columns)
			? Math.min(4, Math.max(1, props.columns))
			: 2;
	const gap = pick(props.gap, COLUMNS_GAP_VALUES, "md");
	return (
		<div className={`grid ${COLUMNS_COLS[count]} ${COLUMNS_GAP[gap]}`}>
			{Array.from({ length: count }, (_, index) => (
				<div
					// oxlint-disable-next-line react/no-array-index-key -- placeholder cells are positional by definition
					key={index}
					className="min-h-24 rounded-lg border border-dashed border-border bg-muted/30"
				/>
			))}
		</div>
	);
};

export type DividerSpacing = "sm" | "md" | "lg";

const DIVIDER_SPACING: Record<DividerSpacing, string> = {
	sm: "py-2",
	md: "py-4",
	lg: "py-8",
};

const DIVIDER_SPACING_VALUES = ["sm", "md", "lg"] as const;

/** `divider` — a horizontal rule with vertical breathing room. */
export const DividerBlock = ({ value }: { readonly value: unknown }) => {
	const props = isRecord(value) ? value : {};
	const spacing = pick(props.spacing, DIVIDER_SPACING_VALUES, "md");
	return (
		<div className={DIVIDER_SPACING[spacing]}>
			<Separator />
		</div>
	);
};

export type SpacerSize = "sm" | "md" | "lg" | "xl";

const SPACER_SIZE: Record<SpacerSize, string> = {
	sm: "h-4",
	md: "h-8",
	lg: "h-16",
	xl: "h-24",
};

const SPACER_SIZE_VALUES = ["sm", "md", "lg", "xl"] as const;

/** `spacer` — vertical whitespace between blocks. */
export const SpacerBlock = ({ value }: { readonly value: unknown }) => {
	const props = isRecord(value) ? value : {};
	const size = pick(props.size, SPACER_SIZE_VALUES, "md");
	return <div aria-hidden="true" className={SPACER_SIZE[size]} />;
};

/* ------------------------------------------------------------------ */
/* Content                                                             */
/* ------------------------------------------------------------------ */

export type HeadingLevel = "h1" | "h2" | "h3" | "h4";
export type TextAlign = "left" | "center" | "right";

const HEADING_CLASS: Record<HeadingLevel, string> = {
	h1: "text-4xl",
	h2: "text-3xl",
	h3: "text-2xl",
	h4: "text-xl",
};

const TEXT_ALIGN: Record<TextAlign, string> = {
	left: "text-left",
	center: "text-center",
	right: "text-right",
};

const HEADING_LEVEL_VALUES = ["h1", "h2", "h3", "h4"] as const;
const TEXT_ALIGN_VALUES = ["left", "center", "right"] as const;

/** `heading` — a semantic heading at h1–h4 with alignment. */
export const HeadingBlock = ({ value }: { readonly value: unknown }) => {
	const props = isRecord(value) ? value : {};
	const text = asString(props.text, "Heading");
	const level = pick(props.level, HEADING_LEVEL_VALUES, "h2");
	const align = pick(props.align, TEXT_ALIGN_VALUES, "left");
	return createElement(
		level,
		{
			className: `font-semibold tracking-tight ${HEADING_CLASS[level]} ${TEXT_ALIGN[align]}`,
		},
		text,
	);
};

export type CtaVariant = "default" | "outline" | "secondary" | "ghost";
export type CtaSize = "sm" | "default" | "lg";

const CTA_VARIANT_VALUES = ["default", "outline", "secondary", "ghost"] as const;
const CTA_SIZE_VALUES = ["sm", "default", "lg"] as const;
const CTA_JUSTIFY: Record<TextAlign, string> = {
	left: "justify-start",
	center: "justify-center",
	right: "justify-end",
};

/** `cta` — a call-to-action button; renders an anchor when `href` is
 * set, a plain button otherwise (no navigation wired yet — the editor
 * owns interactivity). */
export const CtaBlock = ({ value }: { readonly value: unknown }) => {
	const props = isRecord(value) ? value : {};
	const label = asString(props.label, "Learn more");
	const href = typeof props.href === "string" && props.href !== "" ? props.href : undefined;
	const variant = pick(props.variant, CTA_VARIANT_VALUES, "default");
	const size = pick(props.size, CTA_SIZE_VALUES, "default");
	const align = pick(props.align, TEXT_ALIGN_VALUES, "left");
	return (
		<div className={`flex ${CTA_JUSTIFY[align]}`}>
			{href === undefined ? (
				<Button variant={variant} size={size}>
					{label}
				</Button>
			) : (
				<a href={href} className={buttonVariants({ variant, size })}>
					{label}
				</a>
			)}
		</div>
	);
};

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

/** `metric` — a headline stat: big value, label, optional hint. */
export const MetricBlock = ({ value }: { readonly value: unknown }) => {
	const props = isRecord(value) ? value : {};
	const metricValue =
		typeof props.value === "number" || typeof props.value === "string" ? String(props.value) : "—";
	const label = asString(props.label, "Metric");
	const hint = typeof props.hint === "string" && props.hint !== "" ? props.hint : undefined;
	return (
		<Card size="sm">
			<CardContent className="flex flex-col gap-1">
				<p className="text-3xl font-semibold tracking-tight">{metricValue}</p>
				<p className="text-sm text-muted-foreground">{label}</p>
				{hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
			</CardContent>
		</Card>
	);
};

/** `table` — a simple data table: string headers + string rows. */
export const TableBlock = ({ value }: { readonly value: unknown }) => {
	const props = isRecord(value) ? value : {};
	const headers = asStringArray(props.headers, ["Column A", "Column B"]);
	const rawRows = Array.isArray(props.rows) ? props.rows : [];
	const rows = rawRows.map((row) =>
		Array.isArray(row)
			? row.map((cell) => (typeof cell === "string" ? cell : String(cell ?? "")))
			: [],
	);
	return (
		<div className="overflow-x-auto rounded-lg border border-border">
			<Table>
				<TableHeader>
					<TableRow>
						{headers.map((header, index) => (
							// oxlint-disable-next-line react/no-array-index-key -- header order is the identity
							<TableHead key={index}>{header}</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row, rowIndex) => (
						// oxlint-disable-next-line react/no-array-index-key -- row order is the identity
						<TableRow key={rowIndex}>
							{row.map((cell, cellIndex) => (
								// oxlint-disable-next-line react/no-array-index-key -- cell order is the identity
								<TableCell key={cellIndex}>{cell}</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
};
