import { Badge } from "@ktbhealth/ui/components/badge";
import { ShieldAlertIcon, ShieldCheckIcon, ShieldIcon } from "lucide-react";

import type { IntegrityVerification } from "./index.ts";

/**
 * Localized strings the badge renders. Every consumer owns its i18n —
 * the integrity package has no message catalog, so labels arrive as
 * props instead of a hardcoded English string.
 */
export interface IntegrityBadgeLabels {
	readonly verified: string;
	readonly tampered: string;
	readonly unversioned: string;
}

/** Status → badge tone + icon (same ring-tone vocabulary as the record views). */
const TONES = {
	verified: "bg-primary/10 text-primary ring-primary/20",
	tampered: "bg-red-50 text-red-700 ring-red-200",
	unversioned: "bg-muted text-muted-foreground ring-border",
} as const;

/**
 * Shared integrity badge (T-139): renders the outcome of an entity's
 * `verifyIntegrity` report next to its record — "verified" when the
 * whole version chain re-derives, "tampered" when any link/blob/content
 * check fails, "unversioned" when the entity has no version rows yet.
 * Renders nothing while the report is still loading (null).
 */
export function IntegrityBadge({
	report,
	labels,
}: {
	readonly report: IntegrityVerification | null;
	readonly labels: IntegrityBadgeLabels;
}) {
	if (report === null) return null;
	const Icon =
		report.status === "verified"
			? ShieldCheckIcon
			: report.status === "tampered"
				? ShieldAlertIcon
				: ShieldIcon;
	return (
		<Badge variant="secondary" className={`ring-1 ${TONES[report.status]}`}>
			<Icon className="size-3" />
			{labels[report.status]}
		</Badge>
	);
}
