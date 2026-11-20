import { StethoscopeIcon } from "lucide-react";
import { physical, route } from "@tanstack/virtual-file-routes";

import { doctorsServicesPlugin } from "@ktb/doctors";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { routeContribution } from "@ktb/platform/routes";

import { SessionMenu } from "./chrome.tsx";

/**
 * Auth plugin (P-062 pilot): owns the credential surface that used to
 * live in the host — the better-auth catch-all `/api/auth/*` (moved
 * from apps/web/src/routes/api/auth.$.ts) and the `/login/doctor` page. Both
 * route modules live in THIS package and are mounted into the host's
 * virtual route tree here; the provider instance and the Captcha port
 * reach the api route through @ktb/server-fns (ServerRuntime
 * `authHandler` + `run`), so the plugin never imports the auth
 * adapter on the server side.
 *
 * `system: true` on every entry: auth is foundational — a disabled
 * auth plugin would strand every session — so PluginStates reports it
 * enabled unconditionally and rejects disable writes (P-062).
 */
export const authRoutesPlugin = definePlugin({
	id: "auth.routes",
	meta: { keywords: ["auth", "routes"] },
	system: true,
	// /login/doctor calls the doctors plugin's doctorContextFn /
	// ensureDoctorProfileFn after sign-in — ordering hint only (optional,
	// never required: auth is system and must compose even when the
	// doctors plugin is absent; the fns then fail at call time).
	optionalDeps: [doctorsServicesPlugin.id],
	routes: [
		// Single-file page routes: `route()` resolves the module path
		// relative to the host's routes directory, same as physical().
		route("login/doctor", "../../../../plugins/auth/src/routes/login.tsx"),
		// Password recovery: every sign-in screen's "forgot password"
		// link lands on the shared request page; the emailed token link
		// lands on the reset form (both are credential surface — one
		// account system serves patients, doctors and secretaries).
		route("forgot-password", "../../../../plugins/auth/src/routes/forgot-password.tsx"),
		route("reset-password", "../../../../plugins/auth/src/routes/reset-password.tsx"),
		// /login/admin — superadmin sign-in (PlatformAdmin gate, RBAC or
		// email allowlist); lands on /platform.
		route("login/admin", "../../../../plugins/auth/src/routes/login-admin.tsx"),
		// API subtree: every module in src/api-routes/ mounts under the
		// shared "/api" prefix (auth.$.ts → /api/auth/$).
		physical("/api", "../../../../plugins/auth/src/api-routes"),
	],
	// Route-registry defs (PL-011) for the page routes above — the
	// /login/* and recovery paths the sign-in chrome links to.
	contributions: [
		routeContribution("auth.login.doctor", { path: "/login/doctor" }),
		routeContribution("auth.login.admin", { path: "/login/admin" }),
		routeContribution("auth.forgot-password", { path: "/forgot-password" }),
		routeContribution("auth.reset-password", { path: "/reset-password" }),
	],
});

/**
 * Session chrome (merged from the retired plugins/session, P-062):
 * the app-shell session menu in `app.header.session` — sign-in link or
 * the account dropdown. System like the routes: the menu is part of
 * the auth surface and must never be disableable.
 */
export const authChromePlugin = definePlugin({
	id: "auth.chrome",
	meta: { keywords: ["auth", "ui"] },
	system: true,
	chrome: [
		{
			id: "session.menu",
			region: "app.header.session",
			content: { kind: "component", component: SessionMenu },
		},
		// /login picker tile (P-099): the doctor sign-in flow needs the
		// doctors package (profile creation) and the clinician portal
		// live — same gates the old host-side role list applied.
		{
			id: "auth.login.doctor",
			region: "app.login.tiles",
			order: 1,
			content: {
				kind: "loginTile",
				to: "/login/doctor",
				labelKey: "nav_doctor_login",
				fallback: "Doctor sign in",
				icon: StethoscopeIcon,
				requires: ["doctors.services", "clinician.portal"],
			},
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [authRoutesPlugin, authChromePlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"auth.routes": true;
		"auth.chrome": true;
	}
}

// Route-registry keys (PL-011): the path literal must match the
// `routeContribution` meta above — `Routes.route()` types params off it.
declare module "@ktb/platform/routes" {
	interface RouteRegistry {
		"auth.login.doctor": "/login/doctor";
		"auth.login.admin": "/login/admin";
		"auth.forgot-password": "/forgot-password";
		"auth.reset-password": "/reset-password";
	}
}
