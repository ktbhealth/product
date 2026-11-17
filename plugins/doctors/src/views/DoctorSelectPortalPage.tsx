import type { PageContext } from "@ktb/kernel";

import { selectDoctorFn } from "../fns.ts";
import { DoctorSelectPage, type DoctorProfileItem } from "./DoctorSelectPage.tsx";

/** Loader payload the portal dispatcher hands this page. */
interface DoctorSelectData {
	readonly profiles: readonly DoctorProfileItem[];
	readonly activeDoctorId: number | null;
}

/**
 * The profile chooser mounted inside the clinical portals (P-081):
 * the same view the app route renders, wired to this plugin's fns.
 * Picking a profile still reloads into the portal of the picked
 * role — every loader re-runs under the new acting doctor.
 */
export function DoctorSelectPortalPage({
	data,
	ctx,
}: {
	readonly data: unknown;
	readonly ctx: PageContext;
}) {
	const { profiles = [], activeDoctorId = null } = (data ?? {}) as Partial<DoctorSelectData>;
	return (
		<DoctorSelectPage
			profiles={profiles}
			activeDoctorId={activeDoctorId}
			i18n={ctx.i18n}
			locale={ctx.locale}
			api={{ select: (id) => selectDoctorFn({ data: id }) }}
			onDone={(profile) =>
				window.location.assign(
					profile.role === "secretary" ? "/portal/secretary" : "/portal/doctor",
				)
			}
		/>
	);
}
