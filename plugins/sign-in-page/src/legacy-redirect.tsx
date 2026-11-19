/** Component for the legacy /portal/login redirect descriptor — the
 * beforeLoad hook always redirects, so this never renders. Shared by
 * ./index.ts and ./client.ts so the manifests stay identical. */
export const LegacyPortalLoginPage = () => null;

/** Legacy patient sign-in redirect: /portal/login predates the
 * /login role picker — access emails and bookmarks already sent land
 * here. Kept as a plugin page (was the host file route
 * apps/web/src/routes/portal-login.tsx) so app pages stay
 * plugin-owned. */
export const legacyPortalLoginBeforeLoad = () => ({ redirectTo: "/login/patient" }) as const;
