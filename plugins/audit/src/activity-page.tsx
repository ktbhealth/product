import type { PageContext } from "@ktb/kernel";

import { auditMessages } from "./i18n.ts";
import type { AuditListResult } from "./index.ts";
import { AuditPage } from "./views/AuditPage.tsx";

const EMPTY: AuditListResult = { entries: [], total: 0, limit: 200 };

/**
 * `pages` component for /portal/<instance>/activity (P-080): the host
 * dispatcher hands the loader Effect's result as `data`; this wrapper
 * narrows it back into the view's props (tenant scope and the
 * `audit.read` grant already ran in the page `guard` and inside
 * `Audit.activityList`). `ctx.locale` feeds the view's catalog; the
 * title is the staff-facing "Activity" rather than the console's
 * "Audit log".
 */
export function AuditActivityPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const d = (data ?? {}) as Partial<AuditListResult>;
	return (
		<AuditPage
			entries={Array.isArray(d.entries) ? d.entries : EMPTY.entries}
			total={typeof d.total === "number" ? d.total : 0}
			locale={ctx.locale}
			title={auditMessages(ctx.locale).activityTitle}
		/>
	);
}
