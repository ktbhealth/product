import { describe, expect, it } from "vitest";
import type { Plugin } from "@ktb/kernel";
import { PLUGIN_KEYWORD_SET } from "@ktb/platform/keywords";

import { plugins as serverPlugins } from "@ktb/app-host";
import { plugins as clientPlugins } from "./plugins.ts";

/**
 * The client registry (@ktb/app-host/client → plugins/<name>/src/client.ts)
 * must mirror the server registry (@ktb/app-host → plugins/<name>/src/index.ts)
 * on everything the browser can observe: plugin ids in topo order, dep
 * edges, and the client-consumed contributions (chrome entries,
 * landing.page, panel.pages, pages id+path+component+context,
 * portals, boundaries kind+component, and elementKinds
 * kind/label/icon/renderer/editor).
 * Server-only fields (tables, services, cqrs, routes, middleware, pipelines,
 * orchestrations, page loader/guard, configSchema) are excluded — they
 * must never reach the client bundle.
 *
 * `contributions` (P-070 generic channel) is client-VISIBLE but
 * opt-in: entries are plain JSON data any client surface may enumerate
 * via ctx.plugins, yet most mirrors deliberately omit them (no browser
 * consumer — see plugins/triggers/src/client.ts, packages/platform's
 * platform.jobs). It therefore gets a dedicated subset assertion below
 * instead of strict parity.
 */
const clientView = (p: Plugin) => ({
	id: p.id,
	// The discoverPlugins pkg stamp must match across the parity
	// boundary — enable-state gates resolve package membership from it.
	pkg: p.pkg ?? null,
	system: p.system ?? null,
	meta: p.meta ?? null,
	priority: p.priority ?? null,
	// Plugin-declared chrome i18n keys (E.19) — plain data the client
	// shells merge via collectI18nKeys; must mirror across registries.
	i18nKeys: p.i18nKeys ?? null,
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
	// Portal instances (P-081): id/basePath/label/audience/subject/locale
	// are plain data the portal shells and switcher consume; `icon` is a
	// component ref compared like chrome/page components.
	portals:
		p.portals === undefined
			? null
			: p.portals.map((portal) => ({
					id: portal.id,
					basePath: portal.basePath,
					label: portal.label,
					icon: portal.icon ?? null,
					audience: portal.audience ?? null,
					subject: portal.subject ?? null,
					locale: portal.locale ?? null,
				})),
	boundaries:
		p.boundaries === undefined
			? null
			: p.boundaries.map((boundary) => ({ kind: boundary.kind, component: boundary.component })),
	elementKinds: (p.elementKinds ?? []).map((kind) => ({
		kind: kind.kind,
		label: kind.label,
		description: kind.description ?? null,
		category: kind.category ?? null,
		icon: kind.icon ?? null,
		renderer: kind.renderer ?? null,
		editor: kind.editor ?? null,
		fields: kind.fields ?? null,
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
			expect(p.routes).toBeUndefined();
			expect(p.middleware).toBeUndefined();
			expect(p.pipelines).toBeUndefined();
			expect(p.orchestrations).toBeUndefined();
			expect(p.cqrs).toBeUndefined();
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

	it("mirrors generic `contributions` as a subset of the server's", () => {
		// `contributions` is opt-in on the client (see file header): a
		// mirror carries an entry only when a browser surface consumes
		// its kind. Every entry the client DOES carry must match a
		// server entry exactly — kind/id/version/meta are JSON data, so
		// a drift here means the mirror invented or mutated a def.
		const serverById = new Map(serverPlugins.map((p) => [p.id, p]));
		for (const p of clientPlugins) {
			const server = serverById.get(p.id);
			expect(server, `client plugin ${p.id} has no server counterpart`).toBeDefined();
			for (const entry of p.contributions ?? []) {
				expect(
					server?.contributions ?? [],
					`${p.id} contribution ${entry.kind}/${entry.id} is not on the server plugin`,
				).toContainEqual(entry);
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
		// meta.keywords is open strings in the kernel contract — the
		// controlled vocabulary is product data (@ktb/platform/keywords)
		// enforced here at runtime: an unknown word fails this test.
		// The first keyword is the plugin's domain lane in the plugins
		// map.
		for (const p of serverPlugins) {
			const keywords = p.meta?.keywords ?? [];
			expect(keywords.length, `${p.id} has no meta.keywords`).toBeGreaterThan(0);
			for (const keyword of keywords) {
				expect(
					PLUGIN_KEYWORD_SET.has(keyword),
					`${p.id} declares unknown keyword "${keyword}"`,
				).toBe(true);
			}
		}
	});
});
