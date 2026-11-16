import { createPluginFileRoute } from "@ktb/server-fns";

import { redirectToPortal } from "../guard.ts";

// The consultations list lives inside the clinical portals
// (/portal/{doctor,secretary}/consultations); this legacy URL only
// funnels callers into the matching instance.
export const Route = createPluginFileRoute("consultations.routes")("/consultations/")({
	beforeLoad: () => redirectToPortal("/consultations"),
	component: () => null,
});
