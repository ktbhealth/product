import { useEffect, useMemo, useState } from "react";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";
import { vaultStateFn } from "@ktb/vault/fns";
import { decryptPatients, isCipheredPatient } from "@ktb/patients/zk";

import { NewConsultationPage } from "../views/index.ts";
import { prefersWhisper, transcriptionBackend } from "../backend.ts";
import {
	consultationsZkApi,
	newConsultationApi,
	newConsultationLoader,
	validateNewConsultationSearch,
} from "../apis.ts";
import { localeFn } from "../fns.ts";
import { requireDoctor } from "../guard.ts";
import { prefetchWhisperModel } from "../whisper-prefetch.ts";
import { consultationMessages } from "../i18n.ts";

export const Route = createPluginFileRoute("consultations.routes")("/consultations/new")({
	validateSearch: validateNewConsultationSearch,
	beforeLoad: () => requireDoctor(),
	loader: async () => {
		const [initialPatients, locale, vault] = await Promise.all([
			newConsultationLoader(),
			localeFn(),
			vaultStateFn(),
		]);
		return { initialPatients, locale, zk: vault.zk };
	},
	component: function NewRoute() {
		const { initialPatients, locale, zk } = Route.useLoaderData();
		const { patientId } = Route.useSearch();
		const keyring = useMemo(() => (zk ? makeKeyring() : null), [zk]);
		// Only warm the Whisper model when Whisper actually won resolution —
		// on the Web Speech fallback there is no model to prefetch.
		useEffect(() => {
			if (prefersWhisper) prefetchWhisperModel();
		}, []);
		// T-145: patient names arrive ciphered under ZK — decrypt them
		// for the picker; rows this device cannot read get the locked
		// label instead of a raw envelope.
		const [patients, setPatients] = useState(initialPatients);
		useEffect(() => {
			if (!zk || !keyring) return;
			let live = true;
			decryptPatients(keyring, consultationsZkApi, initialPatients)
				.then((rows) => {
					if (!live) return;
					const t = consultationMessages(locale);
					setPatients(
						rows.map((p) =>
							isCipheredPatient(p as { readonly name?: string | null })
								? { ...p, name: t.zk.lockedRecord }
								: p,
						),
					);
				})
				.catch(() => {});
			return () => {
				live = false;
			};
		}, [zk, keyring, initialPatients, locale]);
		return (
			<NewConsultationPage
				initialPatients={patients}
				initialPatientId={patientId}
				api={newConsultationApi}
				backend={transcriptionBackend}
				locale={locale}
				zk={zk && keyring ? { keyring, api: consultationsZkApi } : undefined}
			/>
		);
	},
});
