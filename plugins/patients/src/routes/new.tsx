import { createPluginFileRoute } from "@ktb/server-fns";

import { redirectToPortal } from "../guard.ts";

// The patient registration form lives inside the clinical portals
// (/portal/{doctor,secretary}/patients/new); this legacy URL only
// funnels callers into the matching instance.
export const Route = createPluginFileRoute("patients.routes")("/patients/new")({
	beforeLoad: () => redirectToPortal("/patients/new"),
	component: () => null,
});
