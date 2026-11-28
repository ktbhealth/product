import type { Plugin } from "@ktb/kernel";
import { plugins as agendaPlugins } from "@ktb/agenda";
import { plugins as aiProviderPlugins } from "@ktb/ai-provider";
import { plugins as apiPlugins } from "@ktb/api";
import { plugins as authPlugins } from "@ktb/auth-plugin";
import { plugins as consultationsPlugins } from "@ktb/consultations";
import { plugins as credentialsPlugins } from "@ktb/credentials";
import { plugins as doctorsPlugins } from "@ktb/doctors";
import { plugins as evalPersonaPlugins } from "@ktb/eval-persona";
import { plugins as evalValidatorPlugins } from "@ktb/eval-validator";
import { plugins as imagePlugins } from "@ktb/image";
import { plugins as invitesPlugins } from "@ktb/invites";
import { plugins as jobsPlugins } from "@ktb/jobs";
import { plugins as notificationsPlugins } from "@ktb/notifications";
import { plugins as patientAccessPlugins } from "@ktb/patient-access";
import { plugins as patientPortalPlugins } from "@ktb/patient-portal";
import { plugins as patientsPlugins } from "@ktb/patients";
import { plugins as platformPlugins } from "@ktb/platform";
import { plugins as secretariesPlugins } from "@ktb/secretaries";
import { plugins as themePlugins } from "@ktb/theme";

/**
 * Static plugin imports for route-tree composition. Route-tree generation
 * (@tanstack/router-generator via tsr.config.json → src/routes.ts) evaluates
 * this module under jiti, where `import.meta.glob` — the mechanism
 * @ktb/app-host uses for plugin discovery — is unavailable. Every plugin
 * package whose manifest contributes `routes` MUST appear here, or its
 * routes silently never mount; route-plugins.test.ts guards the set
 * against the server registry.
 *
 * Keep this file free of JSX/TSX-only constructs beyond what plugin entry
 * modules already pull in — jiti only parses it (with JITI_JSX=1, see
 * vite.config.ts), it never bundles it.
 */
export const routePluginEntries: ReadonlyArray<{
	readonly pkg: string;
	readonly plugins: readonly Plugin[];
}> = [
	{ pkg: "@ktb/agenda", plugins: agendaPlugins },
	{ pkg: "@ktb/ai-provider", plugins: aiProviderPlugins },
	{ pkg: "@ktb/api", plugins: apiPlugins },
	{ pkg: "@ktb/auth-plugin", plugins: authPlugins },
	{ pkg: "@ktb/consultations", plugins: consultationsPlugins },
	{ pkg: "@ktb/credentials", plugins: credentialsPlugins },
	{ pkg: "@ktb/doctors", plugins: doctorsPlugins },
	{ pkg: "@ktb/eval-persona", plugins: evalPersonaPlugins },
	{ pkg: "@ktb/eval-validator", plugins: evalValidatorPlugins },
	{ pkg: "@ktb/image", plugins: imagePlugins },
	{ pkg: "@ktb/invites", plugins: invitesPlugins },
	{ pkg: "@ktb/jobs", plugins: jobsPlugins },
	{ pkg: "@ktb/notifications", plugins: notificationsPlugins },
	{ pkg: "@ktb/patient-access", plugins: patientAccessPlugins },
	{ pkg: "@ktb/patient-portal", plugins: patientPortalPlugins },
	{ pkg: "@ktb/patients", plugins: patientsPlugins },
	{ pkg: "@ktb/platform", plugins: platformPlugins },
	{ pkg: "@ktb/secretaries", plugins: secretariesPlugins },
	{ pkg: "@ktb/theme", plugins: themePlugins },
];

/** Flattened plugin list spliced into the host route tree (src/routes.ts). */
export const routePlugins: readonly Plugin[] = routePluginEntries.flatMap((entry) => entry.plugins);
