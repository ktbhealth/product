import { sliceMessages } from "@ktb/i18n";
import type { ErrorBoundaryPageProps } from "@ktb/kernel";
import { Button } from "@ktbhealth/ui/components/button";
import { TriangleAlertIcon } from "lucide-react";

import { errorPageMessages, I18N_NAMESPACE } from "./i18n.ts";

/**
 * Replaceable router error boundary (plugin `error-page.boundary`):
 * the plugin-contributed surface the host renders in place of the
 * built-in RootError fallback. Equivalent to the built-in surface in
 * apps/web/src/routes/__root.tsx — warning icon, localized title/body,
 * a retry button wired to the host-injected `reset`, and the
 * host-rendered `actions` nodes collected from the
 * `app.error.actions` chrome region (feature links live in chrome
 * contributions, never hardcoded here). The `error` value is
 * intentionally never rendered — no stack traces, no internals.
 */
export function ErrorPageBoundary({ ctx, actions, reset }: ErrorBoundaryPageProps) {
	const m = sliceMessages(ctx.i18n, I18N_NAMESPACE, errorPageMessages(ctx.locale));
	return (
		<div className="py-24 text-center">
			<TriangleAlertIcon className="mx-auto size-12 text-muted-foreground" />
			<h1 className="mt-4 text-2xl font-bold tracking-tight">{m.title}</h1>
			<p className="mt-1 text-sm text-muted-foreground">{m.body}</p>
			<div className="mt-6 flex items-center justify-center gap-3">
				<Button type="button" onClick={reset}>
					{m.retry}
				</Button>
				{actions}
			</div>
		</div>
	);
}
