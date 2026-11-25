import { createContext } from "react";

import type { AdminConsultationRow } from "./queries.ts";

/**
 * Cross-owner consultation rows for the /platform dashboard slots —
 * the host route provides them (fed by `adminListConsultationsFn` in
 * ./fns.ts); empty until then or when the package is disabled.
 * Dashboard components never call server fns themselves.
 */
export const ConsultationsDashboardContext = createContext<readonly AdminConsultationRow[]>([]);

/**
 * Caller's pending-review count for the sidebar badge (PL-023 F2) —
 * unsigned anamneses + unconfirmed transcript-only rows, deferred
 * excluded. The host portal layout provides it from
 * `countPendingReviewFn`; 0 (the default) hides the badge.
 */
export const PendingReviewCountContext = createContext(0);
