import { useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { makeKeyring } from "@ktb/crypto/keyring";
import type { PageContext } from "@ktb/kernel";

import { sliceMessages } from "@ktb/i18n";

import type { PortalConsultationSummary } from "../index.ts";
import { selectPatientFn } from "../fns.ts";
import { portalMessages, I18N_NAMESPACE } from "../i18n.ts";
import {
	decryptPortalProfiles,
	decryptPortalSummaries,
	isEnvelope,
	portalZkApi,
	registerPortalDevice,
} from "../zk.ts";
import {
	PortalPage,
	type PortalApi,
	type PortalConsultationItem,
	type PortalProfileItem,
	type PortalRecord,
} from "./PortalPage.tsx";

/** What the home page's loader returns — the session user's portal
 * state, or "missing" when the request lost its session between the
 * audience gate and the loader (a revoked link collapses to an empty
 * portal, never an error). Consultation rows keep their raw `anamnesis`
 * column so the client-side ZK pass can derive the complaint (T-148). */
export type PatientPortalHomeData =
	| { readonly view: "missing" }
	| {
			readonly view: "home";
			readonly user: { readonly name: string | null; readonly email: string };
			readonly awaitingInvites: number;
			readonly profiles: readonly PortalProfileItem[];
			readonly profile: PortalRecord | null;
			readonly consultations: readonly PortalConsultationSummary[];
	  };

const api: PortalApi = {
	select: (patientId) => selectPatientFn({ data: patientId }),
};

/** Patient portal home as a portal-instance page: maps the loader data
 * and the host-injected locale onto the read-only PortalPage, wiring
 * the profile switcher to the selection server fn. ZK rows arrive as
 * envelopes — the device keyring unwraps what this device was granted
 * and anything still ciphered renders the locked label, exactly like
 * the retired /portal route did. */
export function PatientPortalHomePage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const router = useRouter();
	const home = data as PatientPortalHomeData | null;
	const ready = home?.view === "home" ? home : null;
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, portalMessages(ctx.locale));
	// T-148: the portal device keyring lives in this browser — one
	// keyring for registration and every decrypt below.
	const keyring = useMemo(() => makeKeyring(), []);
	const profiles = ready?.profiles;
	const profile = ready?.profile ?? null;
	const consultations = ready?.consultations;
	// Resolved rows: names/consultations after the client-side
	// decrypt pass — null until a ZK pass lands (non-ZK portals
	// render the loader data untouched).
	const [resolved, setResolved] = useState<{
		profiles: readonly PortalProfileItem[];
		profile: PortalRecord | null;
		consultations: readonly PortalConsultationItem[];
	} | null>(null);
	useEffect(() => {
		if (profiles === undefined || consultations === undefined) return;
		let live = true;
		void registerPortalDevice(keyring);
		const decryptable =
			profiles.some((p) => isEnvelope(p.name)) ||
			(profile !== null && isEnvelope(profile.name)) ||
			consultations.some((c) => isEnvelope(c.anamnesis));
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
	if (ready === null || profiles === undefined || consultations === undefined) return null;
	// Locked names never render a raw envelope — a record the clinic
	// has not shared with this device gets the locked label.
	const locked = t.zk.lockedRecord;
	const named = <R extends { readonly name: string }>(row: R): R =>
		isEnvelope(row.name) ? { ...row, name: locked } : row;
	return (
		<PortalPage
			user={ready.user}
			awaitingInvites={ready.awaitingInvites}
			profiles={(resolved?.profiles ?? profiles).map(named)}
			profile={
				(resolved?.profile ?? profile) === null ? null : named((resolved?.profile ?? profile)!)
			}
			consultations={resolved?.consultations ?? consultations}
			i18n={ctx.i18n}
			locale={ctx.locale}
			api={api}
			onChanged={() => void router.invalidate()}
		/>
	);
}
