import type { PanelPageContext } from "@ktb/kernel";

import type { OrchestrationDefRecordWire, OrchestrationListRow } from "./fns.ts";
import { OrchestrationEditorPage } from "./views/OrchestrationEditorPage.tsx";
import { PipelinesPage } from "./views/PipelinesPage.tsx";

interface PipelinesAdminData {
	readonly rows: readonly OrchestrationListRow[];
}

interface EditorData {
	readonly mode: "new" | "edit";
	readonly def: OrchestrationDefRecordWire | null;
	readonly kinds: readonly string[];
}

const asRows = (data: unknown): readonly OrchestrationListRow[] =>
	Array.isArray((data as PipelinesAdminData | undefined)?.rows)
		? (data as PipelinesAdminData).rows
		: [];

/**
 * `panel.pages` component for /platform/pipelines (P-120 phase 4):
 * the host dispatcher hands the loader Effect's result as `data`; this
 * wrapper narrows it into the view's props. `ctx.i18n`/`ctx.locale`
 * feed the plugin catalog (plugins cannot import the host i18n
 * runtime).
 */
export function PipelinesAdminPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	return <PipelinesPage rows={asRows(data)} i18n={ctx.i18n} locale={ctx.locale} />;
}

/**
 * `panel.pages` component for /platform/pipelines/* (the editor
 * wildcard): `data` carries the parsed mode, the stored def record
 * (edit) and the kind palette. A missing/unknown id arrives as
 * `def: null` — the view renders its not-found state.
 */
export function OrchestrationEditorPanelPage({
	data,
	ctx,
}: {
	data: unknown;
	ctx: PanelPageContext;
}) {
	const editor = (data ?? {}) as Partial<EditorData>;
	return (
		<OrchestrationEditorPage
			mode={editor.mode === "new" ? "new" : "edit"}
			def={editor.def?.def ?? null}
			kinds={editor.kinds ?? []}
			i18n={ctx.i18n}
			locale={ctx.locale}
		/>
	);
}
