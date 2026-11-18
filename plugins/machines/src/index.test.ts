import { describe, expect, it } from "vitest";

import { plugins } from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";

describe("machines plugin manifests", () => {
	it("declares tables, services, chrome and panel plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"machines.tables",
			"machines.services",
			"machines.chrome",
			"machines.panel",
		]);
		const tables = plugins.find((p) => p.id === "machines.tables")?.tables ?? {};
		expect(Object.keys(tables)).toEqual(["machine"]);
		const panel = plugins.find((p) => p.id === "machines.panel")?.panel?.pages ?? [];
		expect(panel.map((p) => p.path)).toEqual(["/platform/ai/machines"]);
	});

	it("client mirror matches the server plugin ids and panel path", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"machines.tables",
			"machines.services",
			"machines.chrome",
			"machines.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "machines.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["machines.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "machines.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/ai/machines"]);
	});
});
