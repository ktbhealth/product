import { createPluginFileRoute } from "@ktb/server-fns";

import { redirectToPortal } from "../guard.ts";

// The patients list lives inside the clinical portals
// (/portal/{doctor,secretary}/patients); this legacy URL only funnels
// callers into the matching instance.
export const Route = createPluginFileRoute("patients.routes")("/patients/")({
	beforeLoad: () => redirectToPortal("/patients"),
	component: () => null,
});
