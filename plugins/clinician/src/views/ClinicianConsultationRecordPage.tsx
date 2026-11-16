import { useSearch } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import type { PageContext } from "@ktb/kernel";
import { consultationDetailApi, newConsultationApi } from "@ktb/consultations/apis";
import { transcriptionBackend } from "@ktb/consultations/backend";
import { ConsultationDetailPage, NewConsultationPage } from "@ktb/consultations/views";

/** The clinician portal instance base — every in-view link stays under
 * it so drill-down never drops the clinician back into the app shell. */
const BASE = "/portal/clinician";

type DetailProps = ComponentProps<typeof ConsultationDetailPage>;
type NewProps = ComponentProps<typeof NewConsultationPage>;

/** Loader payload for /portal/clinician/consultations/* — the wildcard
 * page resolves `new` and `<id>` subpaths server-side and tags the
 * result so the component picks the right domain view. */
type ClinicianConsultationRecordData =
	| { readonly view: "new"; readonly patients: NewProps["initialPatients"] }
	| {
			readonly view: "detail";
			readonly c: DetailProps["c"];
			readonly history: DetailProps["history"];
	  }
	| { readonly view: "missing" };

/** /portal/clinician/consultations/{new,$id} — consultation surfaces
 * mounted inside the portal shell (P-081). */
export function ClinicianConsultationRecordPage({
	data,
	ctx,
}: {
	data: unknown;
	ctx: PageContext;
}) {
	const d = (data ?? { view: "missing" }) as ClinicianConsultationRecordData;
	const search = useSearch({ strict: false }) as { patientId?: string | number };
	const rawPatientId = Number(search?.patientId);
	const initialPatientId =
		Number.isInteger(rawPatientId) && rawPatientId > 0 ? rawPatientId : undefined;

	switch (d.view) {
		case "new":
			return (
				<NewConsultationPage
					initialPatients={d.patients}
					initialPatientId={initialPatientId}
					api={newConsultationApi}
					backend={transcriptionBackend}
					locale={ctx.locale}
					portalBase={BASE}
				/>
			);
		case "detail":
			return (
				<ConsultationDetailPage
					c={d.c}
					history={d.history}
					api={consultationDetailApi}
					locale={ctx.locale}
					portalBase={BASE}
				/>
			);
		default:
			return null;
	}
}
