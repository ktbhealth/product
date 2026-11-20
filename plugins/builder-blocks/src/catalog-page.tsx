import { useMemo, useState } from "react";

import {
	collectKindContributions,
	ELEMENT_KINDS_KIND,
	type ElementKind,
	type PanelPageContext,
} from "@ktb/kernel";
import { sliceMessages } from "@ktb/i18n";
import type { JsonSchemaObject } from "@ktb/json-schema";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";

import { defaultPropsFor } from "./schema-editor.tsx";
import { builderBlocksMessages, I18N_NAMESPACE, type BuilderBlocksMessages } from "./i18n.ts";

/**
 * `/platform/components` — the read-only element-kind catalog (P-108,
 * plan PL-013 phase 3). Collects every `elementKinds` manifest entry
 * from `ctx.plugins` (the same client registry chrome/pages read, in
 * topo order) and renders name, description, category, a live preview
 * through the kind's own `renderer` (fed its schema defaults) and the
 * prop schema (`fields`) as a property table.
 *
 * "Insert into page" wiring is intentionally absent — that lands with
 * the Puck editor (P-109/PL-014), which compiles this same registry.
 */

/** Narrow an untyped manifest payload to the catalog's view of an
 * ElementKind — the fields the page renders, nothing server-side. */
const asKind = (payload: unknown): ElementKind | null => {
	if (typeof payload !== "object" || payload === null) return null;
	const kind = payload as ElementKind;
	return typeof kind.kind === "string" && typeof kind.label === "string" ? kind : null;
};

const CATEGORY_ORDER: readonly string[] = ["layout", "content", "data", "media", "domain"];

const categoryLabel = (category: string | undefined, t: BuilderBlocksMessages): string => {
	switch (category) {
		case "layout":
			return t.categoryLayout;
		case "content":
			return t.categoryContent;
		case "data":
			return t.categoryData;
		case "media":
			return t.categoryMedia;
		case "domain":
			return t.categoryDomain;
		default:
			return t.categoryOther;
	}
};

const propRows = (fields: JsonSchemaObject | undefined) =>
	Object.entries(fields?.properties ?? {}).map(([name, schema]) => {
		const object = typeof schema === "object" && schema !== null ? schema : {};
		const type = Array.isArray(object.type)
			? object.type.join(" | ")
			: (object.type ?? (schema === true ? "any" : "never"));
		return {
			name,
			type,
			title: object.title ?? name,
			description: object.description,
			defaultValue: "default" in object ? object.default : undefined,
			required: fields?.required?.includes(name) ?? false,
		};
	});

const KindCard = ({
	kind,
	t,
}: {
	readonly kind: ElementKind;
	readonly t: BuilderBlocksMessages;
}) => {
	const Icon = kind.icon;
	const previewValue = defaultPropsFor(kind.fields);
	const props = propRows(kind.fields);
	return (
		<li className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
			<header className="flex items-start gap-3">
				{Icon !== undefined && (
					<span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<Icon className="size-4" />
					</span>
				)}
				<div className="flex min-w-0 flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="text-base font-medium">{kind.label}</h3>
						<Badge variant="secondary">{kind.kind}</Badge>
						{kind.category !== undefined && (
							<Badge variant="outline">{categoryLabel(kind.category, t)}</Badge>
						)}
					</div>
					{kind.description !== undefined && (
						<p className="text-sm text-muted-foreground">{kind.description}</p>
					)}
				</div>
			</header>

			<div className="flex flex-col gap-4 md:flex-row">
				<div className="min-w-0 flex-1">
					<p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
						{t.previewLabel}
					</p>
					<div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 p-4">
						{kind.renderer !== undefined ? (
							<kind.renderer value={previewValue} />
						) : (
							<span className="text-xs text-muted-foreground">—</span>
						)}
					</div>
				</div>
				<div className="min-w-0 flex-1">
					<p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
						{t.propsHeading}
					</p>
					{props.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t.noProps}</p>
					) : (
						<table className="w-full text-sm">
							<tbody>
								{props.map((row) => (
									<tr key={row.name} className="border-b border-border last:border-0">
										<td className="py-1.5 pr-3 align-top">
											<code className="text-xs">{row.name}</code>
										</td>
										<td className="py-1.5 pr-3 align-top text-xs text-muted-foreground">
											{row.type}
										</td>
										<td className="py-1.5 align-top text-xs text-muted-foreground">
											{row.title}
											{row.required && ` · ${t.requiredMark}`}
											{row.defaultValue !== undefined && ` · = ${JSON.stringify(row.defaultValue)}`}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					{kind.fields !== undefined && (
						<details className="mt-2">
							<summary className="cursor-pointer text-xs text-muted-foreground">
								JSON schema
							</summary>
							<pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs">
								{JSON.stringify(kind.fields, null, 2)}
							</pre>
						</details>
					)}
				</div>
			</div>
		</li>
	);
};

export const ComponentsCatalogPage = ({ ctx }: { data: unknown; ctx: PanelPageContext }) => {
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, builderBlocksMessages(ctx.locale));
	const [filter, setFilter] = useState("");

	const kinds = useMemo(
		() =>
			collectKindContributions(ctx.plugins, ELEMENT_KINDS_KIND)
				.map((entry) => asKind(entry.payload))
				.filter((kind): kind is ElementKind => kind !== null),
		[ctx.plugins],
	);

	const needle = filter.trim().toLowerCase();
	const visible =
		needle === ""
			? kinds
			: kinds.filter((kind) =>
					`${kind.kind} ${kind.label} ${kind.description ?? ""}`.toLowerCase().includes(needle),
				);

	const groups = useMemo(() => {
		const byCategory = new Map<string, ElementKind[]>();
		for (const kind of visible) {
			const key = kind.category ?? "";
			const list = byCategory.get(key) ?? [];
			list.push(kind);
			byCategory.set(key, list);
		}
		const ordered = CATEGORY_ORDER.map((c) => [c, byCategory.get(c) ?? []] as const);
		for (const [key, list] of byCategory) {
			if (!CATEGORY_ORDER.includes(key)) ordered.push([key, list] as const);
		}
		return ordered.filter(([, list]) => list.length > 0);
	}, [visible]);

	return (
		<PageContainer>
			<header className="flex flex-col gap-1">
				<h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
				<p className="text-sm text-muted-foreground">{t.description}</p>
			</header>
			<Input
				type="search"
				value={filter}
				onChange={(event) => setFilter(event.target.value)}
				placeholder={t.searchPlaceholder}
				className="max-w-sm"
			/>
			{groups.length === 0 ? (
				<div className="rounded-xl border border-dashed border-border p-8 text-center">
					<p className="text-sm font-medium">{t.emptyTitle}</p>
					<p className="text-sm text-muted-foreground">{t.emptyDescription}</p>
				</div>
			) : (
				groups.map(([category, list]) => (
					<section key={category || "other"} className="flex flex-col gap-3">
						<h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
							{categoryLabel(category === "" ? undefined : category, t)}
						</h2>
						<ul className="grid grid-cols-1 gap-4 xl:grid-cols-2">
							{list.map((kind) => (
								<KindCard key={kind.kind} kind={kind} t={t} />
							))}
						</ul>
					</section>
				))
			)}
			<p className="text-xs text-muted-foreground">{t.kindCount(visible.length)}</p>
		</PageContainer>
	);
};
