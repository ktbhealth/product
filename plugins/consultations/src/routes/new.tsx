import { createPluginFileRoute } from "@ktb/server-fns";

import { redirectToPortal } from "../guard.ts";

// The new-consultation surface lives inside the clinical portals
// (/portal/{doctor,secretary}/consultations/new); this legacy URL only
// funnels callers into the matching instance, keeping the ?patientId=
// prefill search intact for the portal page to consume.
export const Route = createPluginFileRoute("consultations.routes")("/consultations/new")({
	beforeLoad: ({ location }) => redirectToPortal(`/consultations/new${location.searchStr}`),
	component: () => null,
});
