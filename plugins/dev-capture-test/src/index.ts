import { definePlugin, type Plugin } from "@ktb/kernel";
import * as Effect from "effect/Effect";

import { CaptureTestPage, devCaptureTestBeforeLoad } from "./capture-test-page.tsx";

/**
 * Dev-only spike page (T-012): `/capture-test` proves that tab audio
 * (e.g. a WhatsApp Web call) is capturable via getDisplayMedia. Ported
 * from the host route apps/web/src/routes/capture-test.tsx into a
 * generic `pages` descriptor (P-059) — the host `/$` splat dispatches
 * it inside the app shell.
 *
 * Gating is fail-closed and identical to the host route: `beforeLoad`
 * (isomorphic — runs on SSR and client navigations) returns
 * `{ notFound: true }` when `import.meta.env.DEV` is false, and the
 * server-side `guard` re-checks the same compile-time constant before
 * the loader stage so the page can never be reached in production
 * builds. The page carries no loader — `data` is always null.
 */
export const devCaptureTestPagesPlugin = definePlugin({
	id: "dev-capture-test.pages",
	meta: {
		name: "Dev capture test",
		description: "Dev-only spike: proves tab audio is capturable via getDisplayMedia.",
		keywords: ["pages", "ui"],
	},
	pages: [
		{
			id: "dev-capture-test.capture",
			path: "/capture-test",
			context: "app",
			component: CaptureTestPage,
			beforeLoad: devCaptureTestBeforeLoad,
			// `_path` keeps the descriptor's literal type at the Page.guard
			// signature — definePlugin preserves it and tests/hosts call
			// guard(path).
			guard: (_path: string) => Effect.succeed(import.meta.env.DEV),
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [devCaptureTestPagesPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"dev-capture-test.pages": true;
	}
}
