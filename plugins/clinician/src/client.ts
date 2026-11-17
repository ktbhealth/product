import { ActivityIcon, ClipboardListIcon, HouseIcon, UsersIcon } from "lucide-react";

import { AuditActivityPage } from "@ktb/audit/activity-page";
import { definePlugin, type ChromeContribution, type Page, type Plugin } from "@ktb/kernel";

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
const CLINICAL_INSTANCES = [
	{ id: "doctor", label: "Doctor", audience: "doctor" },
	{ id: "secretary", label: "Secretary", audience: "secretary" },
] as const;

type ClinicalInstanceId = (typeof CLINICAL_INSTANCES)[number]["id"];

const instanceBase = (id: ClinicalInstanceId) => `/portal/${id}`;

const clinicalPages = (instance: ClinicalInstanceId): Page[] => {
	const base = instanceBase(instance);
	return [
		{ id: `clinician.${instance}.home`, path: base, component: ClinicianHomePage },
		{
			id: `clinician.${instance}.patients`,
			path: `${base}/patients`,
			component: ClinicianPatientsPage,
		},
		{
			id: `clinician.${instance}.consultations`,
			path: `${base}/consultations`,
			component: ClinicianConsultationsPage,
		},
		{
			id: `clinician.${instance}.patients.record`,
			path: `${base}/patients/*`,
			component: ClinicianPatientRecordPage,
		},
		{
			id: `clinician.${instance}.consultations.record`,
			path: `${base}/consultations/*`,
			component: ClinicianConsultationRecordPage,
		},
		{
			id: `clinician.${instance}.activity`,
			path: `${base}/activity`,
			component: AuditActivityPage,
		},
	];
};

const sidebarChrome = (instance: ClinicalInstanceId): ChromeContribution[] => {
	const base = instanceBase(instance);
	return [
		{
			id: `clinician.${instance}.nav.home`,
			region: "portal.sidebar",
			portal: instance,
			content: {
				kind: "sidebarItem",
				item: { to: base, label: "Home", icon: HouseIcon, exact: true },
			},
		},
		{
			id: `clinician.${instance}.nav.patients`,
			region: "portal.sidebar",
			portal: instance,
			content: {
				kind: "sidebarItem",
				item: {
					to: `${base}/patients`,
					label: "Patients",
					icon: UsersIcon,
					group: "Care",
				},
			},
		},
		{
			id: `clinician.${instance}.nav.consultations`,
			region: "portal.sidebar",
			portal: instance,
			content: {
				kind: "sidebarItem",
				item: {
					to: `${base}/consultations`,
					label: "Consultations",
					icon: ClipboardListIcon,
					group: "Care",
				},
			},
		},
		{
			id: `clinician.${instance}.activity.sidebar`,
			region: "portal.sidebar",
			portal: instance,
			content: {
				kind: "sidebarItem",
				item: {
					to: `${base}/activity`,
					label: "Activity",
					icon: ActivityIcon,
					group: "Governance",
				},
			},
		},
	];
};

export const clinicianPortalPlugin = definePlugin({
	id: "clinician.portal",
	meta: { keywords: ["clinician", "shell", "doctor"] },
	requiredDeps: ["portal.shell"],
	portals: CLINICAL_INSTANCES.map((instance) => ({
		id: instance.id,
		basePath: instanceBase(instance.id),
		label: instance.label,
		audience: instance.audience,
		subject: "doctor" as const,
	})),
});

export const clinicianPagesPlugin = definePlugin({
	id: "clinician.pages",
	meta: { keywords: ["clinician", "ui", "doctor"] },
	requiredDeps: ["patients.services", "consultations.services"],
	// Mirrors clinicianPagesPlugin.optionalDeps (server index.ts).
	optionalDeps: ["audit.services"],
	pages: [...clinicalPages("doctor"), ...clinicalPages("secretary")],
});

export const clinicianChromePlugin = definePlugin({
	id: "clinician.chrome",
	meta: { keywords: ["clinician", "ui", "doctor"] },
	requiredDeps: ["clinician.portal"],
	chrome: [...sidebarChrome("doctor"), ...sidebarChrome("secretary")],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	clinicianPortalPlugin,
	clinicianPagesPlugin,
	clinicianChromePlugin,
];
