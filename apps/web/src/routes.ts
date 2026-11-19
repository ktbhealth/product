import { plugins as aiProviderPlugins } from "@ktb/ai-provider";
import { plugins as apiPlugins } from "@ktb/api";
import { plugins as authPlugins } from "@ktb/auth-plugin";
import { plugins as consultationsPlugins } from "@ktb/consultations";
import { plugins as credentialsPlugins } from "@ktb/credentials";
import { plugins as doctorsPlugins } from "@ktb/doctors";
import { plugins as evalPersonaPlugins } from "@ktb/eval-persona";
import { plugins as evalValidatorPlugins } from "@ktb/eval-validator";
import { plugins as invitesPlugins } from "@ktb/invites";
import { plugins as jobsPlugins } from "@ktb/jobs";
import { plugins as notificationsPlugins } from "@ktb/notifications";
import { plugins as patientAccessPlugins } from "@ktb/patient-access";
import { plugins as patientPortalPlugins } from "@ktb/patient-portal";
import { plugins as patientsPlugins } from "@ktb/patients";
import { plugins as platformPlugins } from "@ktb/platform";
import { plugins as secretariesPlugins } from "@ktb/secretaries";
import { plugins as themePlugins } from "@ktb/theme";
import { physical, rootRoute, route } from "@tanstack/virtual-file-routes";

// Route-tree composition runs under jiti during typegen, where
// import.meta.glob (used by @ktb/app-host plugin discovery) is unavailable —
// so plugin entries are imported statically here instead of via `plugins`.
const routePlugins = [
	...aiProviderPlugins,
	...apiPlugins,
	...authPlugins,
	...consultationsPlugins,
	...credentialsPlugins,
	...doctorsPlugins,
	...evalPersonaPlugins,
	...evalValidatorPlugins,
	...invitesPlugins,
	...jobsPlugins,
	...notificationsPlugins,
	...patientAccessPlugins,
	...patientPortalPlugins,
	...patientsPlugins,
	...platformPlugins,
	...secretariesPlugins,
	...themePlugins,
];

// Host-composed route tree: host-owned routes plus each plugin's declared
// subtree. Self-contained plugins (patients, consultations) contribute
// physical() mounts of their own src/routes directories and reach the app
// runtime through @ktb/server-fns; plugins that still wire host server
// functions keep route modules under src/routes/**.
export const routes = rootRoute("__root.tsx", [
	...routePlugins.flatMap((p) => p.routes ?? []),
	physical("/api", "api"),
	// Root splat (route collapse): the single plugin-page dispatcher —
	// "/" renders the landing picker, "/platform*" the console shell,
	// "/portal/<instance>/*" the namespaced portal shell, and any other
	// path an app-shell page descriptor. /portal/login lives on as a
	// sign-in-page descriptor (legacy redirect). Static routes above
	// keep match priority.
	route("$", "$.tsx"),
]);
