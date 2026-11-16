import { useMemo } from "react";
import { notFound } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";
import { makeKeyring } from "@ktb/crypto/keyring";
import { vaultStateFn } from "@ktb/vault/fns";

import { ConsultationDetailPage } from "../views/index.ts";
import { getConsultationFn, localeFn, patientHistoryFn, patientHistoryRowsFn } from "../fns.ts";
import { requireDoctor } from "../guard.ts";
import { consultationDetailApi, consultationsZkApi } from "../apis.ts";

export const Route = createPluginFileRoute("consultations.routes")("/consultations/$id")({
	staleTime: 30_000,
	beforeLoad: () => requireDoctor(),
	loader: async ({ params }) => {
		const [c, vault, locale] = await Promise.all([
			getConsultationFn({ data: Number(params.id) }),
			vaultStateFn(),
			localeFn(),
		]);
		if (!c) throw notFound();
		// Linked patient → prior consultations. Under ZK the raw rows go
		// to the client, which decrypts and derives the visit facts
		// itself (T-145); otherwise the server-side summary is used.
		const history =
			c.patientId && !vault.zk
				? await patientHistoryFn({ data: { patientId: c.patientId, excludeId: c.id } })
				: null;
		const historyRows =
			c.patientId && vault.zk
				? await patientHistoryRowsFn({ data: { patientId: c.patientId, excludeId: c.id } })
				: null;
		return { c, history, historyRows, locale, zk: vault.zk };
	},
	component: function ConsultationRoute() {
		const { c, history, historyRows, locale, zk } = Route.useLoaderData();
		const keyring = useMemo(() => (zk ? makeKeyring() : null), [zk]);
		return (
			<ConsultationDetailPage
				c={c}
				history={history}
				historyRows={historyRows}
				api={consultationDetailApi}
				locale={locale}
				zk={zk && keyring ? { keyring, api: consultationsZkApi } : undefined}
			/>
		);
	},
});
