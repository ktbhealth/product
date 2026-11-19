import { sliceMessages } from "@ktb/i18n";
import type { BoundaryPageProps } from "@ktb/kernel";
import { SearchXIcon } from "lucide-react";

import { I18N_NAMESPACE, notFoundPageMessages } from "./i18n.ts";

/**
 * Replaceable 404 surface (P-boundaries): renders when no route matches
 * and this plugin wins the `notFound` boundary slot. Copy resolves from
 * the plugin catalog overlaid with the host's DB i18n slice
 * (`ctx.i18n`); the call-to-action row renders the host-collected
 * `app.notFound.actions` chrome nodes — the boundary never hardcodes
 * feature links, so it stays useful whichever plugins are enabled.
 */
export function NotFoundPageBoundary({ ctx, actions }: BoundaryPageProps) {
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, notFoundPageMessages(ctx.locale));
	return (
		<div className="py-24 text-center">
			<SearchXIcon className="mx-auto size-12 text-muted-foreground" />
			<h1 className="mt-4 text-2xl font-bold tracking-tight">{t.title}</h1>
			<p className="mt-1 text-sm text-muted-foreground">{t.body}</p>
			{actions !== undefined ? (
				<div className="mt-6 flex items-center justify-center gap-3">{actions}</div>
			) : null}
		</div>
	);
}
