// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
}));

vi.mock("./fns.ts", () => ({
	adminDeleteWizardDefFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	adminSaveWizardDefFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	adminSetWizardPublishedFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

import { definePlugin } from "@ktb/kernel";
import type { PanelPageContext } from "@ktb/kernel";

import { wizardDefContribution, type WizardDefinition } from "./definition.ts";
import { WizardsAdminConsolePage } from "./platform-page.tsx";
import type { WizardDefWire } from "./fns.ts";
import type { Json } from "effect/Schema";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const DEF: WizardDefinition = {
	id: "intake",
	title: "Intake",
	steps: [{ kind: "info", id: "s" }],
};

const row = (over: Partial<WizardDefWire> = {}): WizardDefWire => ({
	key: "intake",
	title: "Intake",
	description: "",
	definition: DEF as unknown as Json,
	published: true,
	updatedAt: "2024-01-02T03:04:05.000Z",
	...over,
});

const contributor = definePlugin({
	id: "clinic.intake",
	contributions: [wizardDefContribution({ ...DEF, id: "code-wiz" })],
});

afterEach(cleanup);

describe("WizardsAdminConsolePage", () => {
	it("renders the empty console when loader data is missing", () => {
		render(<WizardsAdminConsolePage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Wizards")).toBeTruthy();
		expect(screen.getAllByText("No wizard definitions yet.").length).toBeGreaterThan(0);
	});

	it("narrows loader rows into the admin view", () => {
		render(<WizardsAdminConsolePage data={[row({})]} ctx={ctx} />);
		expect(screen.getByText("intake")).toBeTruthy();
		expect(screen.getAllByText("Published").length).toBeGreaterThan(0);
	});

	it("drops malformed rows and survives non-array data", () => {
		render(
			<WizardsAdminConsolePage
				data={[row({}), { nope: true }, "x", null, { key: "k" }]}
				ctx={ctx}
			/>,
		);
		expect(screen.getAllByText("intake")).toHaveLength(1);
		cleanup();
		render(<WizardsAdminConsolePage data="garbage" ctx={ctx} />);
		expect(screen.getAllByText("No wizard definitions yet.").length).toBeGreaterThan(0);
	});

	it("lists code-contributed defs from ctx.plugins", () => {
		render(<WizardsAdminConsolePage data={[]} ctx={{ ...ctx, plugins: [contributor] }} />);
		expect(screen.getByText("code-wiz")).toBeTruthy();
		expect(screen.getByText("clinic.intake")).toBeTruthy();
	});
});
