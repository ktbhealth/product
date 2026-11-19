import type { PanelPageContext } from "@ktb/kernel";
import type { JobRecord } from "@ktb/jobs-port";
import type { QueueInfo } from "@ktb/server-fns";

import { QueuePage } from "./views/QueuePage.tsx";

/** Loader payload for /platform/queue — each section is null when its
 * signal cannot be read (the view renders the unavailable state). */
export interface QueuePageData {
	readonly queues: readonly QueueInfo[] | null;
	readonly runs: readonly JobRecord[] | null;
	readonly kinds: readonly string[] | null;
}

/**
 * `panel.pages` component for /platform/queue: the host dispatcher
 * hands the loader Effect's result as `data`; this wrapper narrows it
 * back into the view's props (the admin gate already ran in the page
 * `guard`, the layout's beforeLoad and inside every service call).
 * `ctx.locale` feeds the view's catalog.
 */
export function QueuePlatformPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<QueuePageData>;
	return (
		<QueuePage
			queues={d.queues ?? null}
			runs={d.runs ?? null}
			kinds={d.kinds ?? null}
			i18n={ctx.i18n}
			locale={ctx.locale}
		/>
	);
}
