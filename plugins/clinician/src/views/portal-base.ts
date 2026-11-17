import { useLocation } from "@tanstack/react-router";

/**
 * The portal instance this clinical page renders under — derived from
 * the live pathname ("/portal/doctor/…" → "doctor") so one page
 * component serves every clinical instance mounting it (the shared
 * workspace mounts under /portal/doctor and /portal/secretary).
 */
export const usePortalInstanceId = (): string =>
	useLocation({ select: (l) => l.pathname.split("/")[2] ?? "" });

/** The instance's base path — "/portal/doctor", "/portal/secretary", …
 * In-view links stay under it so drill-down never drops the clinician
 * back into the app shell. */
export const usePortalBase = (): string => `/portal/${usePortalInstanceId()}`;
