import { describe, expect, it } from "vitest";

import { plugins } from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";

describe("ai-model plugin manifests", () => {
	it("declares tables, services, chrome and panel plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"ai.model.tables",
			"ai.model.services",
			"ai.model.chrome",
			"ai.model.panel",
		]);
		const tables = plugins.find((p) => p.id === "ai.model.tables")?.tables ?? {};
		expect(Object.keys(tables)).toEqual(["aiModel"]);
		const panel = plugins.find((p) => p.id === "ai.model.panel")?.panel?.pages ?? [];
		expect(panel.map((p) => p.path)).toEqual(["/platform/ai/models"]);
	});

	it("client mirror matches the server plugin ids and panel path", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"ai.model.tables",
			"ai.model.services",
			"ai.model.chrome",
			"ai.model.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "ai.model.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["ai-model.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "ai.model.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/ai/models"]);
	});
});
