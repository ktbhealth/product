import { redirect, useRouter, getRouteApi } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

import { PortalPage, type PortalApi } from "../views/index.ts";
import { localeFn, portalFn, selectPatientFn } from "../fns.ts";

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
		return (
			<PortalPage
				user={user}
				awaitingInvites={awaitingInvites}
				profiles={profiles}
				profile={profile}
				consultations={consultations}
				i18n={i18n}
				locale={locale}
				api={api}
				onChanged={() => void router.invalidate()}
			/>
		);
	},
});
