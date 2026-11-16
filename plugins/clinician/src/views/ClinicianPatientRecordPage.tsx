import { useNavigate } from "@tanstack/react-router";

import type { PageContext } from "@ktb/kernel";
import type { Patient } from "@ktb/patients";
import { editPatientApi, newPatientApi, patientDeleteApi } from "@ktb/patients/apis";
import {
	PatientDetailPage,
	PatientFormPage,
	type PatientConsultationItem,
} from "@ktb/patients/views";

/** The clinician portal instance base — every in-view link stays under
 * it so drill-down never drops the clinician back into the app shell. */
const BASE = "/portal/clinician";

/** Loader payload for /portal/clinician/patients/* — the wildcard page
 * resolves `new`, `<id>` and `<id>/edit` subpaths server-side and tags
 * the result so the component picks the right domain view. */
export type ClinicianPatientRecordData =
	| { readonly view: "new" }
	| { readonly view: "edit"; readonly patient: Patient }
	| {
			readonly view: "detail";
			readonly patient: Patient;
			readonly consultations: PatientConsultationItem[];
	  }
	| { readonly view: "missing" };

/** /portal/clinician/patients/{new,$id,$id/edit} — patient record
 * surfaces mounted inside the portal shell (P-081). */
export function ClinicianPatientRecordPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const navigate = useNavigate();
	const d = (data ?? { view: "missing" }) as ClinicianPatientRecordData;
	const onSaved = (id: number) => void navigate({ to: `${BASE}/patients/${id}` });

	switch (d.view) {
		case "new":
			return (
				<PatientFormPage
					api={newPatientApi}
					onSaved={onSaved}
					locale={ctx.locale}
					portalBase={BASE}
				/>
			);
		case "edit":
			return (
				<PatientFormPage
					patient={d.patient}
					api={editPatientApi(d.patient.id)}
					onSaved={onSaved}
					locale={ctx.locale}
					portalBase={BASE}
				/>
			);
		case "detail":
			return (
				<PatientDetailPage
					patient={d.patient}
					consultations={d.consultations}
					locale={ctx.locale}
					deleteApi={patientDeleteApi}
					onDeleted={() => void navigate({ to: `${BASE}/patients` })}
					portalBase={BASE}
				/>
			);
		default:
			return null;
	}
}
