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
	key: "title",
	locale: "en",
	scope: "global",
	scopeId: "",
	kind: "text",
	value: "Hello",
	draftValue: null,
	status: "published",
	params: [],
	version: 1,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	...over,
});

const PARAMS_LIVE = "Hello {name}, you have {count} msgs";

const ROWS: I18nMessage[] = [
	msg({}),
	msg({ locale: "pt-BR", value: "Olá", draftValue: "Oi" }),
	msg({ key: "params", value: PARAMS_LIVE }),
	msg({ key: "broken", value: "{unclosed" }),
	msg({ key: "rich", kind: "rich", value: "<p>Hi</p>" }),
];

const data: I18nPageData = {
	namespaces: [{ namespace: "app", pluginId: "app", defaultLocale: "en", messageCount: 5 }],
	locales: [
		{ code: "en", endonym: "English", fallbacks: [], enabled: true },
		{ code: "pt-BR", endonym: "Português", fallbacks: ["en"], enabled: true },
		{ code: "fr", endonym: "Français", fallbacks: ["en"], enabled: false },
		{ code: "qps", endonym: "Pseudo", fallbacks: [], enabled: true },
	],
};

beforeEach(() => {
	fns.i18nNamespaceMessagesFn.mockResolvedValue(ROWS);
	Object.values(fns).forEach((fn) => fn.mockClear());
	fns.i18nNamespaceMessagesFn.mockResolvedValue(ROWS);
});

afterEach(cleanup);

const openCell = async (user: ReturnType<typeof userEvent.setup>, key: string, locale = "en") => {
	const row = (await screen.findByText(key)).closest("tr")!;
	const cells = within(row).getAllByRole("button");
	// Columns follow data.locales order filtered to enabled non-qps: en, pt-BR.
	await user.click(cells[locale === "en" ? 0 : 1]!);
};

const cellButton = async (key: string, locale = "en") => {
	const row = (await screen.findByText(key)).closest("tr")!;
	return within(row).getAllByRole("button")[locale === "en" ? 0 : 1]!;
};

describe("I18nPage compare-with-locale", () => {
	it("shows the other locale's draft-or-live value by default", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await openCell(user, "title");
		const dialog = await screen.findByRole("dialog");
		// Editing `en`; the only other enabled locale is pt-BR, whose
		// pending draft "Oi" wins over live "Olá" — same resolution as
		// the matrix cells.
		expect(await within(dialog).findByText("Português (pt-BR)")).toBeTruthy();
		expect(within(dialog).getByText("Oi")).toBeTruthy();
		expect(within(dialog).getByText("draft")).toBeTruthy();
	});

	it("hides the reference panel when None is picked", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await openCell(user, "title");
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Português (pt-BR)");
		await user.click(within(dialog).getByRole("combobox", { name: "Compare with" }));
		await user.click(await screen.findByRole("option", { name: "None" }));
		await waitFor(() => expect(within(dialog).queryByText("Português (pt-BR)")).toBeNull());
	});

	it("shows an empty state when the compared locale has no row", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("broken");
		await openCell(user, "broken");
		const dialog = await screen.findByRole("dialog");
		// `broken` only has an en row — pt-BR comparison is absent.
		expect(await within(dialog).findByText("No translation for pt-BR.")).toBeTruthy();
	});
});

describe("I18nPage param lint", () => {
	it("warns on diverging params and stays quiet when they match", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("params");
		await openCell(user, "params");
		const dialog = await screen.findByRole("dialog");
		const area = within(dialog).getByRole("textbox") as HTMLTextAreaElement;
		// Draft == live → sets match → no warning.
		expect(within(dialog).queryByText(/Param mismatch/)).toBeNull();
		fireEvent.change(area, { target: { value: "Hello {name} only" } });
		expect(await within(dialog).findByText(/Param mismatch/)).toBeTruthy();
		expect(within(dialog).getByText(/missing: \{count\}/)).toBeTruthy();
		expect(within(dialog).queryByText(/extra:/)).toBeNull();
	});
});

describe("I18nPage inline cell editing", () => {
	it("double-click enters edit mode and Enter commits a text draft", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const cell = await cellButton("title");
		await user.dblClick(cell);
		const input = (await screen.findByRole("textbox", {
			name: "Edit title in en",
		})) as HTMLInputElement;
		expect(input.value).toBe("Hello");
		// The deferred single-click open must not have fired.
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.clear(input);
		await user.type(input, "Hi");
		await user.keyboard("{Enter}");
		await waitFor(() =>
			expect(fns.i18nSaveDraftFn).toHaveBeenCalledWith({
				data: {
					namespace: "app",
					key: "title",
					locale: "en",
					scope: "global",
					scopeId: "",
					value: "Hi",
					kind: "text",
				},
			}),
		);
		await waitFor(() =>
			expect(screen.queryByRole("textbox", { name: "Edit title in en" })).toBeNull(),
		);
	});

	it("Escape cancels inline edit without saving", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const cell = await cellButton("title");
		await user.dblClick(cell);
		const input = await screen.findByRole("textbox", { name: "Edit title in en" });
		await user.type(input, "changed");
		await user.keyboard("{Escape}");
		expect(fns.i18nSaveDraftFn).not.toHaveBeenCalled();
		expect(screen.queryByRole("textbox", { name: "Edit title in en" })).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("blur commits the inline edit", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const cell = await cellButton("title");
		await user.dblClick(cell);
		const input = (await screen.findByRole("textbox", {
			name: "Edit title in en",
		})) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "Blurred" } });
		fireEvent.blur(input);
		await waitFor(() =>
			expect(fns.i18nSaveDraftFn).toHaveBeenCalledWith({
				data: {
					namespace: "app",
					key: "title",
					locale: "en",
					scope: "global",
					scopeId: "",
					value: "Blurred",
					kind: "text",
				},
			}),
		);
	});

	it("does not offer inline editing on rich-kind cells", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("rich");
		const cell = await cellButton("rich");
		await user.dblClick(cell);
		// Rich cells keep the deferred single-click path → dialog opens.
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByLabelText("Message rich text")).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "Edit rich in en" })).toBeNull();
	});
});
