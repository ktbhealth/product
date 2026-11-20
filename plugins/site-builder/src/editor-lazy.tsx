import { lazy, Suspense } from "react";

import type { PanelPageContext } from "@ktb/kernel";

/**
 * Lazy boundary for the Puck editor (PL-014 / P-109). `editor-page.tsx`
 * statically imports `@puckeditor/core`, whose dnd-kit dependency
 * touches `ResizeObserver` at module-eval time — importing it from the
 * plugin manifests (`index.ts`/`client.ts`) would drag Puck into every
 * consumer of the registry (console shell, root route tests, any host
 * without a layout engine). The dynamic import keeps the editor — and
 * its ~1MB of editor chrome — in a route-scoped chunk that only loads
 * when an admin actually opens `/platform/{pages,layouts}/<id>/edit`.
 *
 * The wrapper carries its own `<Suspense>`: the panel dispatch renders
 * `component` without a boundary, so a bare `React.lazy` would suspend
 * forever.
 */
const PuckEditor = lazy(() =>
	import("./editor-page.tsx").then((module) => ({ default: module.SiteBuilderEditorPage })),
);

export const SiteBuilderEditorPage = ({
	data,
	ctx,
}: {
	readonly data: unknown;
	readonly ctx: PanelPageContext;
}) => (
	<Suspense fallback={null}>
		<PuckEditor data={data} ctx={ctx} />
	</Suspense>
);
