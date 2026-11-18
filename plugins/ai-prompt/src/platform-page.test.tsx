// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	create: vi.fn(async () => ({ ok: true })),
	update: vi.fn(async () => ({ ok: true })),
	remove: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./apis.ts", () => ({ promptsApi: api }));

import type { PanelPageContext } from "@ktb/kernel";

import type { PromptCard } from "./prompts.ts";
import { PromptsPanelPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const prompt = (over: Partial<PromptCard> = {}): PromptCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	name: "anamnesis.extract",
	version: 1,
	locale: "",
	template: "Extract the anamnesis.",
	variables: [{ name: "transcript", required: true }],
	modelHint: null,
	isSystem: true,
	isDefault: false,
	enabled: true,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: null,
	...over,
});

afterEach(cleanup);

describe("PromptsPanelPage", () => {
	it("renders loader cards", () => {
		render(<PromptsPanelPage data={[prompt()]} ctx={ctx} />);
		expect(screen.getByText("anamnesis.extract")).toBeTruthy();
	});

	it("tolerates missing or malformed loader data", () => {
		render(<PromptsPanelPage data={undefined} ctx={ctx} />);
		expect(screen.getByText("No prompts yet — seed the first registry entry.")).toBeTruthy();
		cleanup();
		render(<PromptsPanelPage data="nope" ctx={ctx} />);
		expect(screen.getByText("No prompts yet — seed the first registry entry.")).toBeTruthy();
	});
});
