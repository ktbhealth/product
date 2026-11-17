import { ArrowLeftRightIcon } from "lucide-react";

import { definePlugin, type ChromeContribution, type Page, type Plugin } from "@ktb/kernel";

import { DoctorSelectPortalPage } from "./views/DoctorSelectPortalPage.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Server entries keep their ids and
 * dep edges so topo order matches; `chrome` is client-consumed and
 * `pages` keep id/path/component only — loader Effects stay
 * server-side in ./index.ts. Tables, services and routes degrade to
 * markers; ids are literals so the server graph never reaches the
 * client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
const CLINICAL_PORTALS = ["doctor", "secretary"] as const;

const switchDoctorChrome = (portal: (typeof CLINICAL_PORTALS)[number]): ChromeContribution => ({
	id: `doctors.nav.switch.${portal}`,
	region: "portal.sidebar",
	portal,
	// Only meaningful when the account acts through more than one
	// profile — an owner without delegations has nothing to switch to.
	when: { minDoctorProfiles: 2 },
	content: {
		kind: "sidebarItem",
		item: {
			to: `/portal/${portal}/switch-doctor`,
			label: "Switch doctor",
			icon: ArrowLeftRightIcon,
			group: "Account",
		},
	},
});

export const plugins: readonly Plugin[] = [
	definePlugin({ id: "doctors.tables", meta: { keywords: ["doctors", "tables"] } }),
	definePlugin({ id: "doctors.services", meta: { keywords: ["doctors", "services"] } }),
	definePlugin({ id: "doctors.routes", meta: { keywords: ["doctors", "routes"] } }),
	definePlugin({
		id: "doctors.pages",
		meta: { keywords: ["doctors", "ui", "doctor"] },
		requiredDeps: ["portal.shell"],
		pages: CLINICAL_PORTALS.map((portal): Page => ({
			id: `doctors.${portal}.select`,
			path: `/portal/${portal}/switch-doctor`,
			component: DoctorSelectPortalPage,
		})),
	}),
	definePlugin({
		id: "doctors.chrome",
		meta: { keywords: ["doctors", "ui", "doctor"] },
		requiredDeps: ["portal.shell"],
		chrome: CLINICAL_PORTALS.map(switchDoctorChrome),
	}),
];
