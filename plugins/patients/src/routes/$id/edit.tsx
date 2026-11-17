import { createPluginFileRoute } from "@ktb/server-fns";

import { redirectToPortal } from "../../guard.ts";

// The patient edit form lives inside the clinical portals
// (/portal/{doctor,secretary}/patients/<id>/edit); this legacy URL only
// funnels callers into the matching instance.
export const Route = createPluginFileRoute("patients.routes")("/patients/$id/edit")({
	beforeLoad: ({ params }) => redirectToPortal(`/patients/${params.id}/edit`),
	component: () => null,
});
