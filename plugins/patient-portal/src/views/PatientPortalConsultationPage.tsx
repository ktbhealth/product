import { useEffect, useMemo, useState } from "react";

import { makeKeyring } from "@ktb/crypto/keyring";
import { sliceMessages } from "@ktb/i18n";
import type { PageContext } from "@ktb/kernel";

import type { PortalConsultation } from "../index.ts";
import { portalMessages, I18N_NAMESPACE } from "../i18n.ts";
import { decryptPortalConsultation, isEnvelope, portalZkApi, registerPortalDevice } from "../zk.ts";
import { PortalConsultationPage } from "./PortalConsultationPage.tsx";

/** What the consultation page's loader returns — the record, or
 * "missing" when the link was revoked between guard and loader (the
 * guard already 404s anything the caller may not see). The record
 * keeps its raw `anamnesis` column so the client-side ZK pass can
 * decrypt it (T-148). */
export type PatientPortalConsultationData =
	| { readonly view: "missing" }
	| { readonly view: "detail"; readonly consultation: PortalConsultation };

/** One consultation in the patient portal as a portal-instance page —
 * read-only, mounted under /portal/patient/consultations/*. ZK rows
 * arrive as envelopes: the device keyring unwraps what this device was
 * granted; a record it cannot open renders the locked card, exactly
 * like the retired /portal/consultations/$id route did. */
export function PatientPortalConsultationPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const detail = data as PatientPortalConsultationData | null;
	const consultation = detail?.view === "detail" ? detail.consultation : null;
	// The device keypair is only worth generating when the row actually
	// arrived ciphered — plaintext portals never touch Web Crypto.
	const ciphered =
		consultation !== null &&
		(isEnvelope(consultation.anamnesis) || isEnvelope(consultation.patientName));
	const keyring = useMemo(() => (ciphered ? makeKeyring() : null), [ciphered]);
	const [resolved, setResolved] = useState(consultation);
	useEffect(() => {
		setResolved(consultation);
		if (!keyring || consultation === null) return;
		let live = true;
		// A consultation page may be the first portal surface the
		// patient opens — register the device here too.
		void registerPortalDevice(keyring);
		decryptPortalConsultation(keyring, portalZkApi, consultation)
			.then((row) => {
				if (live) setResolved(row);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [keyring, consultation]);
	if (detail?.view !== "detail" || resolved === null) return null;
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, portalMessages(ctx.locale));
	return (
		<PortalConsultationPage
			consultation={{
				...resolved,
				patientName: isEnvelope(resolved.patientName) ? t.zk.lockedRecord : resolved.patientName,
			}}
			locked={isEnvelope(resolved.anamnesis)}
			i18n={ctx.i18n}
			locale={ctx.locale}
		/>
	);
}
