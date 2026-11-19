import type { PanelPageContext } from "@ktb/kernel";
import type { JobRecord } from "@ktb/jobs-port";
import type { CronJobInfo } from "@ktb/server-fns";

import { CronPage } from "./views/CronPage.tsx";

/** Loader payload for /platform/cron — each section is null when its
 * signal cannot be read (the view renders the unavailable state). */
export interface CronPageData {
	readonly jobs: readonly CronJobInfo[] | null;
	readonly runs: readonly JobRecord[] | null;
}

/**
 * `panel.pages` component for /platform/cron: the host dispatcher
 * hands the loader Effect's result as `data`; this wrapper narrows it
 * back into the view's props (the admin gate already ran in the page
 * `guard`, the layout's beforeLoad and inside every service call).
 * `ctx.locale` feeds the view's catalog.
 */
export function CronPlatformPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<CronPageData>;
	return (
		<CronPage jobs={d.jobs ?? null} runs={d.runs ?? null} i18n={ctx.i18n} locale={ctx.locale} />
	);
}
