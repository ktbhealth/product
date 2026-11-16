import { ActivityIcon, ClipboardListIcon, HouseIcon, UsersIcon } from "lucide-react";

import { AuditActivityPage } from "@ktb/audit/activity-page";
import { definePlugin, type Plugin } from "@ktb/kernel";

import { ClinicianConsultationRecordPage } from "./views/ClinicianConsultationRecordPage.tsx";
import { ClinicianConsultationsPage } from "./views/ClinicianConsultationsPage.tsx";
import { ClinicianHomePage } from "./views/ClinicianHomePage.tsx";
import { ClinicianPatientRecordPage } from "./views/ClinicianPatientRecordPage.tsx";
import { ClinicianPatientsPage } from "./views/ClinicianPatientsPage.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Server entries keep their ids and
 * dep edges so topo order matches; `pages` keep id/path/component only
 * — loader Effects stay server-side in ./index.ts. Dep ids are
 * literals: importing ./index.ts would pull the server graph into the
 * client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const clinicianPortalPlugin = definePlugin({
	id: "clinician.portal",
	meta: { keywords: ["clinician", "shell", "doctor"] },
	requiredDeps: ["portal.shell"],
	portals: [
		{
			id: "clinician",
			basePath: "/portal/clinician",
			label: "Clinician",
			audience: "clinician",
			subject: "doctor",
		},
	],
});

export const clinicianPagesPlugin = definePlugin({
	id: "clinician.pages",
	meta: { keywords: ["clinician", "ui", "doctor"] },
	requiredDeps: ["patients.services", "consultations.services"],
	// Mirrors clinicianPagesPlugin.optionalDeps (server index.ts).
	optionalDeps: ["audit.services"],
	pages: [
		{ id: "clinician.home", path: "/portal/clinician", component: ClinicianHomePage },
		{
			id: "clinician.patients",
			path: "/portal/clinician/patients",
			component: ClinicianPatientsPage,
		},
		{
			id: "clinician.consultations",
			path: "/portal/clinician/consultations",
			component: ClinicianConsultationsPage,
		},
		{
			id: "clinician.patients.record",
			path: "/portal/clinician/patients/*",
			component: ClinicianPatientRecordPage,
		},
		{
			id: "clinician.consultations.record",
			path: "/portal/clinician/consultations/*",
			component: ClinicianConsultationRecordPage,
		},
		{
			id: "clinician.activity",
			path: "/portal/clinician/activity",
			component: AuditActivityPage,
		},
	],
});

export const clinicianChromePlugin = definePlugin({
	id: "clinician.chrome",
	meta: { keywords: ["clinician", "ui", "doctor"] },
	requiredDeps: ["clinician.portal"],
	chrome: [
		{
			id: "clinician.nav.home",
			region: "portal.sidebar",
			portal: "clinician",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/portal/clinician",
					label: "Home",
					icon: HouseIcon,
					exact: true,
				},
			},
		},
		{
			id: "clinician.nav.patients",
			region: "portal.sidebar",
			portal: "clinician",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/portal/clinician/patients",
					label: "Patients",
					icon: UsersIcon,
					group: "Care",
				},
			},
		},
		{
			id: "clinician.nav.consultations",
			region: "portal.sidebar",
			portal: "clinician",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/portal/clinician/consultations",
					label: "Consultations",
					icon: ClipboardListIcon,
					group: "Care",
				},
			},
		},
		{
			id: "clinician.activity.sidebar",
			region: "portal.sidebar",
			portal: "clinician",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/portal/clinician/activity",
					label: "Activity",
					icon: ActivityIcon,
					group: "Governance",
				},
			},
		},
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	clinicianPortalPlugin,
	clinicianPagesPlugin,
	clinicianChromePlugin,
];
