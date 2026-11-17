import type { PageContext } from "@ktb/kernel";

import { PortalActivityPage } from "./PortalActivityPage.tsx";

/** /portal/patient/activity as a portal-instance page (P-086): the
 * loader already resolved the open record's fail-closed feed — this
 * wrapper only maps it and the host-injected locale onto the shared
 * audit table. */
export function PatientPortalActivityPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	return <PortalActivityPage data={data} locale={ctx.locale} i18n={ctx.i18n} />;
}
