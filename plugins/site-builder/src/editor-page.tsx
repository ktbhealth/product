import { useMemo, useState } from "react";

import { Puck, type Data } from "@puckeditor/core";
import "@puckeditor/core/puck.css";

import {
	builderDocFromData,
	emptyBuilderData,
	migrateBuilderDoc,
	parseBuilderDoc,
	serializeBuilderDoc,
	toPuckConfig,
	collectElementKinds,
} from "@ktb/builder";
import type { PanelPageContext } from "@ktb/kernel";
import { PageContainer } from "@ktbhealth/ui/components/page-container";

import { saveBuilderDocumentFn, type BuilderDocumentWire } from "./fns.ts";
import { sliceMessages } from "@ktb/i18n";
import { I18N_NAMESPACE, siteBuilderMessages, type SiteBuilderMessages } from "./i18n.ts";

/**
 * `/platform/pages/<id>/edit` and `/platform/layouts/<id>/edit` — the
 * Puck editor host (PL-014 / P-109). The panel loader resolves the
 * wildcard path to `{kind, id}` and returns the entity's stored
 * `builderJson`; this component compiles the client `elementKinds`
 * manifest into the Puck config (same adapter `<Render>` uses on the
 * public page path, so canvas and published output share components)
 * and publishes saves through `saveBuilderDocumentFn`.
 *
 * `<Puck>` SSRs to its shell safely (verified in the P-105 spike); the
 * interactive canvas hydrates on the client. Unsaved edits live only
 * in Puck's internal state — `onPublish` is the single write path, so
 * a stray render never persists partial documents.
 */

const asData = (data: unknown): BuilderDocumentWire | null => {
	if (typeof data !== "object" || data === null) return null;
	const d = data as BuilderDocumentWire;
	if ((d.kind !== "page" && d.kind !== "layout") || typeof d.id !== "number") return null;
	if (typeof d.title !== "string") return null;
	return d;
};

/** Stored `builderJson` → initial Puck `Data`: parse the versioned
 * wrapper, migrate to current, fall back to the empty document. */
const initialData = (builderJson: string | null): Data => {
	const doc = parseBuilderDoc(builderJson);
	if (doc === null) return emptyBuilderData() as Data;
	return migrateBuilderDoc(doc).data as Data;
};

type SaveState = "idle" | "saving" | "saved" | "error";

const saveLabel = (state: SaveState, t: SiteBuilderMessages): string => {
	switch (state) {
		case "saving":
			return t.saving;
		case "saved":
			return t.saved;
		case "error":
			return t.saveError;
		default:
			return t.unsavedHint;
	}
};

export function SiteBuilderEditorPage({
	data,
	ctx,
}: {
	readonly data: unknown;
	readonly ctx: PanelPageContext;
}) {
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, siteBuilderMessages(ctx.locale));
	const doc = asData(data);
	const elementKinds = useMemo(() => collectElementKinds(ctx.plugins), [ctx.plugins]);
	const config = useMemo(() => toPuckConfig(elementKinds), [elementKinds]);
	const [initial] = useState<Data>(() => initialData(doc?.builderJson ?? null));
	const [saveState, setSaveState] = useState<SaveState>("idle");

	if (doc === null) {
		return (
			<PageContainer>
				<p className="text-sm text-muted-foreground">{t.notFound}</p>
			</PageContainer>
		);
	}

	const onPublish = (next: Data) => {
		setSaveState("saving");
		void saveBuilderDocumentFn({
			data: {
				kind: doc.kind,
				id: doc.id,
				builderJson: serializeBuilderDoc(builderDocFromData(next)),
			},
		})
			.then((ok) => setSaveState(ok ? "saved" : "error"))
			.catch(() => setSaveState("error"));
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center justify-between gap-4 border-b border-border px-4 py-2">
				<div className="flex min-w-0 flex-col">
					<h1 className="truncate text-base font-semibold tracking-tight">{doc.title}</h1>
					{doc.subtitle !== null && (
						<p className="truncate text-xs text-muted-foreground">{doc.subtitle}</p>
					)}
				</div>
				<span
					className={`text-xs ${saveState === "error" ? "text-destructive" : "text-muted-foreground"}`}
				>
					{saveLabel(saveState, t)}
				</span>
			</header>
			<div className="min-h-0 flex-1">
				<Puck
					config={config}
					data={initial}
					onPublish={onPublish}
					headerTitle={doc.title}
					height="100%"
				/>
			</div>
		</div>
	);
}
