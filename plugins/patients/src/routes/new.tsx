import { useMemo } from "react";
import { useNavigate, getRouteApi } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";
import { vaultStateFn } from "@ktb/vault/fns";

import { PatientFormPage } from "../views/index.ts";
import { localeFn } from "../fns.ts";
import { newPatientApi, patientsZkApi } from "../apis.ts";
import { requireDoctor } from "../guard.ts";

export const Route = createPluginFileRoute("patients.routes")("/patients/new")({
	beforeLoad: () => requireDoctor(),
	loader: async () => {
		const [locale, vault] = await Promise.all([localeFn(), vaultStateFn()]);
		return { locale, zk: vault.zk };
	},
	component: function NewPatientRoute() {
		const { locale, zk } = Route.useLoaderData();
		const navigate = useNavigate();
		const { i18n } = getRouteApi("__root__").useLoaderData();
		// T-144: creates encrypt + grant the record DEK client-side.
		const keyring = useMemo(() => (zk ? makeKeyring() : null), [zk]);
		return (
			<PatientFormPage
				api={newPatientApi}
				i18n={i18n}
				locale={locale}
				onSaved={(id) => navigate({ to: "/patients/$id", params: { id: String(id) } })}
				zk={zk && keyring ? { keyring, api: patientsZkApi } : undefined}
			/>
		);
	},
});
