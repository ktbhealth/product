import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { useContext } from "react";

import { PendingReviewCountContext } from "../context.ts";
import { consultationMessages, I18N_NAMESPACE } from "../i18n.ts";

/**
 * `PanelSidebarItem.badge` payload for the clinical-portal
 * "Consultations" entry (PL-023 F2): the caller's pending-review
 * count as a quiet pill — a queue reminder, not an alert. Reads
 * PendingReviewCountContext (host-provided via `countPendingReviewFn`),
 * renders nothing at 0 so portals without the provider stay clean.
 */
export function ReviewQueueBadge({
	locale = "en",
	i18n,
}: {
	readonly locale?: string;
	readonly i18n?: PageI18nSlice;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const count = useContext(PendingReviewCountContext);
	if (count <= 0) return null;
	return (
		<span
			className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/10 px-1 text-[10px] font-semibold text-primary tabular-nums"
			title={t.list.sidebarPendingReview(count)}
			aria-label={t.list.sidebarPendingReview(count)}
		>
			{count}
		</span>
	);
}
