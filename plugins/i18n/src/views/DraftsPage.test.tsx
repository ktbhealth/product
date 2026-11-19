// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
	invalidate: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => router,
}));

type FnMock = (arg: { data: unknown }) => Promise<unknown>;
const fns = vi.hoisted(() => ({
	i18nPublishFn: vi.fn<FnMock>(async () => ({ ok: true })),
	i18nDiscardDraftFn: vi.fn<FnMock>(async () => ({ ok: true })),
}));
vi.mock("../fns.ts", () => fns);

import type { I18nMessage } from "../schema.ts";
import type { DraftsPageData } from "./DraftsPage.tsx";
import { DraftsPage } from "./DraftsPage.tsx";

const msg = (over: Partial<I18nMessage>): I18nMessage => ({
	namespace: "patients",
	key: "title",
	locale: "pt-BR",
	scope: "global",
	scopeId: "",
	kind: "text",
	value: "Título",
	draftValue: "Título (rascunho)",
	status: "published",
	params: [],
	version: 1,
	createdAt: new Date("2025-01-01T00:00:00Z"),
	updatedAt: new Date("2025-01-02T00:00:00Z"),
	...over,
});

const data: DraftsPageData = {
	locales: [
		{ code: "en", endonym: "English", fallbacks: [], enabled: true },
		{ code: "pt-BR", endonym: "Português", fallbacks: ["en"], enabled: true },
		{ code: "fr", endonym: "Français", fallbacks: ["en"], enabled: false },
	],
	drafts: [
		msg({}),
		msg({
			namespace: "platform",
			key: "header.cta",
			locale: "en",
			scope: "tenant",
			scopeId: "acme",
			kind: "rich",
			value: "",
			draftValue: "<b>Go</b>",
		}),
	],
};

beforeEach(() => {
	Object.values(fns).forEach((fn) => fn.mockClear());
	router.invalidate.mockClear();
	fns.i18nPublishFn.mockResolvedValue({ ok: true });
	fns.i18nDiscardDraftFn.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("DraftsPage", () => {
	it("renders every draft with namespace.key, locale, scope, live and draft values", async () => {
		render(<DraftsPage data={data} />);
		expect(await screen.findByText("patients")).toBeTruthy();
		expect(screen.getByText("platform")).toBeTruthy();
		expect(screen.getByText("Português")).toBeTruthy();
		expect(screen.getAllByText("pt-BR").length).toBeGreaterThan(0);
		expect(screen.getByText("global")).toBeTruthy();
		expect(screen.getByText("tenant:acme")).toBeTruthy();
		// Live value vs draft value; the never-published rich row has no live copy.
		expect(screen.getByText("Título")).toBeTruthy();
		expect(screen.getByText("Título (rascunho)")).toBeTruthy();
		expect(screen.getByText("—")).toBeTruthy();
		expect(screen.getByText("<b>Go</b>")).toBeTruthy();
		expect(screen.getByText("rich")).toBeTruthy();
	});

	it("narrows rows by namespace.key substring via the filter input", async () => {
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		await user.type(screen.getByPlaceholderText("Filter by namespace.key"), "platform");
		expect(screen.queryByText("patients")).toBeNull();
		expect(await screen.findByText("platform")).toBeTruthy();
		await user.clear(screen.getByPlaceholderText("Filter by namespace.key"));
		await user.type(screen.getByPlaceholderText("Filter by namespace.key"), "nomatch");
		expect(await screen.findByText("No pending drafts.")).toBeTruthy();
	});

	it("shows the empty state with no drafts", async () => {
		render(<DraftsPage data={{ drafts: [], locales: data.locales }} />);
		expect(await screen.findByText("No pending drafts.")).toBeTruthy();
	});

	it("publishes a draft through i18nPublishFn and invalidates the router", async () => {
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		await user.click(screen.getAllByRole("button", { name: "Publish" })[0]);
		await waitFor(() =>
			expect(fns.i18nPublishFn).toHaveBeenCalledWith({
				data: {
					namespace: "patients",
					key: "title",
					locale: "pt-BR",
					scope: "global",
					scopeId: "",
				},
			}),
		);
		expect(await screen.findByText("Published patients.title (pt-BR).")).toBeTruthy();
		expect(router.invalidate).toHaveBeenCalled();
	});

	it("surfaces publish errors and bare denials", async () => {
		fns.i18nPublishFn
			.mockResolvedValueOnce({ ok: false, error: "boom" })
			.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		await user.click(screen.getAllByRole("button", { name: "Publish" })[0]);
		expect(await screen.findByText("boom")).toBeTruthy();
		// A bare { ok:false } falls back to the generic denial text.
		await user.click(screen.getAllByRole("button", { name: "Publish" })[1]);
		expect(await screen.findByText("denied")).toBeTruthy();
		expect(router.invalidate).not.toHaveBeenCalled();
	});

	it("discards a draft through i18nDiscardDraftFn", async () => {
		fns.i18nDiscardDraftFn.mockResolvedValueOnce({ ok: false, error: "nope" });
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		await user.click(screen.getAllByRole("button", { name: "Discard" })[0]);
		expect(await screen.findByText("nope")).toBeTruthy();
		expect(fns.i18nDiscardDraftFn).toHaveBeenCalledWith({
			data: {
				namespace: "patients",
				key: "title",
				locale: "pt-BR",
				scope: "global",
				scopeId: "",
			},
		});
		// Success path reports the discard and refreshes.
		await user.click(screen.getAllByRole("button", { name: "Discard" })[0]);
		expect(await screen.findByText("Discarded draft for patients.title (pt-BR).")).toBeTruthy();
		expect(router.invalidate).toHaveBeenCalled();
	});

	it("hides the bulk toolbar until at least one row is selected", async () => {
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		expect(screen.queryByRole("button", { name: /selected/ })).toBeNull();
	});

	it("select-all checkbox selects every visible row and shows indeterminate on partial selection", async () => {
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		const selectAll = screen.getByRole("checkbox", { name: "Select all visible drafts" });
		expect(selectAll.getAttribute("aria-checked")).toBe("false");

		// Partial selection → header goes indeterminate.
		await user.click(screen.getByRole("checkbox", { name: "Select patients.title (pt-BR)" }));
		expect(selectAll.getAttribute("aria-checked")).toBe("mixed");
		expect(screen.getByRole("button", { name: "Publish 1 selected" })).toBeTruthy();

		// Select-all checks every visible row.
		await user.click(selectAll);
		expect(selectAll.getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("button", { name: "Publish 2 selected" })).toBeTruthy();

		// Toggling again clears the visible selection.
		await user.click(selectAll);
		expect(selectAll.getAttribute("aria-checked")).toBe("false");
		expect(screen.queryByRole("button", { name: /selected/ })).toBeNull();
	});

	it("select-all respects the namespace.key filter", async () => {
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		await user.type(screen.getByPlaceholderText("Filter by namespace.key"), "platform");
		await user.click(screen.getByRole("checkbox", { name: "Select all visible drafts" }));
		expect(screen.getByRole("button", { name: "Publish 1 selected" })).toBeTruthy();
		expect(
			screen
				.getByRole("checkbox", { name: "Select platform.header.cta (en)" })
				.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("bulk publish calls i18nPublishFn once per selected row, reports, invalidates and clears", async () => {
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		await user.click(screen.getByRole("checkbox", { name: "Select all visible drafts" }));
		await user.click(screen.getByRole("button", { name: "Publish 2 selected" }));

		await waitFor(() => expect(fns.i18nPublishFn).toHaveBeenCalledTimes(2));
		expect(fns.i18nPublishFn).toHaveBeenNthCalledWith(1, {
			data: {
				namespace: "patients",
				key: "title",
				locale: "pt-BR",
				scope: "global",
				scopeId: "",
			},
		});
		expect(fns.i18nPublishFn).toHaveBeenNthCalledWith(2, {
			data: {
				namespace: "platform",
				key: "header.cta",
				locale: "en",
				scope: "tenant",
				scopeId: "acme",
			},
		});
		expect(await screen.findByText("Published 2 drafts.")).toBeTruthy();
		expect(router.invalidate).toHaveBeenCalled();
		// Selection cleared — toolbar hides and checkboxes uncheck.
		expect(screen.queryByRole("button", { name: /selected/ })).toBeNull();
		expect(
			screen
				.getByRole("checkbox", { name: "Select patients.title (pt-BR)" })
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("bulk publish reports partial failures with the first error and still processes every row", async () => {
		fns.i18nPublishFn
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: false, error: "nope" });
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		await user.click(screen.getByRole("checkbox", { name: "Select all visible drafts" }));
		await user.click(screen.getByRole("button", { name: "Publish 2 selected" }));

		expect(await screen.findByText("Published 1, failed 1 — nope.")).toBeTruthy();
		expect(fns.i18nPublishFn).toHaveBeenCalledTimes(2);
		expect(router.invalidate).toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: /selected/ })).toBeNull();
	});

	it("bulk discard asks for confirmation, then calls i18nDiscardDraftFn per row", async () => {
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		await user.click(screen.getByRole("checkbox", { name: "Select all visible drafts" }));
		await user.click(screen.getByRole("button", { name: "Discard 2 selected" }));

		// Confirm dialog gates the destructive batch.
		const dialog = await screen.findByRole("alertdialog");
		expect(fns.i18nDiscardDraftFn).not.toHaveBeenCalled();
		await user.click(within(dialog).getByRole("button", { name: "Discard" }));

		await waitFor(() => expect(fns.i18nDiscardDraftFn).toHaveBeenCalledTimes(2));
		expect(fns.i18nDiscardDraftFn).toHaveBeenNthCalledWith(1, {
			data: {
				namespace: "patients",
				key: "title",
				locale: "pt-BR",
				scope: "global",
				scopeId: "",
			},
		});
		expect(await screen.findByText("Discarded 2 drafts.")).toBeTruthy();
		expect(router.invalidate).toHaveBeenCalled();
	});

	it("bulk discard cancel leaves the selection untouched and calls nothing", async () => {
		const user = userEvent.setup();
		render(<DraftsPage data={data} />);
		await screen.findByText("patients");
		await user.click(screen.getByRole("checkbox", { name: "Select all visible drafts" }));
		await user.click(screen.getByRole("button", { name: "Discard 2 selected" }));

		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(fns.i18nDiscardDraftFn).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Discard 2 selected" })).toBeTruthy();
	});
});
