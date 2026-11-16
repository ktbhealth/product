import { useMemo } from "react";
import { useRouter, getRouteApi } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";
import { vaultStateFn } from "@ktb/vault/fns";

import { PatientsPage } from "../views/index.ts";
import { localeFn, listPatientsFn } from "../fns.ts";
import { requireDoctor } from "../guard.ts";
import { patientDeleteApi, patientsZkApi } from "../apis.ts";

export const Route = createPluginFileRoute("patients.routes")("/patients/")({
	beforeLoad: () => requireDoctor(),
	loader: async () => {
		const [patients, locale, vault] = await Promise.all([
			listPatientsFn(),
			localeFn(),
			vaultStateFn(),
		]);
		return { patients, locale, zk: vault.zk };
	},
	component: function PatientsRoute() {
		const { patients, locale, zk } = Route.useLoaderData();
		const { i18n } = getRouteApi("__root__").useLoaderData();
		const router = useRouter();
		// T-144: rows arrive ciphered on ZK tenants — the view decrypts
		// in the browser through this device's keyring.
		const keyring = useMemo(() => (zk ? makeKeyring() : null), [zk]);
		return (
			<PatientsPage
				patients={patients}
				i18n={i18n}
				locale={locale}
				deleteApi={patientDeleteApi}
				onDeleted={() => void router.invalidate()}
				zk={zk && keyring ? { keyring, api: patientsZkApi } : undefined}
			/>
		);
	},
});
