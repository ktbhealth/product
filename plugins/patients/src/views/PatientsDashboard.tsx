import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { UsersIcon } from "lucide-react";
import { useContext } from "react";

import { Card, CardContent } from "@ktbhealth/ui/components/card";

import { PatientsDashboardContext } from "../context.ts";
import { patientMessages, I18N_NAMESPACE } from "../i18n.ts";

interface DashboardSlotProps {
	readonly locale?: string;
	readonly i18n?: PageI18nSlice;
}

/**
 * `portal.dashboard.stats` contribution: the patients count. Rows
 * arrive through PatientsDashboardContext, which the /platform layout
 * provides from `adminListPatientsFn` — empty when the package is
 * disabled or the feed was skipped.
 */
export function PatientsDashboardStats({ locale = "en", i18n }: DashboardSlotProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, patientMessages(locale));
	const patients = useContext(PatientsDashboardContext);
	return (
		<Card>
			<CardContent className="flex items-center gap-3 px-4 py-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600">
					<UsersIcon className="size-4" />
				</span>
				<div className="min-w-0">
					<div className="text-[10px] tracking-widest text-muted-foreground uppercase">
						{t.common.patients}
					</div>
					<div className="truncate text-xl font-bold">{patients.length}</div>
				</div>
			</CardContent>
		</Card>
	);
}
