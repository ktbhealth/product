import type { ComponentProps } from "react";

import type { PageContext } from "@ktb/kernel";
import { consultationDetailApi } from "@ktb/consultations/apis";
import { ReviewModePage } from "@ktb/consultations/views";

import { usePortalBase } from "./portal-base.ts";

type ReviewProps = ComponentProps<typeof ReviewModePage>;

/** Loader payload for <instance>/review[/<id>] (PL-023): the queue for
 * the rail plus the selected record when a numeric id subpath resolves. */
type ClinicianReviewData =
	| {
			readonly view: "item";
			readonly queue: ReviewProps["queue"];
			readonly c: ReviewProps["c"];
			readonly author: ReviewProps["author"];
	  }
	| {
			readonly view: "queue";
			readonly queue: ReviewProps["queue"];
			readonly author: ReviewProps["author"];
	  }
	| { readonly view: "missing" };

/** Guided review mode — the queue rail + transcript/anamnesis steps
 * mounted once per clinical instance. */
export function ClinicianReviewPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const base = usePortalBase();
	const d = (data ?? { view: "missing" }) as ClinicianReviewData;
	if (d.view === "missing") return null;
	return (
		<ReviewModePage
			queue={d.queue}
			c={d.view === "item" ? d.c : null}
			author={d.author}
			api={consultationDetailApi}
			i18n={ctx.i18n}
			locale={ctx.locale}
			portalBase={base}
		/>
	);
}
