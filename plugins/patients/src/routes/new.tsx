import { useNavigate, getRouteApi } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

import { PatientFormPage } from "../views/index.ts";
import { localeFn } from "../fns.ts";
import { newPatientApi } from "../apis.ts";
import { requireDoctor } from "../guard.ts";

export const Route = createPluginFileRoute("patients.routes")("/patients/new")({
	beforeLoad: () => requireDoctor(),
	loader: () => localeFn(),
	component: function NewPatientRoute() {
		const locale = Route.useLoaderData();
		const navigate = useNavigate();
		const { i18n } = getRouteApi("__root__").useLoaderData();
		return (
			<PatientFormPage
				api={newPatientApi}
				i18n={i18n}
				locale={locale}
				onSaved={(id) => navigate({ to: "/patients/$id", params: { id: String(id) } })}
			/>
		);
	},
});
