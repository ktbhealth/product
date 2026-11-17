import { createContext } from "react";

import type { AdminPatientRow } from "./index.ts";

/**
 * Cross-owner patient rows for the /platform dashboard stat — the host
 * route provides them (fed by `adminListPatientsFn` in ./fns.ts); empty
 * until then or when the package is disabled. Dashboard components
 * never call server fns themselves.
 */
export const PatientsDashboardContext = createContext<readonly AdminPatientRow[]>([]);
