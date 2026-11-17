import { useEffect, useMemo, useState } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";

import { makeKeyring } from "@ktb/crypto/keyring";
import { sliceMessages } from "@ktb/i18n";
import type { PageContext } from "@ktb/kernel";
import { decryptPatients, isCipheredPatient } from "@ktb/patients/zk";
import { vaultStateFn } from "@ktb/vault/fns";

import { approvePatientLinkFn, invitePatientFn, revokePatientLinkFn } from "../fns.ts";
import { patientAccessMessages, I18N_NAMESPACE } from "../i18n.ts";
import { grantPortalAccess, patientAccessZkApi } from "../zk.ts";
import {
	PatientAccessPage,
	type PatientAccessApi,
	type PatientLinkItem,
} from "./PatientAccessPage.tsx";

/** Loader payload for <instance>/patient-access/* — the wildcard page
 * resolves the patient id server-side and tags the result so the
 * component renders either the record or nothing. */
type PatientAccessPortalData =
	| {
			readonly view: "detail";
			readonly patient: { readonly id: number; readonly name: string };
			readonly links: readonly PatientLinkItem[];
	  }
	| { readonly view: "missing" };

/** /portal/<instance>/patient-access/<id> — the access surface inside
 * the portal shell (P-081). Server actions stay on this plugin's fns,
 * which run as the acting doctor like the loaders do. On a ZK tenant
 * the record name arrives as an envelope — this device decrypts it
 * when it holds the patient DEK and runs the T-148 grant pass that
 * wraps record DEKs to the portal devices of the active links, same
 * as the retired /patient-access/$patientId route did. */
export function PatientAccessPortalPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const router = useRouter();
	// The instance this page renders under — "/portal/doctor/…" →
	// "/portal/doctor" — so the back link stays inside the portal shell.
	const base = `/portal/${useLocation({ select: (l) => l.pathname.split("/")[2] ?? "" })}`;
	const d = (data ?? { view: "missing" }) as PatientAccessPortalData;
	const patient = d.view === "detail" ? d.patient : null;
	// Hoisted above the early return so the missing-record render
	// still evaluates the empty-links branch.
	const links = d.view === "detail" ? d.links : [];
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, patientAccessMessages(ctx.locale));
	const [zk, setZk] = useState(false);
	useEffect(() => {
		let live = true;
		vaultStateFn()
			.then((vault) => {
				if (live) setZk(vault.zk);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	// The keyring is only worth generating on a ZK tenant — plaintext
	// deployments never touch Web Crypto.
	const keyring = useMemo(() => (zk && patient !== null ? makeKeyring() : null), [zk, patient]);
	// The record name is an envelope under ZK — decrypted once the
	// keyring is up; the raw envelope never reaches the title.
	const [patientName, setPatientName] = useState(() =>
		patient !== null && isCipheredPatient(patient) ? t.zk.lockedRecord : (patient?.name ?? ""),
	);
	useEffect(() => {
		if (patient === null) return;
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
	if (patient === null) return null;
	const api: PatientAccessApi = {
		invite: (input) => invitePatientFn({ data: { patientId: patient.id, ...input } }),
		approve: (id) => approvePatientLinkFn({ data: id }),
		revoke: (id) => revokePatientLinkFn({ data: id }),
	};
	return (
		<PatientAccessPage
			patient={{ ...patient, name: patientName }}
			links={links}
			i18n={ctx.i18n}
			locale={ctx.locale}
			api={api}
			onChanged={() => void router.invalidate()}
			portalBase={base}
		/>
	);
}
