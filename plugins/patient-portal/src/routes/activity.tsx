import { redirect } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

import { PortalActivityPage } from "../views/index.ts";
import { localeFn, patientActivityFn, portalFn } from "../fns.ts";

// Patient-facing access log (P-086): audit entries naming the record
// currently open in the portal. Anonymous visitors go to the patient
// sign-in page; with no record open the page renders empty — the fn
// fails closed on its own, so a denied read looks the same.
export const Route = createPluginFileRoute("patient-portal.routes")("/portal/activity")({
	loader: async () => {
		const [portal, locale] = await Promise.all([portalFn(), localeFn()]);
		if (!portal) throw redirect({ to: "/portal/login" });
		const patientId = portal.profile?.patientId ?? null;
		const activity =
			patientId === null
				? { entries: [], total: 0, limit: 100 }
				: await patientActivityFn({ data: { patientId } });
		return { activity, locale };
	},
	component: function PortalActivityRoute() {
		const { activity, locale } = Route.useLoaderData();
		return <PortalActivityPage data={activity} locale={locale} />;
	},
});
