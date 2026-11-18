/// <reference types="vitest/config" />
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { searchForWorkspaceRoot } from "vite";

// @tanstack/router-generator evaluates the virtual route config
// (src/routes.ts) through jiti, which only enables babel's JSX/TSX
// plugins when its `jsx` option is set — the generator never passes it,
// so any .tsx reachable from routes.ts (plugin entries statically import
// their panel-page components) fails with "ParseError: Unexpected
// token" and routeTree.gen.ts is never regenerated. JITI_JSX flips
// jiti's jsx default on; it is read when jiti is created inside the
// vite process, i.e. after this module evaluates.
process.env.JITI_JSX ??= "1";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Per-environment aliasing isn't a `resolve` option (alias only exists at
// the top level), so environment-pinned specifiers go through `pre`
// resolveId plugins gated by `applyToEnvironment`.
const envAlias = (environmentName: string, find: string, subpath: string): Plugin => ({
	name: `ktb-env-alias-${environmentName}-${find}`,
	enforce: "pre",
	applyToEnvironment: (environment) => environment.name === environmentName,
	resolveId(source, importer) {
		if (source !== find) return null;
		return this.resolve(subpath, importer, { skipSelf: true });
	},
});

export default defineConfig(({ command, isPreview }) => {
	// KTB_DEV_NODE=1 (`bun run dev:node`): run the dev server on plain
	// Node/Bun instead of workerd — no cloudflare plugin, and
	// `cloudflare:workers` is aliased to a process.env + SQLite-file shim
	// (src/lib/node-cloudflare-workers.ts). DB then comes from
	// DATABASE_URL (default ./data/app.db) via @ktb/db-sqlite instead of
	// the local D1 binding. Build/preview are unaffected.
	const nodeDev =
		process.env.KTB_DEV_NODE === "1" && command === "serve" && !isPreview && !process.env.VITEST;

	// loro-crdt's `browser` build loads its .wasm via sync XHR from a URL
	// derived from import.meta.url. Under bun's isolated linker the package
	// realpath lives in the global package cache — outside the workspace
	// root — so Vite's fs.allow default 403s the request. Resolve the real
	// package dir from the plugin that owns the dep and allow it explicitly.
	const loroPkgDir = (() => {
		try {
			const req = createRequire(new URL("../../plugins/i18n/package.json", import.meta.url));
			return dirname(realpathSync(req.resolve("loro-crdt/package.json")));
		} catch {
			return null;
		}
	})();

	return {
		server: {
			fs: {
				allow: [
					searchForWorkspaceRoot(fileURLToPath(new URL(".", import.meta.url))),
					...(loroPkgDir === null ? [] : [loroPkgDir]),
				],
			},
		},
		resolve: {
			tsconfigPaths: true,
			dedupe: ["react", "react-dom"],
			alias: [
				...(nodeDev
					? [
							{
								find: "cloudflare:workers",
								replacement: fileURLToPath(
									new URL("./src/lib/node-cloudflare-workers.ts", import.meta.url),
								),
							},
							{
								// node:net stand-in for the sockets contract — used by
								// the SMTP email driver (platform.ts imports the specifier).
								find: "cloudflare:sockets",
								replacement: fileURLToPath(
									new URL("../../packages/email-smtp/src/node-connect.ts", import.meta.url),
								),
							},
						]
					: []),
				{
					// CJS-only package; breaks workerd SSR. React 19 has the hook.
					find: /^use-sync-external-store\/shim$/,
					replacement: fileURLToPath(
						new URL("./src/lib/use-sync-external-store-shim.ts", import.meta.url),
					),
				},
				{
					find: /^use-sync-external-store\/shim\/with-selector$/,
					replacement: fileURLToPath(
						new URL("./src/lib/use-sync-external-store-shim-with-selector.ts", import.meta.url),
					),
				},
			],
		},
		// Whisper worker imports this lazily; pre-bundle it at startup so the
		// dev server doesn't re-optimize (and 504) while the worker is loading.
		// platejs chain: same CJS leak as the SSR env below — @platejs/*/dist
		// internals cross-import each other via deep paths and pull raw CJS
		// (is-hotkey, lodash/*) that the browser cannot execute, killing
		// hydration with a SyntaxError. Bundling the whole platejs subtree
		// lets esbuild interop every transitive CJS dep inside the chunks.
		optimizeDeps: {
			include: [
				"@huggingface/transformers",
				"@ktbhealth/ui > platejs",
				"@ktbhealth/ui > platejs/react",
				"@ktbhealth/ui > @platejs/basic-nodes",
				"@ktbhealth/ui > @platejs/basic-nodes/react",
				"@ktbhealth/ui > @platejs/link",
				"@ktbhealth/ui > @platejs/link/react",
				"@ktbhealth/ui > @platejs/list",
				"@ktbhealth/ui > @platejs/list/react",
			],
			// loro-crdt: esbuild's optimizer resolves its exports map to the
			// `bundler` build (browser.development condition), which needs
			// wasm module wiring vite dev doesn't provide — the chunk ships
			// uninitialized WASM and kills hydration. Excluding it keeps raw
			// resolution, where the client-env alias below selects the
			// self-initializing `browser` build.
			exclude: ["loro-crdt"],
		},
		environments: {
			ssr: {
				optimizeDeps: {
					// pdfkit is only reachable through lazily-mounted server route
					// modules, so the SSR dep crawler misses it on cold start.
					// Discovering it mid-request forces a second optimizer pass +
					// program reload, during which react-router's raw-transformed
					// source resolves `react` to the raw CJS build while
					// react-dom/server uses the bundled one (invalid hook call).
					// Pre-bundling keeps the first pass complete — no reload.
					//
					// platejs chain: @ktbhealth/ui's rich-text-editor (pulled into
					// the SSR graph by plugins/i18n's I18nPage) imports platejs +
					// @platejs/*, which the crawler misses — is-hotkey leaks into
					// workerd as raw CJS ("exports is not defined" in the runner
					// DO). Nested "pkg > dep" specifiers: plate deps are only
					// reachable through @ktbhealth/ui's nested node_modules under
					// bun's isolated linker.
					include: [
						"pdfkit",
						"@ktbhealth/ui > platejs",
						"@ktbhealth/ui > platejs/react",
						"@ktbhealth/ui > @platejs/basic-nodes",
						"@ktbhealth/ui > @platejs/basic-nodes/react",
						"@ktbhealth/ui > @platejs/link",
						"@ktbhealth/ui > @platejs/link/react",
						"@ktbhealth/ui > @platejs/list",
						"@ktbhealth/ui > @platejs/list/react",
					],
				},
			},
		},
		worker: { format: "es" },
		test: {
			include: ["src/**/*.test.*"],
			exclude: ["e2e/**"],
		},
		plugins: [
			// workerd everywhere except vitest (unit tests stay on plain Node)
			// and KTB_DEV_NODE dev (plain Node + SQLite file instead of D1).
			// Dev uses wrangler.dev.jsonc — it drops the Workers AI binding,
			// which has no local simulator and would force an authenticated
			// remote session. Build/preview keep wrangler.jsonc.
			...(process.env.VITEST || nodeDev
				? []
				: [
						cloudflare({
							configPath: fileURLToPath(
								new URL(
									command === "serve" && !isPreview ? "./wrangler.dev.jsonc" : "./wrangler.jsonc",
									import.meta.url,
								),
							),
							viteEnvironment: { name: "ssr" },
						}),
					]),
			// loro-crdt per-environment builds (comments on the optimizeDeps
			// `exclude` above): the client env gets the `browser` build —
			// self-initializing WASM via sync XHR, which the real browser
			// has; ssr (workerd) gets `bundler` — its .wasm is an ES module
			// @cloudflare/vite-plugin serves as a WebAssembly.Module, while
			// `browser`'s sync-XHR loader doesn't exist in workerd (PL-008).
			envAlias("client", "loro-crdt", "loro-crdt/browser"),
			envAlias("ssr", "loro-crdt", "loro-crdt/bundler"),
			devtools(),
			tailwindcss(),
			// Custom server entry (src/server.ts) adds the Cloudflare Queue
			// consumer for async audio transcription alongside the fetch handler.
			...tanstackStart({ server: { entry: "server.ts" } }),
			viteReact(),
		],
	};
});
