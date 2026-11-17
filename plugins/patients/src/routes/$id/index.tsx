import { createPluginFileRoute } from "@ktb/server-fns";

import { redirectToPortal } from "../../guard.ts";

// The patient record lives inside the clinical portals
// (/portal/{doctor,secretary}/patients/<id>); this legacy URL only
// funnels callers into the matching instance.
export const Route = createPluginFileRoute("patients.routes")("/patients/$id/")({
	beforeLoad: ({ params }) => redirectToPortal(`/patients/${params.id}`),
	component: () => null,
});
