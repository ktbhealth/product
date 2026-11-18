import { AuditPage } from "@ktb/audit/views/audit-page";
import type { AuditListResult } from "@ktb/audit";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { portalMessages, I18N_NAMESPACE } from "../i18n.ts";
import { patientActivityFacetsFn, patientActivityQueryFn } from "../fns.ts";

const EMPTY: AuditListResult = { entries: [], total: 0, limit: 100, offset: 0 };

/**
 * `/portal/activity` view (P-086): the patient-facing access log —
 * audit entries scoped to the signed-in person's own record, across
 * every clinic that keeps it. Reuses the staff feed's `AuditPage`
 * table with the portal's own title; `data` is the loader's
 * `AuditListResult` (unknown at the boundary, narrowed like
 * `AuditActivityPage` does for the clinician mount).
 */
export function PortalActivityPage({
	data,
	locale,
	i18n,
}: {
	data: unknown;
	locale: string;
	i18n?: PageI18nSlice;
}) {
	const d = (data ?? {}) as Partial<AuditListResult>;
	const t = sliceMessages(i18n, I18N_NAMESPACE, portalMessages(locale));
	return (
		<AuditPage
			entries={Array.isArray(d.entries) ? d.entries : EMPTY.entries}
			total={typeof d.total === "number" ? d.total : 0}
			limit={typeof d.limit === "number" ? d.limit : undefined}
			offset={typeof d.offset === "number" ? d.offset : 0}
			locale={locale}
			i18n={i18n}
			title={t.activityTitle}
			onQuery={(query) => patientActivityQueryFn({ data: query })}
			onFacets={() => patientActivityFacetsFn()}
		/>
	);
}
