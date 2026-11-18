// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fns.ts", () => ({
	modelsCreateFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
	modelsUpdateFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
	modelsRemoveFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { ModelCard } from "./models.ts";
import { ModelsPanelPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const card = (over: Partial<ModelCard> = {}): ModelCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	endpointId: null,
	name: "local-qwen",
	modelId: "qwen2.5:7b",
	kind: "chat",
	capabilities: ["chat"],
	contextTokens: null,
	costTier: null,
	isDefault: false,
	enabled: true,
	createdAt: new Date(0),
	updatedAt: null,
	...over,
});

afterEach(cleanup);

describe("ModelsPanelPage", () => {
	it("passes card arrays through to the view", () => {
		render(
			<ModelsPanelPage data={[card(), card({ id: 2, name: "gemini", kind: "other" })]} ctx={ctx} />,
		);
		expect(screen.getByText("local-qwen")).toBeTruthy();
		expect(screen.getByText("gemini")).toBeTruthy();
	});

	it("narrows non-array loader data to an empty list", () => {
		render(<ModelsPanelPage data={{ nope: true }} ctx={ctx} />);
		expect(screen.getByText(/No models yet/)).toBeTruthy();
	});
});
