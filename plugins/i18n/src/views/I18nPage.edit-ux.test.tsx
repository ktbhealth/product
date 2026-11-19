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

	it("switches the comparison to an explicitly picked locale", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await openCell(user, "title");
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Português (pt-BR)");
		// Re-picking the locale through the select exercises the
		// non-"None" arm of the picker.
		await user.click(within(dialog).getByRole("combobox", { name: "Compare with" }));
		await user.click(await screen.findByRole("option", { name: "Português" }));
		expect(within(dialog).getByText("Português (pt-BR)")).toBeTruthy();
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

	it("lints params out of a broken draft via the regex fallback", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await openCell(user, "title");
		const dialog = await screen.findByRole("dialog");
		const area = within(dialog).getByRole("textbox");
		// The template doesn't parse, but the fallback regex still sees
		// {count} — flagged extra vs the param-less live value.
		fireEvent.change(area, { target: { value: "{count} {oops" } });
		expect(await within(dialog).findByText(/Param mismatch/)).toBeTruthy();
		expect(within(dialog).getByText(/extra: \{count\}/)).toBeTruthy();
	});

	it("skips lint when the default-locale cell is missing or also empty", async () => {
		const user = userEvent.setup();
		fns.i18nNamespaceMessagesFn.mockResolvedValue([
			// pt-BR-only key with an empty live value — there is no en
			// cell at all to lint against.
			msg({ key: "ptonly", locale: "pt-BR", value: "" }),
			// Both locales carry an empty live value — the default-locale
			// cell exists but can't serve as the lint reference.
			msg({ key: "emptylive", value: "" }),
			msg({ key: "emptylive", locale: "pt-BR", value: "" }),
		]);
		render(<I18nPage data={data} />);
		await screen.findByText("ptonly");
		const ptonlyRow = screen.getByText("ptonly").closest("tr")!;
		await user.click(within(ptonlyRow).getAllByRole("button")[1]!);
		let dialog = await screen.findByRole("dialog");
		expect(within(dialog).queryByText(/Param mismatch/)).toBeNull();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const emptyRow = screen.getByText("emptylive").closest("tr")!;
		await user.click(within(emptyRow).getAllByRole("button")[1]!);
		dialog = await screen.findByRole("dialog");
		expect(within(dialog).queryByText(/Param mismatch/)).toBeNull();
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

	it("enters inline edit on a raw double-click with no armed open timer", async () => {
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const cell = await cellButton("title");
		// No preceding click — there is no deferred dialog open to cancel.
		fireEvent.doubleClick(cell);
		expect(await screen.findByRole("textbox", { name: "Edit title in en" })).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("seeds the inline editor with the pending draft and ignores its own dblclick", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const cell = await cellButton("title", "pt-BR");
		await user.dblClick(cell);
		const input = (await screen.findByRole("textbox", {
			name: "Edit title in pt-BR",
		})) as HTMLInputElement;
		expect(input.value).toBe("Oi");
		// A double-click inside the input just stops propagation.
		fireEvent.doubleClick(input);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByRole("textbox", { name: "Edit title in pt-BR" })).toBeTruthy();
	});

	it("Enter on an unchanged inline value just closes the editor", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const cell = await cellButton("title");
		await user.dblClick(cell);
		await screen.findByRole("textbox", { name: "Edit title in en" });
		await user.keyboard("{Enter}");
		expect(fns.i18nSaveDraftFn).not.toHaveBeenCalled();
		expect(screen.queryByRole("textbox", { name: "Edit title in en" })).toBeNull();
	});

	it("ignores a second commit and Escape while a commit is in flight", async () => {
		let resolveSave: (v: unknown) => void = () => {};
		fns.i18nSaveDraftFn.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveSave = resolve;
				}),
		);
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const cell = await cellButton("title");
		await user.dblClick(cell);
		const input = (await screen.findByRole("textbox", {
			name: "Edit title in en",
		})) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "changed" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(fns.i18nSaveDraftFn).toHaveBeenCalledTimes(1));
		// Mid-commit: a second Enter hits the busy guard, Escape does
		// not cancel the edit.
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(fns.i18nSaveDraftFn).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("textbox", { name: "Edit title in en" })).toBeTruthy();
		resolveSave({ ok: true });
		await waitFor(() =>
			expect(screen.queryByRole("textbox", { name: "Edit title in en" })).toBeNull(),
		);
	});

	it("surfaces inline-commit failures at page level", async () => {
		fns.i18nSaveDraftFn
			.mockResolvedValueOnce({ ok: false, error: "inline denied" })
			.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const cell = await cellButton("title");
		await user.dblClick(cell);
		const input = (await screen.findByRole("textbox", {
			name: "Edit title in en",
		})) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "x" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(await screen.findByText("inline denied")).toBeTruthy();
		// The editor stays open on failure; a bare { ok:false } falls
		// back to the generic denial text.
		fireEvent.keyDown(input, { key: "Enter" });
		expect(await screen.findByText("denied")).toBeTruthy();
	});

	it("treats a null or non-object wire result as a successful commit", async () => {
		fns.i18nSaveDraftFn.mockResolvedValueOnce(null).mockResolvedValueOnce(42);
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const cell = await cellButton("title");
		await user.dblClick(cell);
		const input = (await screen.findByRole("textbox", {
			name: "Edit title in en",
		})) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "x" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() =>
			expect(screen.queryByRole("textbox", { name: "Edit title in en" })).toBeNull(),
		);
		expect(screen.queryByText("denied")).toBeNull();
		// A non-object result (e.g. a bare number) is not a failure
		// either — the editor closes the same way.
		await user.dblClick(await cellButton("title"));
		const second = (await screen.findByRole("textbox", {
			name: "Edit title in en",
		})) as HTMLInputElement;
		fireEvent.change(second, { target: { value: "y" } });
		fireEvent.keyDown(second, { key: "Enter" });
		await waitFor(() =>
			expect(screen.queryByRole("textbox", { name: "Edit title in en" })).toBeNull(),
		);
	});
});
