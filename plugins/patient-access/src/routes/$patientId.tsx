import { useEffect, useMemo, useState } from "react";
import { notFound, redirect, useRouter, getRouteApi } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";
import { decryptPatients, isCipheredPatient } from "@ktb/patients/zk";
import { vaultStateFn } from "@ktb/vault/fns";

import { PatientAccessPage, type PatientAccessApi } from "../views/index.ts";
import { patientAccessMessages } from "../i18n.ts";
import { grantPortalAccess, patientAccessZkApi } from "../zk.ts";
import {
	approvePatientLinkFn,
	doctorAccessFn,
	invitePatientFn,
	localeFn,
	patientLinksFn,
	revokePatientLinkFn,
} from "../fns.ts";

// Portal access of one patient: who may open the record in the patient
// portal. Doctor-side page — anonymous visitors go to /login, accounts
// with no doctor profile to act as to the profile chooser; a patient
// that is not the acting doctor's is a plain 404.
export const Route = createPluginFileRoute("patient-access.routes")("/patient-access/$patientId")({
	beforeLoad: async () => {
		const access = await doctorAccessFn();
		if (access === "anonymous") throw redirect({ to: "/login" });
		if (access === "no-doctor") throw redirect({ to: "/doctors/select" });
	},
	loader: async ({ params }) => {
		const [data, locale, vault] = await Promise.all([
			patientLinksFn({ data: Number(params.patientId) }),
			localeFn(),
			vaultStateFn(),
		]);
		if (!data) throw notFound();
		return { ...data, locale, zk: vault.zk };
	},
	component: function PatientAccessRoute() {
		const { patient, links, locale, zk } = Route.useLoaderData();
		const { i18n } = getRouteApi("__root__").useLoaderData();
		const router = useRouter();
		const t = patientAccessMessages(locale);
		const keyring = useMemo(() => (zk ? makeKeyring() : null), [zk]);
		// The record name is an envelope under ZK — decrypted once the
		// keyring is up; the raw envelope never reaches the title.
		const [patientName, setPatientName] = useState(
			isCipheredPatient(patient) ? t.zk.lockedRecord : patient.name,
		);
		const api: PatientAccessApi = {
			invite: (input) => invitePatientFn({ data: { patientId: patient.id, ...input } }),
			approve: (id) => approvePatientLinkFn({ data: id }),
			revoke: (id) => revokePatientLinkFn({ data: id }),
		};
		useEffect(() => {
			setPatientName(isCipheredPatient(patient) ? t.zk.lockedRecord : patient.name);
			if (!zk || !keyring) return;
			let live = true;
			(async () => {
				// Title first: unwrap the patient DEK and decrypt the name.
				if (isCipheredPatient(patient)) {
					const [row] = await decryptPatients(keyring, patientAccessZkApi, [
						{ id: patient.id, name: patient.name },
					]);
					/* v8 ignore next -- decryptPatients preserves the row count */
					if (live && row !== undefined && !isCipheredPatient(row)) setPatientName(row.name);
				}
				// T-148 grant pass: wrap the record + ciphered consultation
				// DEKs to every registered portal device of the active
				// links. Best-effort — a device that cannot unwrap a record
				// simply leaves it for one that can.
				const plan = await patientAccessZkApi.portalReaders(patient.id);
				if (plan !== null) {
					await grantPortalAccess(keyring, patientAccessZkApi, {
						patientId: patient.id,
						consultationIds: plan.cipheredConsultationIds,
						readers: plan.readers,
					});
				}
			})().catch(() => {});
			return () => {
				live = false;
			};
		}, [zk, keyring, patient, t]);
		return (
			<PatientAccessPage
				patient={{ ...patient, name: patientName }}
				links={links}
				i18n={i18n}
				locale={locale}
				api={api}
				onChanged={() => void router.invalidate()}
			/>
		);
	},
});
