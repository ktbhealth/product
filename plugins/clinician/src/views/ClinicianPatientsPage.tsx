import { useRouter } from "@tanstack/react-router";

import type { PageContext } from "@ktb/kernel";
import { PatientsPage, type PatientListItem } from "@ktb/patients/views";
import { patientDeleteApi } from "@ktb/patients/apis";

/** /portal/clinician/patients — the patients domain's list view mounted
 * as a portal page (P-081). `data` is the owner-scoped list the page
 * loader returned; mutations refresh through the router like the app
 * route does. */
export function ClinicianPatientsPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const router = useRouter();
	return (
		<PatientsPage
			patients={(data ?? []) as PatientListItem[]}
			locale={ctx.locale}
			deleteApi={patientDeleteApi}
			onDeleted={() => void router.invalidate()}
			portalBase="/portal/clinician"
		/>
	);
}
