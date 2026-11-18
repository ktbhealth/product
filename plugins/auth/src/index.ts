import { physical, route } from "@tanstack/virtual-file-routes";

import { doctorsServicesPlugin } from "@ktb/doctors";
import { definePlugin, type Plugin } from "@ktb/kernel";

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
		// API subtree: every module in src/api-routes/ mounts under the
		// shared "/api" prefix (auth.$.ts → /api/auth/$).
		physical("/api", "../../../../plugins/auth/src/api-routes"),
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
