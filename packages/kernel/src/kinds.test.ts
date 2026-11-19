import { describe, expect, it } from "vitest";

import type { Plugin } from "./contributions.ts";
import {
	collectContributions,
	collectKindContributions,
	FIELD_CONTRIBUTION_KINDS,
	GENERIC_CONTRIBUTION_SLOT,
	pluginContributionKinds,
	THEME_BRAND_KIND,
	THEME_CONTRIBUTION_KINDS,
	THEME_TOKENS_KIND,
	type ContributionKindDescriptor,
} from "./kinds.ts";

const pagesKind = FIELD_CONTRIBUTION_KINDS.find((k) => k.id === "pages")!;
const evalStageKind: ContributionKindDescriptor = {
	id: "eval.stage",
	slot: GENERIC_CONTRIBUTION_SLOT,
	consumers: ["eval-cli"],
	ordering: "declared",
};

describe("FIELD_CONTRIBUTION_KINDS", () => {
	it("declares one descriptor per dedicated Plugin field", () => {
		expect(FIELD_CONTRIBUTION_KINDS.map((k) => k.id)).toEqual([
			"tables",
			"services",
			"routes",
			"landing",
			"chrome",
			"panel",
			"pages",
			"portals",
			"boundaries",
			"elementKinds",
		]);
		for (const kind of FIELD_CONTRIBUTION_KINDS) {
			expect(kind.slot).toBe(kind.id);
			expect(kind.consumers.length).toBeGreaterThan(0);
		}
	});

	it("pins each kind's consumers and ordering contract", () => {
		const byId = new Map(FIELD_CONTRIBUTION_KINDS.map((k) => [k.id, k]));
		const consumers = (id: string) => byId.get(id)?.consumers;
		expect(consumers("tables")).toEqual(["app-host.server", "plugin-manager"]);
		expect(consumers("services")).toEqual(["app-host.server", "plugin-manager"]);
		expect(consumers("routes")).toEqual(["app.routes", "plugin-manager"]);
		expect(consumers("landing")).toEqual(["app-host.client", "app.routes"]);
		expect(consumers("chrome")).toEqual(["app-host.client", "app.routes"]);
		expect(consumers("panel")).toEqual(["app-host.server", "app-host.client", "plugin-manager"]);
		expect(consumers("pages")).toEqual(["app-host.server", "app-host.client", "app.routes"]);
		expect(consumers("portals")).toEqual(["app-host.server", "app-host.client", "plugin-manager"]);
		expect(consumers("boundaries")).toEqual([
			"app-host.client",
			"app-host.server",
			"plugin-manager",
		]);
		expect(consumers("elementKinds")).toEqual(["app-host.client", "plugin-manager"]);
		// Only chrome declares payload-level ordering; everything else is topo.
		for (const kind of FIELD_CONTRIBUTION_KINDS) {
			expect(kind.ordering).toBe(kind.id === "chrome" ? "declared" : "topo");
		}
	});
});

describe("collectKindContributions", () => {
	const plugins: readonly Plugin[] = [
		{
			id: "a.pages",
			pages: [
				{ id: "a.one", path: "/one", component: () => null },
				{ id: "a.two", path: "/two", component: () => null },
			],
		},
		{ id: "b.marker" },
		{
			id: "c.pages",
			pages: [{ id: "c.one", path: "/c", component: () => null }],
		},
	];

	it("fans out over array fields in plugin then declaration order", () => {
		const collected = collectKindContributions(plugins, pagesKind);
		expect(collected.map((c) => [c.plugin.id, c.entryIndex])).toEqual([
			["a.pages", 0],
			["a.pages", 1],
			["c.pages", 0],
		]);
		expect(collected[0]?.kind).toBe("pages");
		expect((collected[0]?.payload as { id: string }).id).toBe("a.one");
	});

	it("yields a single entry for non-array field payloads", () => {
		const landing = FIELD_CONTRIBUTION_KINDS.find((k) => k.id === "landing")!;
		const withLanding: readonly Plugin[] = [
			{ id: "a", landing: { page: () => null } },
			{ id: "b" },
		];
		const collected = collectKindContributions(withLanding, landing);
		expect(collected).toHaveLength(1);
		expect(collected[0]?.entryIndex).toBe(0);
		expect(collected[0]?.plugin.id).toBe("a");
	});

	it("collects generic contributions entries by kind", () => {
		const withContribs: readonly Plugin[] = [
			{
				id: "eval.a",
				contributions: [
					{ kind: "eval.stage", id: "s1", version: "1" },
					{ kind: "eval.metric", id: "m1", version: "1" },
					{ kind: "eval.stage", id: "s2", version: "1" },
				],
			},
			{ id: "eval.b", contributions: [{ kind: "eval.stage", id: "s3", version: "1" }] },
		];
		const collected = collectKindContributions(withContribs, evalStageKind);
		expect(collected.map((c) => (c.payload as { id: string }).id)).toEqual(["s1", "s2", "s3"]);
		expect(collected.map((c) => c.entryIndex)).toEqual([0, 2, 0]);
	});

	it("skips plugins without the slot and unknown generic kinds", () => {
		const collected = collectKindContributions(plugins, evalStageKind);
		expect(collected).toEqual([]);
	});
});

describe("theme contribution kinds (P-082)", () => {
	it("registers theme.tokens and theme.brand on the generic channel", () => {
		expect(GENERIC_CONTRIBUTION_SLOT).toBe("contributions");
		expect(THEME_TOKENS_KIND.id).toBe("theme.tokens");
		expect(THEME_BRAND_KIND.id).toBe("theme.brand");
		for (const kind of [THEME_TOKENS_KIND, THEME_BRAND_KIND]) {
			expect(kind.slot).toBe(GENERIC_CONTRIBUTION_SLOT);
			expect(kind.ordering).toBe("topo");
			expect(kind.consumers).toEqual(["app-host.server", "app-host.client", "app.routes"]);
		}
		expect(THEME_CONTRIBUTION_KINDS).toEqual([THEME_TOKENS_KIND, THEME_BRAND_KIND]);
	});

	it("collects theme.* entries from plugin contributions", () => {
		const registry: readonly Plugin[] = [
			{
				id: "theme.a",
				contributions: [
					{
						kind: "theme.tokens",
						id: "tokens",
						meta: { light: { "--primary": "oklch(0.5 0.2 20)" } },
					},
					{ kind: "theme.brand", id: "brand", meta: { appName: "Clinic" } },
				],
			},
		];
		expect(
			collectKindContributions(registry, THEME_TOKENS_KIND).map(
				(c) => (c.payload as { id: string }).id,
			),
		).toEqual(["tokens"]);
		expect(
			collectKindContributions(registry, THEME_BRAND_KIND).map(
				(c) => (c.payload as { id: string }).id,
			),
		).toEqual(["brand"]);
		// collectContributions only sees them when the caller opts in.
		expect(collectContributions(registry, THEME_CONTRIBUTION_KINDS)).toHaveLength(2);
	});
});

describe("collectContributions", () => {
	it("collects the requested kinds and defaults to the field kinds", () => {
		const registry: readonly Plugin[] = [
			{
				id: "a",
				pages: [{ id: "p", path: "/p", component: () => null }],
				contributions: [{ kind: "eval.stage", id: "s", version: "1" }],
			},
		];
		// Default: dedicated field kinds only — generic entries are opt-in.
		expect(collectContributions(registry).map((c) => c.kind)).toEqual(["pages"]);
		expect(collectContributions(registry, [evalStageKind]).map((c) => c.kind)).toEqual([
			"eval.stage",
		]);
	});
});

describe("pluginContributionKinds", () => {
	it("lists dedicated fields present plus generic kind ids", () => {
		const plugin: Plugin = {
			id: "x",
			pages: [{ id: "p", path: "/p", component: () => null }],
			contributions: [
				{ kind: "eval.stage", id: "s", version: "1" },
				{ kind: "eval.stage", id: "s2", version: "1" },
				{ kind: "eval.metric", id: "m", version: "1" },
			],
		};
		expect(pluginContributionKinds(plugin)).toEqual(["pages", "eval.stage", "eval.metric"]);
	});

	it("is empty for a bare marker plugin", () => {
		expect(pluginContributionKinds({ id: "x" })).toEqual([]);
	});
});
