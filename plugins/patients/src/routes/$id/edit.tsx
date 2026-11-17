import { useMemo } from "react";
import { notFound, useNavigate, getRouteApi } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";
import { vaultStateFn } from "@ktb/vault/fns";

import { PatientFormPage } from "../../views/index.ts";
import { getPatientFn, localeFn } from "../../fns.ts";
import { editPatientApi, patientsZkApi } from "../../apis.ts";
import { requireDoctor } from "../../guard.ts";

export const Route = createPluginFileRoute("patients.routes")("/patients/$id/edit")({
	beforeLoad: () => requireDoctor(),
	loader: async ({ params }) => {
		const id = Number(params.id);
		// Same NaN guard as the detail route — bad ids are a 404, not a 500.
		if (!Number.isInteger(id) || id <= 0) throw notFound();
		const [patient, locale, vault] = await Promise.all([
			getPatientFn({ data: id }),
			localeFn(),
			vaultStateFn(),
		]);
		if (!patient) throw notFound();
		return { patient, locale, zk: vault.zk };
	},
	component: function EditPatientRoute() {
		const { patient, locale, zk } = Route.useLoaderData();
		const { i18n } = getRouteApi("__root__").useLoaderData();
		const navigate = useNavigate();
		// T-144: ciphered rows decrypt in the browser via the keyring.
		const keyring = useMemo(() => (zk ? makeKeyring() : null), [zk]);
		return (
			<PatientFormPage
				patient={patient}
				api={editPatientApi(patient.id)}
				i18n={i18n}
				locale={locale}
				onSaved={(id) => navigate({ to: "/patients/$id", params: { id: String(id) } })}
				zk={zk && keyring ? { keyring, api: patientsZkApi } : undefined}
			/>
		);
	},
});
