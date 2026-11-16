import { useEffect, useMemo, useState } from "react";
import { redirect, useRouter, getRouteApi } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";

import { PortalPage, type PortalApi } from "../views/index.ts";
import { portalMessages } from "../i18n.ts";
import { localeFn, portalFn, selectPatientFn } from "../fns.ts";
import {
	decryptPortalProfiles,
	decryptPortalSummaries,
	isEnvelope,
	portalZkApi,
	registerPortalDevice,
} from "../zk.ts";
import type { PortalConsultationSummary } from "../index.ts";

const api: PortalApi = {
	select: (patientId) => selectPatientFn({ data: patientId }),
};

// Patient portal home: the consultations of the signed-in person's own
// record and of the ones in their care (e.g. a parent's children),
// read-only. Anonymous visitors go to the patient sign-in page.
export const Route = createPluginFileRoute("patient-portal.routes")("/portal/")({
	loader: async () => {
		const [portal, locale] = await Promise.all([portalFn(), localeFn()]);
		if (!portal) throw redirect({ to: "/portal/login" });
		return { ...portal, locale };
	},
	component: function PortalRoute() {
		const { user, awaitingInvites, profiles, profile, consultations, locale } =
			Route.useLoaderData();
		const { i18n } = getRouteApi("__root__").useLoaderData();
		const router = useRouter();
		const t = portalMessages(locale);
		// T-148: the portal device keypair lives in this browser — one
		// keyring for registration and every decrypt below.
		const keyring = useMemo(() => makeKeyring(), []);
		// Resolved rows: names/consultations after the client-side
		// decrypt pass — null until a ZK pass lands (non-ZK portals
		// render the loader data untouched).
		const [resolved, setResolved] = useState<{
			profiles: typeof profiles;
			profile: typeof profile;
			consultations: PortalConsultationSummary[];
		} | null>(null);
		useEffect(() => {
			let live = true;
			void registerPortalDevice(keyring);
			const decryptable =
				profiles.some((p: { readonly name: string }) => isEnvelope(p.name)) ||
				(profile !== null && isEnvelope(profile.name)) ||
				consultations.some((c: PortalConsultationSummary) => isEnvelope(c.anamnesis));
			if (!decryptable) return;
			(async () => {
				const [dProfiles, dProfile, dConsultations] = await Promise.all([
					decryptPortalProfiles(keyring, portalZkApi, profiles),
					profile === null
						? Promise.resolve(null)
						: decryptPortalProfiles(keyring, portalZkApi, [profile]).then(
								/* v8 ignore next -- decryptPortalProfiles preserves the row count */
								(rows) => rows[0] ?? profile,
							),
					decryptPortalSummaries(keyring, portalZkApi, consultations),
				]);
				if (live)
					setResolved({
						profiles: dProfiles,
						profile: dProfile,
						consultations: dConsultations,
					});
			})().catch(() => {});
			return () => {
				live = false;
			};
		}, [keyring, profiles, profile, consultations]);
		// Locked names never render a raw envelope — a record the clinic
		// has not shared with this device gets the locked label.
		const locked = t.zk.lockedRecord;
		const named = <R extends { readonly name: string }>(row: R): R =>
			isEnvelope(row.name) ? { ...row, name: locked } : row;
		return (
			<PortalPage
				user={user}
				awaitingInvites={awaitingInvites}
				profiles={(resolved?.profiles ?? profiles).map(named)}
				profile={
					(resolved?.profile ?? profile) === null ? null : named((resolved?.profile ?? profile)!)
				}
				consultations={resolved?.consultations ?? consultations}
				i18n={i18n}
				locale={locale}
				api={api}
				onChanged={() => void router.invalidate()}
			/>
		);
	},
});
