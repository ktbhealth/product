// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => Promise<void>>(async () => {}) }),
}));

type FnMock = (arg: { data: unknown }) => Promise<unknown>;
const fns = vi.hoisted(() => ({
	i18nDiscardDraftFn: vi.fn<FnMock>(async () => ({ ok: true })),
	i18nExportFn: vi.fn<FnMock>(async () => ({ version: 1, namespace: "app", messages: {} })),
	i18nImportFn: vi.fn<FnMock>(async () => ({ ok: true, imported: 2 })),
	i18nNamespaceMessagesFn: vi.fn<FnMock>(async () => [] as unknown[]),
	i18nPublishFn: vi.fn<FnMock>(async () => ({ ok: true })),
	i18nSaveDraftFn: vi.fn<FnMock>(async () => ({ ok: true })),
	i18nSetLocaleFn: vi.fn<FnMock>(async () => ({ ok: true })),
}));
vi.mock("../fns.ts", () => fns);

import type { I18nMessage } from "../schema.ts";

import type { I18nPageData } from "./I18nPage.tsx";
import { I18nPage } from "./I18nPage.tsx";

const msg = (over: Partial<I18nMessage>): I18nMessage => ({
	namespace: "app",
	key: "alpha",
	locale: "en",
	scope: "global",
	scopeId: "",
	kind: "text",
	value: "Alpha EN",
	draftValue: null,
	status: "published",
	params: [],
	version: 1,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	...over,
});

// Two keys × two enabled non-qps locales (en, pt-BR) — keys sort to
// [alpha, beta], locale columns follow data.locales order.
const ROWS: I18nMessage[] = [
	msg({}),
	msg({ locale: "pt-BR", value: "Alpha PT" }),
	msg({ key: "beta", value: "Beta EN" }),
	msg({ key: "beta", locale: "pt-BR", value: "Beta PT" }),
];

const data: I18nPageData = {
	namespaces: [{ namespace: "app", pluginId: "app", defaultLocale: "en", messageCount: 4 }],
	locales: [
		{ code: "en", endonym: "English", fallbacks: [], enabled: true },
		{ code: "pt-BR", endonym: "Português", fallbacks: ["en"], enabled: true },
		{ code: "qps", endonym: "Pseudo", fallbacks: [], enabled: true },
	],
};

beforeEach(() => {
	fns.i18nNamespaceMessagesFn.mockResolvedValue(ROWS);
	Object.values(fns).forEach((fn) => fn.mockClear());
	fns.i18nNamespaceMessagesFn.mockResolvedValue(ROWS);
});

afterEach(cleanup);

const cellButton = async (key: string, locale = "en") => {
	const row = (await screen.findByText(key)).closest("tr")!;
	return within(row).getAllByRole("button")[locale === "en" ? 0 : 1]!;
};

describe("I18nPage keyboard navigation", () => {
	it("keeps exactly one cell tabbable — the first cell by default", async () => {
		render(<I18nPage data={data} />);
		const alphaEn = await cellButton("alpha");
		const alphaPt = await cellButton("alpha", "pt-BR");
		const betaEn = await cellButton("beta");
		const betaPt = await cellButton("beta", "pt-BR");
		expect(alphaEn.tabIndex).toBe(0);
		expect(alphaPt.tabIndex).toBe(-1);
		expect(betaEn.tabIndex).toBe(-1);
		expect(betaPt.tabIndex).toBe(-1);
	});

	it("moves DOM focus across locale columns and key rows with arrow keys", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		const alphaEn = await cellButton("alpha");
		const alphaPt = await cellButton("alpha", "pt-BR");
		const betaPt = await cellButton("beta", "pt-BR");
		alphaEn.focus();
		await user.keyboard("{ArrowRight}");
		expect(document.activeElement).toBe(alphaPt);
		expect(alphaPt.tabIndex).toBe(0);
		expect(alphaEn.tabIndex).toBe(-1);
		await user.keyboard("{ArrowDown}");
		expect(document.activeElement).toBe(betaPt);
		await user.keyboard("{ArrowUp}");
		expect(document.activeElement).toBe(alphaPt);
		await user.keyboard("{ArrowLeft}");
		expect(document.activeElement).toBe(alphaEn);
	});

	it("stops at grid edges instead of wrapping", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		const alphaEn = await cellButton("alpha");
		alphaEn.focus();
		// Top-left corner: both arrows are no-ops.
		await user.keyboard("{ArrowLeft}");
		await user.keyboard("{ArrowUp}");
		expect(document.activeElement).toBe(alphaEn);
		expect(alphaEn.tabIndex).toBe(0);
		// Bottom-right corner: ArrowRight/ArrowDown are no-ops.
		const betaPt = await cellButton("beta", "pt-BR");
		betaPt.focus();
		await user.keyboard("{ArrowRight}");
		await user.keyboard("{ArrowDown}");
		expect(document.activeElement).toBe(betaPt);
	});

	it("opens the edit dialog on Enter, same as a click", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		const betaPt = await cellButton("beta", "pt-BR");
		betaPt.focus();
		await user.keyboard("{Enter}");
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("app.beta")).toBeTruthy();
		expect((within(dialog).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Beta PT");
	});

	it("makes a clicked cell the tabbable active cell", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		const betaPt = await cellButton("beta", "pt-BR");
		await user.click(betaPt);
		expect(betaPt.tabIndex).toBe(0);
		expect((await cellButton("alpha")).tabIndex).toBe(-1);
	});

	it("ignores grid keys while an inline edit input has focus", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		const alphaEn = await cellButton("alpha");
		await user.dblClick(alphaEn);
		const input = await screen.findByRole("textbox", { name: "Edit alpha in en" });
		await user.keyboard("{ArrowRight}{ArrowDown}");
		// No grid move, no dialog — the input keeps its own key handling.
		expect(document.activeElement).toBe(input);
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("textbox", { name: "Edit alpha in en" })).toBeNull();
	});

	it("navigates nothing when the namespace has no rows", async () => {
		fns.i18nNamespaceMessagesFn.mockResolvedValueOnce([]);
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		expect(await screen.findByText("No messages in this namespace yet.")).toBeTruthy();
		// Only the toolbar buttons exist — no cell buttons to focus.
		expect(screen.getAllByRole("button")).toHaveLength(2);
		await user.keyboard("{ArrowRight}{Enter}");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("horizontal arrows no-op with a single locale column", async () => {
		const user = userEvent.setup();
		render(
			<I18nPage
				data={{
					...data,
					locales: data.locales.filter((l) => l.code === "en"),
				}}
			/>,
		);
		const alphaEn = await cellButton("alpha");
		alphaEn.focus();
		await user.keyboard("{ArrowRight}");
		expect(document.activeElement).toBe(alphaEn);
		// Vertical nav still works.
		await user.keyboard("{ArrowDown}");
		expect(document.activeElement).toBe(await cellButton("beta"));
	});

	it("ignores grid keys on cell buttons while the edit dialog is open", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		const alphaEn = await cellButton("alpha");
		const alphaPt = await cellButton("alpha", "pt-BR");
		alphaEn.focus();
		await user.keyboard("{Enter}");
		await screen.findByRole("dialog");
		// The grid stays mounted behind the dialog — a synthetic keydown
		// on another cell button must not move focus or open anything.
		fireEvent.keyDown(alphaPt, { key: "ArrowRight" });
		expect(document.activeElement).not.toBe(alphaPt);
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("ignores grid keys on cell buttons while an inline edit is open", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		const alphaEn = await cellButton("alpha");
		await user.dblClick(alphaEn);
		const input = await screen.findByRole("textbox", { name: "Edit alpha in en" });
		const betaPt = await cellButton("beta", "pt-BR");
		fireEvent.keyDown(betaPt, { key: "ArrowLeft" });
		expect(document.activeElement).toBe(input);
		expect(screen.getByRole("textbox", { name: "Edit alpha in en" })).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("ignores keys that are not arrows or Enter", async () => {
		render(<I18nPage data={data} />);
		const alphaEn = await cellButton("alpha");
		alphaEn.focus();
		fireEvent.keyDown(alphaEn, { key: "x" });
		expect(document.activeElement).toBe(alphaEn);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("resets tabbable focus gracefully when the scope empties the grid", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await cellButton("alpha");
		// Switch to tenant scope without an id — the grid empties.
		await user.click(screen.getAllByRole("combobox")[1]!);
		await user.click(await screen.findByRole("option", { name: "tenant" }));
		expect(await screen.findByText(/Enter a tenant id/)).toBeTruthy();
		// Back to global — the first cell is tabbable again.
		await user.click(screen.getAllByRole("combobox")[1]!);
		await user.click(await screen.findByRole("option", { name: "global" }));
		await waitFor(async () => {
			expect((await cellButton("alpha")).tabIndex).toBe(0);
		});
	});
});
