import { definePlugin, type Plugin } from "@ktb/kernel";

import { PatientAccessPortalPage } from "./views/PatientAccessPortalPage.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Tables, services and routes degrade to markers; ids are
 * literals so the server graph never reaches the client bundle. Keep
 * in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "patient-access.tables",
		meta: { keywords: ["patient-access", "tables", "patient"] },
	}),
	definePlugin({
		id: "patient-access.services",
		meta: { keywords: ["patient-access", "services", "patient"] },
		// Mirrors patientAccessServicesPlugin.optionalDeps (server index.ts).
		optionalDeps: ["invites.services", "patients.services", "vault.services"],
	}),
	definePlugin({
		id: "patient-access.routes",
		meta: { keywords: ["patient-access", "routes", "patient"] },
	}),
	definePlugin({
		id: "patient-access.pages",
		meta: { keywords: ["patient-access", "ui", "patient"] },
		requiredDeps: ["patient-access.services"],
		pages: [
			{
				id: "patient-access.doctor.record",
				path: "/portal/doctor/patient-access/*",
				component: PatientAccessPortalPage,
			},
			{
				id: "patient-access.secretary.record",
				path: "/portal/secretary/patient-access/*",
				component: PatientAccessPortalPage,
			},
		],
	}),
];
