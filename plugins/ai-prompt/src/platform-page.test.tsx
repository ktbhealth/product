// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fns.ts", () => ({
	promptsCreateFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
	promptsUpdateFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
	promptsRemoveFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { PromptCard } from "./prompts.ts";
import { PromptsPanelPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const card = (over: Partial<PromptCard> = {}): PromptCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	name: "anamnesis.extract",
	version: 1,
	locale: "",
	template: "Extract the anamnesis.",
	variables: [],
	modelHint: null,
	isSystem: false,
	isDefault: false,
	enabled: true,
	createdAt: new Date(0),
	updatedAt: null,
	...over,
});

afterEach(cleanup);

describe("PromptsPanelPage", () => {
	it("passes card arrays through to the view", () => {
		render(
			<PromptsPanelPage
				data={[card(), card({ id: 2, name: "eval.judge", version: 2 })]}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("anamnesis.extract")).toBeTruthy();
		expect(screen.getByText("eval.judge")).toBeTruthy();
	});

	it("narrows non-array loader data to an empty list", () => {
		render(<PromptsPanelPage data={{ nope: true }} ctx={ctx} />);
		expect(screen.getByText(/No prompts yet/)).toBeTruthy();
	});
});
