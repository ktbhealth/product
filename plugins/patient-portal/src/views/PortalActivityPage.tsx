import { AuditPage } from "@ktb/audit/views/audit-page";
import type { AuditListResult } from "@ktb/audit";

import { portalMessages } from "../i18n.ts";

const EMPTY: AuditListResult = { entries: [], total: 0, limit: 100 };

/**
 * `/portal/activity` view (P-086): the patient-facing access log —
 * audit entries scoped to the signed-in person's own record, across
 * every clinic that keeps it. Reuses the staff feed's `AuditPage`
 * table with the portal's own title; `data` is the loader's
 * `AuditListResult` (unknown at the boundary, narrowed like
 * `AuditActivityPage` does for the clinician mount).
 */
export function PortalActivityPage({ data, locale }: { data: unknown; locale: string }) {
	const d = (data ?? {}) as Partial<AuditListResult>;
	return (
		<AuditPage
			entries={Array.isArray(d.entries) ? d.entries : EMPTY.entries}
			total={typeof d.total === "number" ? d.total : 0}
			locale={locale}
			title={portalMessages(locale).activityTitle}
		/>
	);
}
