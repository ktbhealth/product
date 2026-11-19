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

const PARAMS_TEMPLATE =
	"{n, number} {d, date} {dt, datetime} {r, relative} {l, list} {p, plural, one {item} other {items}} {s, select, a {A} other {Other}} {o, select, other {Only}} {x}";

const ROWS: I18nMessage[] = [
	msg({}),
	msg({ locale: "pt-BR", value: "Olá", draftValue: "Oi" }),
	msg({ key: "params", value: PARAMS_TEMPLATE }),
	msg({ key: "broken", value: "{unclosed" }),
	msg({ key: "rich", kind: "rich", value: "<p>Hi</p>" }),
	msg({ key: "scoped", scope: "tenant", scopeId: "t1", value: "Scoped" }),
];

const data: I18nPageData = {
	namespaces: [{ namespace: "app", pluginId: "app", defaultLocale: "en", messageCount: 6 }],
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

describe("I18nPage", () => {
	it("renders the matrix with enabled non-qps locale columns", async () => {
		render(<I18nPage data={data} />);
		expect(await screen.findByText("title")).toBeTruthy();
		// pt-BR cell carries a pending draft — it wins over the live value.
		expect(await screen.findByText("Oi")).toBeTruthy();
		expect(screen.getAllByText("draft").length).toBeGreaterThan(0);
		// qps is pseudo-localized at slice time — it never gets a matrix
		// column (locale administration lives on /platform/i18n/locales).
		expect(screen.queryByRole("columnheader", { name: "Pseudo" })).toBeNull();
	});

	it("shows a page-level error when a fetch-independent action fails", async () => {
		fns.i18nExportFn.mockResolvedValueOnce(null);
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await user.click(screen.getByRole("button", { name: "Export" }));
		expect(await screen.findByText("export denied")).toBeTruthy();
	});

	it("downloads the export payload on success", async () => {
		const createObjectURL = vi.fn<() => string>(() => "blob:x");
		const revokeObjectURL = vi.fn<(url: string) => void>();
		URL.createObjectURL = createObjectURL;
		URL.revokeObjectURL = revokeObjectURL;
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await user.click(screen.getByRole("button", { name: "Export" }));
		await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
		expect(click).toHaveBeenCalled();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:x");
	});

	it("switches the namespace selector", async () => {
		const user = userEvent.setup();
		render(
			<I18nPage
				data={{
					...data,
					namespaces: [
						...data.namespaces,
						{ namespace: "billing", pluginId: "billing", defaultLocale: "en", messageCount: 0 },
					],
				}}
			/>,
		);
		await screen.findByText("title");
		await user.click(screen.getAllByRole("combobox")[0]!);
		await user.click(await screen.findByRole("option", { name: /billing/ }));
		await waitFor(() =>
			expect(fns.i18nNamespaceMessagesFn).toHaveBeenCalledWith({
				data: { namespace: "billing", scope: "global", scopeId: "" },
			}),
		);
	});

	it("opens a cell dialog and saves a draft", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await openCell(user, "title");
		const dialog = await screen.findByRole("dialog");
		const area = within(dialog).getByRole("textbox") as HTMLTextAreaElement;
		expect(area.value).toBe("Hello");
		fireEvent.change(area, { target: { value: "Hi {name}" } });
		// The post-save refresh tolerates a non-array response.
		fns.i18nNamespaceMessagesFn.mockResolvedValueOnce({} as never);
		await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
		await waitFor(() =>
			expect(fns.i18nSaveDraftFn).toHaveBeenCalledWith({
				data: {
					namespace: "app",
					key: "title",
					locale: "en",
					scope: "global",
					scopeId: "",
					value: "Hi {name}",
					kind: "text",
				},
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("confirms before discarding a dirty draft, keeps editing on cancel", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await openCell(user, "title");
		let dialog = await screen.findByRole("dialog");
		const area = within(dialog).getByRole("textbox");
		await user.type(area, " changed");
		await user.keyboard("{Escape}");
		// Dirty → confirm dialog instead of silent close.
		expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Keep editing" }));
		dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByRole("textbox")).toBeTruthy();
		// Escape again → confirm → Discard closes for real.
		await user.keyboard("{Escape}");
		await user.click(await screen.findByRole("button", { name: "Discard" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("closes cleanly without confirm when the draft is untouched", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await openCell(user, "title");
		await screen.findByRole("dialog");
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
	});

	it("shows save failures at page level and inside the dialog", async () => {
		fns.i18nSaveDraftFn
			.mockResolvedValueOnce({ ok: false, error: "denied!" })
			.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await openCell(user, "title");
		const dialog = await screen.findByRole("dialog");
		const save = within(dialog).getByRole("button", { name: "Save draft" });
		await user.click(save);
		await waitFor(() => expect(screen.getAllByText("denied!").length).toBeGreaterThan(0));
		// A bare { ok:false } falls back to the generic "denied" label.
		await user.click(save);
		expect(await screen.findAllByText("denied")).not.toHaveLength(0);
	});

	it("ignores non-array fetch results and unmount races", async () => {
		// Mount fetch resolves to a non-array → rows stay empty.
		fns.i18nNamespaceMessagesFn.mockResolvedValueOnce({} as never);
		const first = render(<I18nPage data={data} />);
		expect(await screen.findByText("No messages in this namespace yet.")).toBeTruthy();
		first.unmount();
		cleanup();
		// A fetch still in flight at unmount must not set state.
		let resolveFetch: (v: unknown) => void = () => {};
		fns.i18nNamespaceMessagesFn.mockImplementation(
			() =>
				new Promise((res) => {
					resolveFetch = res;
				}),
		);
		const second = render(<I18nPage data={data} />);
		second.unmount();
		resolveFetch(ROWS);
		await waitFor(() => expect(fns.i18nNamespaceMessagesFn).toHaveBeenCalled());
	});

	it("renders param hints and preview samples, and surfaces parse errors", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("params");
		await openCell(user, "params");
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/\{n\} · number/)).toBeTruthy();
		expect(within(dialog).getByText(/\{p\} · plural/)).toBeTruthy();
		expect(within(dialog).getByText(/\{s\} · select/)).toBeTruthy();
		// The pt-BR cell for `params` has no row — opening it yields an
		// empty draft.
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await openCell(user, "params", "pt-BR");
		const empty = await screen.findByRole("dialog");
		expect((within(empty).getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
	});

	it("shows the parse error for a broken template", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("broken");
		await openCell(user, "broken");
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("unclosed '{' at offset 0")).toBeTruthy();
	});

	it("opens a rich-kind cell in the rich editor and keeps it rich across retargets", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("rich");
		await openCell(user, "rich");
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByLabelText("Rich text preview")).toBeTruthy();
		// Round-trip the scope selector away and back — the global cell
		// is rich, so the editor must stay rich.
		await user.click(within(dialog).getAllByRole("combobox")[0]!);
		await user.click(await screen.findByRole("option", { name: "tenant" }));
		await user.click(within(dialog).getAllByRole("combobox")[0]!);
		await user.click(await screen.findByRole("option", { name: "global" }));
		expect(within(dialog).getByLabelText("Message rich text")).toBeTruthy();
	});

	it("offers discard + publish for cells with a pending draft", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		// pt-BR cell has draftValue "Oi".
		const row = screen.getByText("title").closest("tr")!;
		await user.click(within(row).getAllByRole("button")[1]!);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/draft pending/)).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Publish" }));
		await waitFor(() =>
			expect(fns.i18nPublishFn).toHaveBeenCalledWith({
				data: {
					namespace: "app",
					key: "title",
					locale: "pt-BR",
					scope: "global",
					scopeId: "",
				},
			}),
		);
	});

	it("discards a pending draft", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		const row = screen.getByText("title").closest("tr")!;
		await user.click(within(row).getAllByRole("button")[1]!);
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Discard draft" }));
		await waitFor(() =>
			expect(fns.i18nDiscardDraftFn).toHaveBeenCalledWith({
				data: {
					namespace: "app",
					key: "title",
					locale: "pt-BR",
					scope: "global",
					scopeId: "",
				},
			}),
		);
	});

	it("previews an import file, then imports and confirms", async () => {
		const user = userEvent.setup();
		const { container } = render(<I18nPage data={data} />);
		await screen.findByText("title");
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		// The Import button just forwards the click to the hidden input;
		// an empty selection is a no-op.
		await user.click(screen.getByRole("button", { name: "Import" }));
		fireEvent.change(input, { target: { files: [] } });
		const payload = {
			version: 1,
			namespace: "other",
			messages: { en: { a: "A", b: "B" }, "pt-BR": { a: "Á" } },
		};
		fireEvent.change(input, {
			target: {
				files: [new File([JSON.stringify(payload)], "i18n.json", { type: "application/json" })],
			},
		});
		expect(await screen.findByText(/Import into "other"\?/)).toBeTruthy();
		expect(screen.getByText(/2 locales · 2 keys · 3 entries/)).toBeTruthy();
		expect(fns.i18nImportFn).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Import" }));
		await waitFor(() => expect(fns.i18nImportFn).toHaveBeenCalledWith({ data: payload }));
		expect(await screen.findByText(/Imported 2 entries into other\./)).toBeTruthy();
	});

	it("imports into the selected namespace and refreshes in place", async () => {
		fns.i18nImportFn.mockResolvedValueOnce({ ok: true });
		const user = userEvent.setup();
		const { container } = render(<I18nPage data={data} />);
		await screen.findByText("title");
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		const payload = {
			version: 1,
			namespace: "app",
			messages: { en: { a: "A", b: "B" }, "pt-BR": { a: "Á" } },
		};
		fireEvent.change(input, {
			target: { files: [new File([JSON.stringify(payload)], "i18n.json")] },
		});
		await screen.findByText(/Import into "app"\?/);
		await user.click(screen.getByRole("button", { name: "Import" }));
		// No `imported` count on the wire → falls back to the preview's
		// entry count.
		expect(await screen.findByText("Imported 3 entries into app.")).toBeTruthy();
	});

	it("surfaces import denials at page level", async () => {
		fns.i18nImportFn
			.mockResolvedValueOnce({ ok: false, error: "import exploded" })
			.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		const { container } = render(<I18nPage data={data} />);
		await screen.findByText("title");
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		const file = () =>
			new File(
				[JSON.stringify({ version: 1, namespace: "app", messages: { en: {} } })],
				"i18n.json",
			);
		fireEvent.change(input, { target: { files: [file()] } });
		await screen.findByText(/Import into "app"\?/);
		await user.click(screen.getByRole("button", { name: "Import" }));
		expect(await screen.findByText("import exploded")).toBeTruthy();
		// A bare { ok:false } falls back to the generic denial text.
		fireEvent.change(input, { target: { files: [file()] } });
		await screen.findByText(/Import into "app"\?/);
		await user.click(screen.getByRole("button", { name: "Import" }));
		expect(await screen.findByText("import denied")).toBeTruthy();
	});

	it("refreshes in place even when the scope gate is closed", async () => {
		fns.i18nImportFn.mockResolvedValueOnce({ ok: true, imported: 1 });
		const user = userEvent.setup();
		const { container } = render(<I18nPage data={data} />);
		await screen.findByText("title");
		// Switch to tenant scope without an id — refresh() must no-op.
		await user.click(screen.getAllByRole("combobox")[1]!);
		await user.click(await screen.findByRole("option", { name: "tenant" }));
		await screen.findByText(/Enter a tenant id/);
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [
					new File(
						[JSON.stringify({ version: 1, namespace: "app", messages: { en: { a: "A" } } })],
						"i18n.json",
					),
				],
			},
		});
		await screen.findByText(/Import into "app"\?/);
		await user.click(screen.getByRole("button", { name: "Import" }));
		expect(await screen.findByText("Imported 1 entries into app.")).toBeTruthy();
	});

	it("cancels an import preview without calling the fn", async () => {
		const user = userEvent.setup();
		const { container } = render(<I18nPage data={data} />);
		await screen.findByText("title");
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [new File([JSON.stringify({ namespace: "x", messages: {} })], "i.json")],
			},
		});
		await screen.findByText(/Import into "x"\?/);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByText(/Import into/)).toBeNull());
		expect(fns.i18nImportFn).not.toHaveBeenCalled();
	});

	it("surfaces invalid JSON and malformed payloads as page errors", async () => {
		const { container } = render(<I18nPage data={data} />);
		await screen.findByText("title");
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(["{nope"], "bad.json")] } });
		expect(await screen.findByText("invalid JSON file")).toBeTruthy();
		fireEvent.change(input, { target: { files: [new File(["{}"], "empty.json")] } });
		expect(await screen.findByText("missing namespace")).toBeTruthy();
	});

	it("retargets the dialog to a portal scope with its own scope id", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		await openCell(user, "title");
		const dialog = await screen.findByRole("dialog");
		// First in-dialog combobox is the scope selector.
		await user.click(within(dialog).getAllByRole("combobox")[0]!);
		await user.click(await screen.findByRole("option", { name: "tenant" }));
		const scopeInput = within(dialog).getByPlaceholderText("tenant id");
		await user.type(scopeInput, "t9");
		fireEvent.blur(scopeInput);
		// Switch to portal — different placeholder + the scope id carries over.
		await user.click(within(dialog).getAllByRole("combobox")[0]!);
		await user.click(await screen.findByRole("option", { name: "portal" }));
		const portalInput = within(dialog).getByPlaceholderText("portal instance id");
		expect((portalInput as HTMLInputElement).value).toBe("t9");
		await user.clear(portalInput);
		await user.type(portalInput, "p1");
		fireEvent.blur(portalInput);
		expect(within(dialog).getByText(/:p1/)).toBeTruthy();
		// Kind selector swaps the editor.
		await user.click(within(dialog).getAllByRole("combobox")[1]!);
		await user.click(await screen.findByRole("option", { name: "rich" }));
		expect(within(dialog).getByLabelText("Rich text preview")).toBeTruthy();
	});

	it("scopes the matrix to tenant rows after entering a scope id", async () => {
		const user = userEvent.setup();
		render(<I18nPage data={data} />);
		await screen.findByText("title");
		// Pick "tenant" in the toolbar scope select.
		const triggers = screen.getAllByRole("combobox");
		await user.click(triggers[1]!);
		await user.click(await screen.findByRole("option", { name: "tenant" }));
		// No scope id yet → gate message instead of a fetch.
		expect(await screen.findByText(/Enter a tenant id/)).toBeTruthy();
		await user.type(screen.getByPlaceholderText("tenant id"), "t1");
		await waitFor(() =>
			expect(fns.i18nNamespaceMessagesFn).toHaveBeenCalledWith({
				data: { namespace: "app", scope: "tenant", scopeId: "t1" },
			}),
		);
		// The mock returns the global rows plus one tenant/t1 row — the
		// scope-filtered matrix shows just that row.
		expect(await screen.findByText("Scoped")).toBeTruthy();
		// Portal scope gets its own placeholder.
		await user.click(screen.getAllByRole("combobox")[1]!);
		await user.click(await screen.findByRole("option", { name: "portal" }));
		expect(screen.getByPlaceholderText("portal instance id")).toBeTruthy();
	});
});
