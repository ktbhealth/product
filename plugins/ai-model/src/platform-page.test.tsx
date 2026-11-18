// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	create: vi.fn(async () => ({ ok: true })),
	update: vi.fn(async () => ({ ok: true })),
	remove: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./apis.ts", () => ({ modelsApi: api }));

import type { PanelPageContext } from "@ktb/kernel";

import type { ModelCard } from "./models.ts";
import { ModelsPanelPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const model = (over: Partial<ModelCard> = {}): ModelCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	endpointId: 3,
	name: "local-qwen",
	modelId: "qwen2.5:7b-instruct",
	kind: "chat",
	capabilities: ["chat", "eval-judge"],
	contextTokens: 32_768,
	costTier: "free",
	isDefault: true,
	enabled: true,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: null,
	...over,
});

afterEach(cleanup);

describe("ModelsPanelPage", () => {
	it("renders loader cards", () => {
		render(<ModelsPanelPage data={[model()]} ctx={ctx} />);
		expect(screen.getByText("local-qwen")).toBeTruthy();
		expect(screen.getByText("qwen2.5:7b-instruct")).toBeTruthy();
	});

	it("tolerates missing or malformed loader data", () => {
		render(<ModelsPanelPage data={undefined} ctx={ctx} />);
		expect(screen.getByText("No models yet — add the first catalog entry.")).toBeTruthy();
		cleanup();
		render(<ModelsPanelPage data="nope" ctx={ctx} />);
		expect(screen.getByText("No models yet — add the first catalog entry.")).toBeTruthy();
	});
});
