import type { PageContext } from "@ktb/kernel";
import { ConsultationsPage, type ConsultationListItem } from "@ktb/consultations/views";

import { usePortalBase } from "./portal-base.ts";

/** The instance's consultations list — the consultations domain's list
 * view mounted as a portal page (P-081). */
export function ClinicianConsultationsPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const portalBase = usePortalBase();
	return (
		<ConsultationsPage
			consultations={(data ?? []) as ConsultationListItem[]}
			i18n={ctx.i18n}
			locale={ctx.locale}
			portalBase={portalBase}
		/>
	);
}
