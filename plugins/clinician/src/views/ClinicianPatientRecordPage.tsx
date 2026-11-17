import { useNavigate } from "@tanstack/react-router";

import type { PageContext } from "@ktb/kernel";
import type { Patient } from "@ktb/patients";
import { editPatientApi, newPatientApi, patientDeleteApi } from "@ktb/patients/apis";
import {
	PatientDetailPage,
	PatientFormPage,
	type PatientConsultationItem,
} from "@ktb/patients/views";

import { usePortalBase } from "./portal-base.ts";

/** Loader payload for <instance>/patients/* — the wildcard page
 * resolves `new`, `<id>` and `<id>/edit` subpaths server-side and tags
 * the result so the component picks the right domain view. */
type ClinicianPatientRecordData =
	| { readonly view: "new" }
	| { readonly view: "edit"; readonly patient: Patient }
	| {
			readonly view: "detail";
			readonly patient: Patient;
			readonly consultations: PatientConsultationItem[];
	  }
	| { readonly view: "missing" };

/** patients/{new,$id,$id/edit} under the current instance — patient
 * record surfaces mounted inside the portal shell (P-081). In-view
 * links stay under the live base so drill-down never drops the
 * clinician back into the app shell. */
export function ClinicianPatientRecordPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const navigate = useNavigate();
	const base = usePortalBase();
	const d = (data ?? { view: "missing" }) as ClinicianPatientRecordData;
	const onSaved = (id: number) => void navigate({ to: `${base}/patients/${id}` });

	switch (d.view) {
		case "new":
			return (
				<PatientFormPage
					api={newPatientApi}
					onSaved={onSaved}
					i18n={ctx.i18n}
					locale={ctx.locale}
					portalBase={base}
				/>
			);
		case "edit":
			return (
				<PatientFormPage
					patient={d.patient}
					api={editPatientApi(d.patient.id)}
					onSaved={onSaved}
					i18n={ctx.i18n}
					locale={ctx.locale}
					portalBase={base}
				/>
			);
		case "detail":
			return (
				<PatientDetailPage
					patient={d.patient}
					consultations={d.consultations}
					i18n={ctx.i18n}
					locale={ctx.locale}
					deleteApi={patientDeleteApi}
					onDeleted={() => void navigate({ to: `${base}/patients` })}
					portalBase={base}
				/>
			);
		default:
			return null;
	}
}
