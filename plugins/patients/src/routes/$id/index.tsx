import { useMemo } from "react";
import { notFound, useNavigate, getRouteApi } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";
import { vaultStateFn } from "@ktb/vault/fns";

import { PatientDetailPage } from "../../views/index.ts";
import { getPatientFn, localeFn, patientConsultationsFn } from "../../fns.ts";
import { requireDoctor } from "../../guard.ts";
import { patientDeleteApi, patientsZkApi } from "../../apis.ts";

export const Route = createPluginFileRoute("patients.routes")("/patients/$id/")({
	staleTime: 30_000,
	beforeLoad: () => requireDoctor(),
	loader: async ({ params }) => {
		const id = Number(params.id);
		// Non-numeric params (e.g. /patients/abc) would reach the fns as
		// NaN and surface as a 500 — treat them as a missing page instead.
		if (!Number.isInteger(id) || id <= 0) throw notFound();
		const [patient, consultations, locale, vault] = await Promise.all([
			getPatientFn({ data: id }),
			patientConsultationsFn({ data: id }),
			localeFn(),
			vaultStateFn(),
		]);
		if (!patient) throw notFound();
		return { patient, consultations, locale, zk: vault.zk };
	},
	component: function PatientRoute() {
		const { patient, consultations, locale, zk } = Route.useLoaderData();
		const { i18n } = getRouteApi("__root__").useLoaderData();
		const navigate = useNavigate();
		// T-144: ciphered rows decrypt in the browser via the keyring.
		const keyring = useMemo(() => (zk ? makeKeyring() : null), [zk]);
		return (
			<PatientDetailPage
				patient={patient}
				consultations={consultations}
				i18n={i18n}
				locale={locale}
				deleteApi={patientDeleteApi}
				onDeleted={() => void navigate({ to: "/patients" })}
				zk={zk && keyring ? { keyring, api: patientsZkApi } : undefined}
			/>
		);
	},
});
