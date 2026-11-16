import { useEffect, useMemo, useState } from "react";
import { notFound, redirect, getRouteApi } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";

import { PortalConsultationPage } from "../views/index.ts";
import { portalMessages } from "../i18n.ts";
import { localeFn, portalConsultationFn } from "../fns.ts";
import { decryptPortalConsultation, isEnvelope, portalZkApi, registerPortalDevice } from "../zk.ts";

// One consultation in the patient portal, read-only. Anonymous visitors
// go to the patient sign-in page; a consultation the signed-in person
// holds no active link to is a plain 404, like one that does not exist.
export const Route = createPluginFileRoute("patient-portal.routes")("/portal/consultations/$id")({
	loader: async ({ params }) => {
		const [result, locale] = await Promise.all([
			portalConsultationFn({ data: Number(params.id) }),
			localeFn(),
		]);
		if (result.status === "anonymous") throw redirect({ to: "/portal/login" });
		if (result.status === "missing") throw notFound();
		return { consultation: result.consultation, locale };
	},
	component: function PortalConsultationRoute() {
		const { consultation, locale } = Route.useLoaderData();
		const { i18n } = getRouteApi("__root__").useLoaderData();
		const t = portalMessages(locale);
		// T-148: the device keypair is only worth generating when the
		// row actually arrived ciphered — plaintext portals never touch
		// Web Crypto.
		const ciphered = isEnvelope(consultation.anamnesis) || isEnvelope(consultation.patientName);
		const keyring = useMemo(() => (ciphered ? makeKeyring() : null), [ciphered]);
		const [resolved, setResolved] = useState(consultation);
		useEffect(() => {
			setResolved(consultation);
			if (!keyring) return;
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
		return (
			<PortalConsultationPage
				consultation={{
					...resolved,
					patientName: isEnvelope(resolved.patientName) ? t.zk.lockedRecord : resolved.patientName,
				}}
				locked={isEnvelope(resolved.anamnesis)}
				i18n={i18n}
				locale={locale}
			/>
		);
	},
});
