import type { PageContext } from "@ktb/kernel";
import { ConsultationsPage, type ConsultationListItem } from "@ktb/consultations/views";

/** /portal/clinician/consultations — the consultations domain's list
 * view mounted as a portal page (P-081). */
export function ClinicianConsultationsPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	return (
		<ConsultationsPage
			consultations={(data ?? []) as ConsultationListItem[]}
			locale={ctx.locale}
			portalBase="/portal/clinician"
		/>
	);
}
