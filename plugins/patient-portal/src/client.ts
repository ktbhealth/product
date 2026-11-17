import { HouseIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { PatientPortalActivityPage } from "./views/PatientPortalActivityPage.tsx";
import { PatientPortalConsultationPage } from "./views/PatientPortalConsultationPage.tsx";
import { PatientPortalHomePage } from "./views/PatientPortalHomePage.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Services and routes degrade to
 * markers; ids are literals so the server graph never reaches the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	// Mirrors patientPortalServicesPlugin.optionalDeps (server index.ts).
	definePlugin({
		id: "patient-portal.services",
		meta: { keywords: ["patient-portal", "services", "patient"] },
		requiredDeps: [
			"patient-access.services",
			"consultations.services",
			"doctors.services",
			"patients.services",
		],
		optionalDeps: ["audit.services"],
	}),
	definePlugin({
		id: "patient-portal.portal",
		meta: { keywords: ["patient-portal", "shell", "patient"] },
		requiredDeps: ["portal.shell"],
		portals: [
			{
				id: "patient",
				basePath: "/portal/patient",
				label: "Patient",
				audience: "patient",
			},
		],
	}),
	definePlugin({
		id: "patient-portal.pages",
		meta: { keywords: ["patient-portal", "ui", "patient"] },
		requiredDeps: ["patient-portal.services"],
		pages: [
			{
				id: "patient-portal.home",
				path: "/portal/patient",
				component: PatientPortalHomePage,
			},
			{
				id: "patient-portal.consultation",
				path: "/portal/patient/consultations/*",
				component: PatientPortalConsultationPage,
			},
			{
				id: "patient-portal.activity",
				path: "/portal/patient/activity",
				component: PatientPortalActivityPage,
			},
		],
	}),
	definePlugin({
		id: "patient-portal.chrome",
		meta: { keywords: ["patient-portal", "ui", "patient"] },
		requiredDeps: ["patient-portal.portal"],
		chrome: [
			{
				id: "patient-portal.nav.home",
				region: "portal.sidebar",
				portal: "patient",
				content: {
					kind: "sidebarItem",
					item: { to: "/portal/patient", label: "Home", icon: HouseIcon, exact: true },
				},
			},
		],
	}),
	definePlugin({
		id: "patient-portal.routes",
		meta: { keywords: ["patient-portal", "routes", "patient"] },
	}),
];
