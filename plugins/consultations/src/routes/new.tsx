import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";
import { vaultStateFn } from "@ktb/vault/fns";
import { decryptPatients, isCipheredPatient } from "@ktb/patients/zk";
import type { AnamnesisExtractor } from "@ktb/anamnesis";
import { makeByokExtractor } from "@ktb/anamnesis-llm/byok";
import { webSpeechBackend } from "@ktb/transcription-webspeech";

import { NewConsultationPage } from "../views/index.ts";
import { resolveByokExtractor } from "../byok.ts";
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
		const { i18n } = getRouteApi("__root__").useLoaderData();
		const { patientId } = Route.useSearch();
		const keyring = useMemo(() => (zk ? makeKeyring() : null), [zk]);
		// Only warm the Whisper model when Whisper actually won resolution —
		// on the Web Speech fallback (and always under ZK) there is no
		// model to prefetch.
		useEffect(() => {
			if (prefersWhisper && !zk) prefetchWhisperModel();
		}, [zk]);
		// T-146: resolve the clinic BYOK extractor for this device once —
		// no provider key sealed → the seam stays on the heuristic.
		const [extractor, setExtractor] = useState<AnamnesisExtractor | null>(null);
		useEffect(() => {
			if (!zk || !keyring) return;
			let live = true;
			resolveByokExtractor(keyring, makeByokExtractor)
				.then((resolved) => {
					if (live) setExtractor(resolved);
				})
				.catch(() => {});
			return () => {
				live = false;
			};
		}, [zk, keyring]);
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
				// T-146: ZK tenants use the browser's Web Speech path only —
				// no model download, and no Whisper-in-browser pipeline at
				// all (the server transcription endpoints are gated too).
				backend={zk ? webSpeechBackend : transcriptionBackend}
				i18n={i18n}
				locale={locale}
				zk={
					zk && keyring
						? { keyring, api: consultationsZkApi, extractor: extractor ?? undefined }
						: undefined
				}
			/>
		);
	},
});
