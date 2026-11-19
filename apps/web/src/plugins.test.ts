import { describe, expect, it } from "vitest";
import type { Plugin } from "@ktb/kernel";

import { plugins as serverPlugins } from "@ktb/app-host";
import { plugins as clientPlugins } from "./plugins.ts";

/**
 * The client registry (@ktb/app-host/client → plugins/<name>/src/client.ts)
 * must mirror the server registry (@ktb/app-host → plugins/<name>/src/index.ts)
 * on everything the browser can observe: plugin ids in topo order, dep
 * edges, and the client-consumed contributions (chrome entries,
 * landing.page, panel.pages, pages id+path+component+context, and
 * elementKinds kind/label/icon/renderer/editor).
 * Server-only fields (tables, services, routes, page loader/guard)
 * are excluded — they must never reach the client bundle.
 */
const clientView = (p: Plugin) => ({
	id: p.id,
	// The discoverPlugins pkg stamp must match across the parity
	// boundary — enable-state gates resolve package membership from it.
	pkg: p.pkg ?? null,
	system: p.system ?? null,
	meta: p.meta ?? null,
	priority: p.priority ?? null,
	requiredDeps: p.requiredDeps ?? [],
	optionalDeps: p.optionalDeps ?? [],
	chrome: p.chrome ?? [],
	landing: p.landing ?? null,
	panel:
		p.panel === undefined
			? null
			: {
					pages: (p.panel.pages ?? []).map((page) => ({
						id: page.id,
						path: page.path,
						component: page.component,
						validateSearch: page.validateSearch ?? null,
						beforeLoad: page.beforeLoad ?? null,
						head: page.head ?? null,
					})),
				},
	pages:
		p.pages === undefined
			? null
			: p.pages.map((page) => ({
					id: page.id,
					path: page.path,
					component: page.component,
					context: page.context ?? null,
					validateSearch: page.validateSearch ?? null,
					beforeLoad: page.beforeLoad ?? null,
					head: page.head ?? null,
				})),
	boundaries:
		p.boundaries === undefined
			? null
			: p.boundaries.map((boundary) => ({ kind: boundary.kind, component: boundary.component })),
	elementKinds: (p.elementKinds ?? []).map((kind) => ({
		kind: kind.kind,
		label: kind.label,
		icon: kind.icon ?? null,
		renderer: kind.renderer ?? null,
		editor: kind.editor ?? null,
	})),
});

describe("client plugin registry", () => {
	it("mirrors the server registry on client-visible fields, in order", () => {
		expect(clientPlugins.map(clientView)).toEqual(serverPlugins.map(clientView));
	});

	it("never carries server-only contributions", () => {
		for (const p of clientPlugins) {
			expect(p.tables).toBeUndefined();
			expect(p.services).toBeUndefined();
			for (const page of p.panel?.pages ?? []) {
				expect(page.loader).toBeUndefined();
				expect(page.guard).toBeUndefined();
			}
			for (const page of p.pages ?? []) {
				expect(page.loader).toBeUndefined();
				expect(page.guard).toBeUndefined();
			}
		}
	});

	it("keeps the config contract serializable: meta.config on both, configSchema server-only", () => {
		for (const p of serverPlugins) {
			// meta.config must be the plain JSON-Schema document — the same
			// object the client registry carries (asserted by the parity
			// test above). The runtime validator lives outside meta.
			if (p.meta?.config !== undefined) {
				expect(p.configSchema, `${p.id} declares meta.config but no configSchema`).toBeDefined();
				expect(JSON.parse(JSON.stringify(p.meta.config))).toEqual(p.meta.config);
			}
		}
		for (const p of clientPlugins) {
			// The effect/Schema is not serializable — it must never reach
			// the client registry.
			expect(p.configSchema, `${p.id} leaks configSchema to the client`).toBeUndefined();
		}
	});

	it("declares manifest keywords on every plugin (P-082)", () => {
		// Membership in PLUGIN_KEYWORDS is enforced at compile time —
		// meta.keywords is typed `PluginKeyword[]`, so an unknown word
		// fails `vp check` at the manifest itself. Runtime asserts the
		// non-empty contract: the first keyword is the plugin's domain
		// lane in the plugins map.
		for (const p of serverPlugins) {
			expect(p.meta?.keywords?.length ?? 0, `${p.id} has no meta.keywords`).toBeGreaterThan(0);
		}
	});
});
