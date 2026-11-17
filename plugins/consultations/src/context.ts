import { createContext } from "react";

import type { AdminConsultationRow } from "./queries.ts";

/**
 * Cross-owner consultation rows for the /platform dashboard slots —
 * the host route provides them (fed by `adminListConsultationsFn` in
 * ./fns.ts); empty until then or when the package is disabled.
 * Dashboard components never call server fns themselves.
 */
export const ConsultationsDashboardContext = createContext<readonly AdminConsultationRow[]>([]);
