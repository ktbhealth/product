import type { PageContext } from "@ktb/kernel";

import { auditMessages } from "./i18n.ts";
import type { AuditListResult } from "./index.ts";
import { auditActivityFacetsFn, auditActivityListFn } from "./fns.ts";
import { AuditPage } from "./views/AuditPage.tsx";

const EMPTY: AuditListResult = { entries: [], total: 0, limit: 200, offset: 0 };

/**
 * `pages` component for /portal/<instance>/activity: the host
 * dispatcher hands the loader Effect's result as `data`; this wrapper
 * narrows it back into the view's props (the actor scope — self plus
 * delegated doctor profiles — already resolved inside
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
			limit={typeof d.limit === "number" ? d.limit : undefined}
			offset={typeof d.offset === "number" ? d.offset : 0}
			locale={ctx.locale}
			title={auditMessages(ctx.locale).activityTitle}
			onQuery={(query) => auditActivityListFn({ data: query })}
			onFacets={() => auditActivityFacetsFn()}
		/>
	);
}
