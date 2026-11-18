import { useCallback, useEffect, useMemo, useState } from "react";

import type { PageContext } from "@ktb/kernel";
import { sliceMessages } from "@ktb/i18n";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Spinner } from "@ktbhealth/ui/components/spinner";

import { viewQueryFn, type ViewPageWire } from "../fns.ts";
import { collectViewDefinitions, viewPathFor } from "../definition.ts";
import { I18N_NAMESPACE, viewsMessages } from "../i18n.ts";
import { CardsView } from "./CardsView.tsx";
import { DetailView } from "./DetailView.tsx";
import { TableView } from "./TableView.tsx";
import { resolveViewText } from "./view-utils.ts";

/**
 * `/v/*` page — the generic host for contributed `view.def` entries.
 * The wildcard descriptor's loader returns a {@link ViewPageWire}
 * (list or detail payload); this component resolves the view
 * definition against `ctx.plugins` — the enabled-filtered client
 * registry, same contract as forms/wizards, so a disabled
 * contributor's view 404s exactly like an unknown path — and renders
 * the kind-appropriate view. Filter/pagination refetches go through
 * `viewQueryFn`.
 *
 * `data === null` (or a malformed payload) renders the localized
 * not-found state — the page `guard` already hard-404s unknown or
 * forbidden views server-side, so this only covers direct/mocked
 * invocations and loader edge cases.
 */

const isWire = (value: unknown): value is ViewPageWire =>
	typeof value === "object" &&
	value !== null &&
	((value as { mode?: unknown }).mode === "list" ||
		(value as { mode?: unknown }).mode === "detail") &&
	typeof (value as { def?: unknown }).def === "object" &&
	(value as { def?: unknown }).def !== null;

export interface ViewPageProps {
	readonly data: unknown;
	readonly ctx: PageContext;
}

export function ViewPage({ data, ctx }: ViewPageProps) {
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, viewsMessages(ctx.locale));
	// Client-side definition resolution mirrors forms/wizards: defs
	// come from `ctx.plugins` (enabled-filtered), matched to the wire
	// payload by mount path. `wire.def` stays on the payload as the
	// server-resolved copy — the registry def wins when both exist.
	const definitions = useMemo(() => collectViewDefinitions(ctx.plugins), [ctx.plugins]);
	const [wire, setWire] = useState<ViewPageWire | null>(() => (isWire(data) ? data : null));
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState(false);

	// The splat route can reuse this component across /v/<a> → /v/<b>
	// navigations — resync local state whenever fresh loader data lands.
	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the loader-data prop is the external system here
		setWire(isWire(data) ? data : null);
		setFailed(false);
	}, [data]);

	const refetch = useCallback(
		async (offset: number, values: Readonly<Record<string, string>>) => {
			/* v8 ignore next -- refetch only fires from list views, which always carry a path */
			if (wire === null || wire.mode !== "list") return;
			setBusy(true);
			setFailed(false);
			try {
				// The server-fn wire type is the serialization-mapped
				// ViewPageWire — narrow it back to the domain shape.
				const next = (await viewQueryFn({
					data: { path: wire.path, offset, values },
				})) as ViewPageWire | null;
				if (next === null || next.mode !== "list") {
					setFailed(true);
				} else {
					setWire(next);
				}
			} catch {
				setFailed(true);
			} finally {
				setBusy(false);
			}
		},
		[wire],
	);

	const def = wire === null ? undefined : definitions.find((d) => viewPathFor(d) === wire.path);
	if (wire === null || def === undefined) {
		return (
			<PageContainer>
				<Empty className="py-16">
					<EmptyHeader>
						<EmptyTitle>{t.notFoundTitle}</EmptyTitle>
						<EmptyDescription>{t.notFoundDescription}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</PageContainer>
		);
	}

	// Render against the client-registry def (identical to the
	// server-validated wire copy, but enablement-filtered).
	const viewWire: ViewPageWire = { ...wire, def };
	const title = resolveViewText(ctx.i18n, def.title);

	return (
		<PageContainer>
			<PageHeader title={title} description={def.collection} />
			{busy ? <Spinner className="size-4" /> : null}
			{failed ? <p className="text-sm text-destructive">{t.loadFailed}</p> : null}
			{viewWire.mode === "detail" ? (
				<DetailView wire={viewWire} messages={t} locale={ctx.locale} i18n={ctx.i18n} />
			) : def.kind === "cards" ? (
				<CardsView
					wire={viewWire}
					messages={t}
					locale={ctx.locale}
					i18n={ctx.i18n}
					onQuery={refetch}
					busy={busy}
				/>
			) : (
				<TableView
					wire={viewWire}
					messages={t}
					locale={ctx.locale}
					i18n={ctx.i18n}
					onQuery={refetch}
					busy={busy}
				/>
			)}
		</PageContainer>
	);
}
