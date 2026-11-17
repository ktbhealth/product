import { createPluginFileRoute } from "@ktb/server-fns";

import { redirectToPortal } from "../guard.ts";

// The consultation record lives inside the clinical portals
// (/portal/{doctor,secretary}/consultations/<id>); this legacy URL only
// funnels callers into the matching instance.
export const Route = createPluginFileRoute("consultations.routes")("/consultations/$id")({
	beforeLoad: ({ params }) => redirectToPortal(`/consultations/${params.id}`),
	component: () => null,
});
