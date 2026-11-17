import type { PortalInstance } from "@ktb/kernel";

/**
 * Audience rule ids a `PortalInstance.audience` may name (P-081) —
 * client-safe (no Effect/services imports) so routes and the shell can
 * evaluate access without pulling the server graph.
 *
 * - `platform-admin` — email in the PLATFORM_ADMIN_EMAILS allowlist.
 * - `doctor` — the signed-in account holds its OWN doctor profile.
 * - `secretary` — the signed-in account holds delegated doctor access.
 * - `clinician` — doctor OR secretary (the clinical workspace audience).
 * - `patient` — the signed-in account holds an active patient_access
 *   link, OR has no doctor side at all (a patient account — the app
 *   chrome's `patientOnly` concept; covers invited users whose links
 *   still wait on email verification).
 * - `member` — any authenticated user (the default when an instance
 *   declares no `audience`).
 */
export const PORTAL_AUDIENCE = {
	platformAdmin: "platform-admin",
	doctor: "doctor",
	secretary: "secretary",
	clinician: "clinician",
	patient: "patient",
	member: "member",
} as const;

/** The audience rule an instance declares — `member` when absent. */
export const instanceAudience = (instance: PortalInstance): string =>
	instance.audience ?? PORTAL_AUDIENCE.member;

/** Whether `audiences` (rule ids from PortalAudience) admits `instance`. */
export const portalAdmits = (
	instance: PortalInstance,
	audiences: ReadonlySet<string> | readonly string[],
): boolean => {
	const set = audiences instanceof Set ? audiences : new Set(audiences);
	return set.has(instanceAudience(instance));
};
