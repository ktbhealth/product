import { describe, expect, it } from "vitest";

import { plugins } from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";

describe("ai-prompt plugin manifests", () => {
	it("declares tables, services, chrome and panel plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"ai.prompt.tables",
			"ai.prompt.services",
			"ai.prompt.chrome",
			"ai.prompt.panel",
		]);
		const tables = plugins.find((p) => p.id === "ai.prompt.tables")?.tables ?? {};
		expect(Object.keys(tables)).toEqual(["aiPrompt"]);
		const panel = plugins.find((p) => p.id === "ai.prompt.panel")?.panel?.pages ?? [];
		expect(panel.map((p) => p.path)).toEqual(["/platform/ai/prompts"]);
	});

	it("client mirror matches the server plugin ids and panel path", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"ai.prompt.tables",
			"ai.prompt.services",
			"ai.prompt.chrome",
			"ai.prompt.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "ai.prompt.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["ai-prompt.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "ai.prompt.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/ai/prompts"]);
	});
});
