import { useRouter } from "@tanstack/react-router";

import type { PageContext } from "@ktb/kernel";
import { PatientsPage, type PatientListItem } from "@ktb/patients/views";
import { patientDeleteApi } from "@ktb/patients/apis";

import { usePortalBase } from "./portal-base.ts";

/** The instance's patients list — the patients domain's list view
 * mounted as a portal page (P-081). `data` is the owner-scoped list the
 * page loader returned; mutations refresh through the router like the
 * app route does. */
export function ClinicianPatientsPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const router = useRouter();
	const portalBase = usePortalBase();
	return (
		<PatientsPage
			patients={(data ?? []) as PatientListItem[]}
			i18n={ctx.i18n}
			locale={ctx.locale}
			deleteApi={patientDeleteApi}
			onDeleted={() => void router.invalidate()}
			portalBase={portalBase}
		/>
	);
}
