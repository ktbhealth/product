import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";
import { vaultStateFn } from "@ktb/vault/fns";

import { ConsultationsPage } from "../views/index.ts";
import { prefersWhisper } from "../backend.ts";
import { listConsultationsFn, localeFn } from "../fns.ts";
import { requireDoctor } from "../guard.ts";
import { prefetchWhisperModel } from "../whisper-prefetch.ts";
import { consultationsZkApi } from "../apis.ts";

export const Route = createPluginFileRoute("consultations.routes")("/consultations/")({
	staleTime: 30_000,
	beforeLoad: () => requireDoctor(),
	loader: async () => {
		const [consultations, locale, vault] = await Promise.all([
			listConsultationsFn(),
			localeFn(),
			vaultStateFn(),
		]);
		return { consultations, locale, zk: vault.zk };
	},
	component: function ConsultationsRoute() {
		const { consultations, locale, zk } = Route.useLoaderData();
		const { i18n } = getRouteApi("__root__").useLoaderData();
		useEffect(() => {
			if (prefersWhisper) prefetchWhisperModel();
		}, []);
		// T-145: rows arrive ciphered on ZK tenants — the view decrypts
		// in the browser through this device's keyring.
		const keyring = useMemo(() => (zk ? makeKeyring() : null), [zk]);
		return (
			<ConsultationsPage
				consultations={consultations}
				i18n={i18n}
				locale={locale}
				zk={zk && keyring ? { keyring, api: consultationsZkApi } : undefined}
			/>
		);
	},
});
