// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "effect/Schema";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		const chain = {
			validator: () => chain,
			handler: (h: unknown) => h,
		};
		return chain;
	},
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children, ...props }: Record<string, unknown>) => (
		<a href={String(to)} {...props}>
			{children as React.ReactNode}
		</a>
	),
}));

const fns = vi.hoisted(() => ({
	viewQueryFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));
vi.mock("../fns.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../fns.ts")>();
	return { ...actual, viewQueryFn: fns.viewQueryFn };
});

import { definePlugin, type PageContext, type Plugin } from "@ktb/kernel";

import { viewDefContribution, type ViewDef } from "../definition.ts";
import type { ViewDetailWire, ViewListWire, ViewRecordWire } from "../wire.ts";
import { ViewPage } from "./ViewPage.tsx";

const TABLE_DEF: ViewDef = {
	id: "notes",
	title: "Notes",
	collection: "clinic.notes",
	kind: "table",
	fields: [
		{ field: "title", label: "Title", width: "12rem" },
		{ field: "count", format: "text" },
		{ field: "when", format: "date" },
		{ field: "doc", format: "ref", refCollection: "docs.lib", refLabelField: "name" },
	],
	filters: [{ field: "title", op: "$regex" }],
};

const CARDS_DEF: ViewDef = {
	id: "cards",
	title: "Cards",
	collection: "clinic.items",
	kind: "cards",
	cardTitleField: "name",
	fields: [{ field: "name" }, { field: "price", format: "text" }],
	filters: [{ field: "name", op: "$regex" }],
};

const DETAIL_DEF: ViewDef = {
	id: "detail",
	title: "Detail",
	collection: "clinic.items",
	kind: "detail",
	fields: [{ field: "name" }],
	detailFields: [{ field: "name" }, { field: "meta", format: "json" }],
};

// Extra contributed defs for the ctx.plugins resolution paths.
const I18N_DEF: ViewDef = { ...TABLE_DEF, id: "i18nview", title: "custom.title" };
const OTHER_DEF: ViewDef = { ...TABLE_DEF, id: "other", title: "Other" };
const PLAIN_DEF: ViewDef = { ...TABLE_DEF, id: "plain", filters: undefined };
const DETAIL_PLAIN: ViewDef = { ...DETAIL_DEF, id: "plaindetail", detailFields: undefined };
const CARDS_NOMATCH: ViewDef = {
	...CARDS_DEF,
	id: "cards2",
	cardTitleField: "missing.path",
};

const contributor = definePlugin({
	id: "clinic.views",
	contributions: [
		TABLE_DEF,
		CARDS_DEF,
		DETAIL_DEF,
		I18N_DEF,
		OTHER_DEF,
		PLAIN_DEF,
		DETAIL_PLAIN,
		CARDS_NOMATCH,
	].map(viewDefContribution),
});

const rec = (over: Partial<ViewRecordWire> = {}): ViewRecordWire => ({
	id: 1,
	collection: "clinic.notes",
	data: { title: "Hello", count: 3, when: 1714523400000, doc: 7 } as Record<string, Json>,
	createdAt: "2024-01-01T00:00:00.000Z",
	updatedAt: "2024-01-02T00:00:00.000Z",
	...over,
});

const listWire = (over: Partial<ViewListWire> = {}): ViewListWire => ({
	mode: "list",
	path: "/v/notes",
	def: TABLE_DEF,
	rows: [rec()],
	total: 1,
	pageSize: 25,
	offset: 0,
	refs: { "docs.lib:7": "Doc Seven" },
	...over,
});

const detailWire = (over: Partial<ViewDetailWire> = {}): ViewDetailWire => ({
	mode: "detail",
	path: "/v/detail",
	def: DETAIL_DEF,
	record: rec({ id: 9, collection: "clinic.items", data: { name: "Thing", meta: { a: 1 } } }),
	refs: {},
	...over,
});

const ctx = (
	i18n?: PageContext["i18n"],
	plugins: readonly Plugin[] = [contributor],
): PageContext => ({
	plugins,
	locale: "en-US",
	...(i18n === undefined ? {} : { i18n }),
});

afterEach(cleanup);
beforeEach(() => {
	fns.viewQueryFn.mockReset();
	window.history.replaceState(null, "", "/v/notes");
});

describe("ViewPage — not found states", () => {
	it("renders not-found for null and malformed data", () => {
		const { rerender } = render(<ViewPage data={null} ctx={ctx()} />);
		expect(screen.getByText("View not found")).toBeTruthy();
		rerender(<ViewPage data={{}} ctx={ctx()} />);
		expect(screen.getByText("View not found")).toBeTruthy();
		rerender(<ViewPage data={{ mode: "list", def: null }} ctx={ctx()} />);
		expect(screen.getByText("View not found")).toBeTruthy();
		rerender(<ViewPage data={{ mode: "weird", def: {} }} ctx={ctx()} />);
		expect(screen.getByText("View not found")).toBeTruthy();
	});

	it("renders not-found when the def is absent from ctx.plugins", () => {
		render(<ViewPage data={listWire()} ctx={ctx(undefined, [])} />);
		expect(screen.getByText("View not found")).toBeTruthy();
	});
});

describe("ViewPage — table view", () => {
	it("renders columns, formatted cells, ref labels and detail links", () => {
		render(<ViewPage data={listWire()} ctx={ctx()} />);
		expect(screen.getByText("Title")).toBeTruthy();
		expect(screen.getByText("count")).toBeTruthy(); // label falls back to last segment
		const link = screen.getByRole("link", { name: "Hello" });
		expect(link.getAttribute("href")).toBe("/v/notes/1");
		expect(screen.getByText("3")).toBeTruthy();
		expect(screen.getByText("Doc Seven")).toBeTruthy();
		expect(screen.getByText("Notes")).toBeTruthy(); // page header title
		expect(screen.getByText("clinic.notes")).toBeTruthy(); // description
	});

	it("hides the filter bar when the def declares no interactive filters", () => {
		const { container } = render(
			<ViewPage data={listWire({ path: "/v/plain", def: PLAIN_DEF })} ctx={ctx()} />,
		);
		expect(container.querySelector("form")).toBeNull();
	});

	it("renders the empty state and hides pagination for small totals", () => {
		render(<ViewPage data={listWire({ rows: [], total: 0 })} ctx={ctx()} />);
		expect(screen.getByText("No records")).toBeTruthy();
		expect(screen.queryByText("Next")).toBeNull();
	});

	it("renders a detail-kind list payload as a table", () => {
		render(
			<ViewPage
				data={listWire({
					path: "/v/detail",
					def: DETAIL_DEF,
					rows: [rec({ data: { name: "Hello" } as never })],
				})}
				ctx={ctx()}
			/>,
		);
		expect(screen.getByRole("link", { name: "Hello" })).toBeTruthy();
	});

	it("refetches on filter change, writing URL params", async () => {
		fns.viewQueryFn.mockResolvedValue(
			listWire({ rows: [rec({ id: 2, data: { title: "Filtered" } as never })] }),
		);
		render(<ViewPage data={listWire()} ctx={ctx()} />);
		const input = screen.getByLabelText("title");
		fireEvent.change(input, { target: { value: "an" } });
		await waitFor(() => expect(fns.viewQueryFn).toHaveBeenCalled());
		expect(fns.viewQueryFn).toHaveBeenCalledWith({
			data: { path: "/v/notes", offset: 0, values: { title: "an" } },
		});
		expect(window.location.search).toBe("?title=an");
		await screen.findByText("Filtered");
		// submitting the filter form is a prevented no-op
		const form = document.querySelector("form");
		expect(form).not.toBeNull();
		fireEvent.submit(form as HTMLFormElement);
	});

	it("initializes filter inputs from the URL search", () => {
		window.history.replaceState(null, "", "/v/notes?title=seed");
		render(<ViewPage data={listWire()} ctx={ctx()} />);
		expect((screen.getByLabelText("title") as HTMLInputElement).value).toBe("seed");
	});

	it("paginates forward and back through viewQueryFn", async () => {
		const page1 = listWire({ total: 60 });
		const page2 = listWire({ total: 60, offset: 25, rows: [rec({ id: 2 })] });
		fns.viewQueryFn.mockResolvedValue(page2);
		render(<ViewPage data={page1} ctx={ctx()} />);
		fireEvent.click(screen.getByText("Next"));
		await waitFor(() =>
			expect(fns.viewQueryFn).toHaveBeenCalledWith({
				data: { path: "/v/notes", offset: 25, values: {} },
			}),
		);
		await screen.findByText("Page 2 of 3");
		// now on page 2: prev enabled, next still enabled (25+25<60)
		fns.viewQueryFn.mockResolvedValue(listWire({ total: 60, offset: 50 }));
		fireEvent.click(screen.getByText("Next"));
		await waitFor(() =>
			expect(fns.viewQueryFn).toHaveBeenLastCalledWith({
				data: { path: "/v/notes", offset: 50, values: {} },
			}),
		);
		await screen.findByText("Page 3 of 3");
		// last page: next disabled
		expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true);
		fns.viewQueryFn.mockResolvedValue(page1);
		fireEvent.click(screen.getByText("Previous"));
		await waitFor(() =>
			expect(fns.viewQueryFn).toHaveBeenLastCalledWith({
				data: { path: "/v/notes", offset: 25, values: {} },
			}),
		);
	});

	it("reset clears filter values and refetches unfiltered", async () => {
		window.history.replaceState(null, "", "/v/notes?title=seed");
		fns.viewQueryFn.mockResolvedValue(listWire());
		render(<ViewPage data={listWire()} ctx={ctx()} />);
		fireEvent.click(screen.getByText("Reset"));
		await waitFor(() =>
			expect(fns.viewQueryFn).toHaveBeenCalledWith({
				data: { path: "/v/notes", offset: 0, values: {} },
			}),
		);
		expect(window.location.search).toBe("");
	});

	it("shows loadFailed on null, non-list, thrown and busy-disabled states", async () => {
		fns.viewQueryFn.mockResolvedValue(null);
		render(<ViewPage data={listWire({ total: 60 })} ctx={ctx()} />);
		fireEvent.click(screen.getByText("Next"));
		await screen.findByText("Could not load records. Try again.");

		fns.viewQueryFn.mockResolvedValue(detailWire());
		fireEvent.click(screen.getByText("Next"));
		await waitFor(() => expect(fns.viewQueryFn).toHaveBeenCalledTimes(2));

		fns.viewQueryFn.mockRejectedValue(new Error("net"));
		fireEvent.click(screen.getByText("Next"));
		await waitFor(() => expect(fns.viewQueryFn).toHaveBeenCalledTimes(3));
	});

	it("disables controls while a refetch is in flight", async () => {
		let resolveFn: (v: unknown) => void = () => {};
		fns.viewQueryFn.mockImplementation(() => new Promise((res) => (resolveFn = res)));
		render(<ViewPage data={listWire({ total: 60 })} ctx={ctx()} />);
		fireEvent.click(screen.getByText("Next"));
		await waitFor(() =>
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true),
		);
		expect((screen.getByLabelText("title") as HTMLInputElement).disabled).toBe(true);
		resolveFn(listWire({ total: 60, offset: 25 }));
		await waitFor(() =>
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false),
		);
	});

	it("resyncs when fresh loader data arrives for a new path", () => {
		const { rerender } = render(<ViewPage data={listWire()} ctx={ctx()} />);
		expect(screen.getByRole("link", { name: "Hello" })).toBeTruthy();
		rerender(
			<ViewPage
				data={listWire({
					path: "/v/other",
					def: OTHER_DEF,
					rows: [rec({ id: 5, data: { title: "New" } as never })],
				})}
				ctx={ctx()}
			/>,
		);
		expect(screen.getByRole("link", { name: "New" })).toBeTruthy();
		expect(screen.getByText("Other")).toBeTruthy();
	});

	it("resolves def titles through the i18n catalog slice", () => {
		const i18n = { locale: "en", catalog: { "custom.title": "Localized Title" } };
		render(<ViewPage data={listWire({ path: "/v/i18nview", def: I18N_DEF })} ctx={ctx(i18n)} />);
		expect(screen.getByText("Localized Title")).toBeTruthy();
	});
});

describe("ViewPage — cards view", () => {
	const cardsWire = (): ViewListWire => ({
		mode: "list",
		path: "/v/cards",
		def: CARDS_DEF,
		rows: [
			rec({ id: 1, collection: "clinic.items", data: { name: "Widget", price: 9 } as never }),
			rec({ id: 2, collection: "clinic.items", data: { name: null, price: 4 } as never }),
		],
		total: 2,
		pageSize: 25,
		offset: 0,
		refs: {},
	});

	it("renders a card per record with titles and field rows", () => {
		render(<ViewPage data={cardsWire()} ctx={ctx()} />);
		const widget = screen.getByRole("link", { name: "Widget" });
		expect(widget.getAttribute("href")).toBe("/v/cards/1");
		expect(screen.getByRole("link", { name: "#2" })).toBeTruthy(); // null title falls back to id
		expect(screen.getAllByText("price").length).toBe(2);
		expect(screen.getByText("9")).toBeTruthy();
	});

	it("renders the empty state and paginates like the table", async () => {
		const empty = { ...cardsWire(), rows: [], total: 0 };
		const { unmount } = render(<ViewPage data={empty} ctx={ctx()} />);
		expect(screen.getByText("No records")).toBeTruthy();
		unmount();

		fns.viewQueryFn.mockResolvedValue({
			...cardsWire(),
			total: 60,
			offset: 25,
			rows: [
				rec({ id: 9, collection: "clinic.items", data: { name: "Page2", price: 1 } as never }),
			],
		});
		render(<ViewPage data={{ ...cardsWire(), total: 60 }} ctx={ctx()} />);
		fireEvent.click(screen.getByText("Next"));
		await waitFor(() =>
			expect(fns.viewQueryFn).toHaveBeenCalledWith({
				data: { path: "/v/cards", offset: 25, values: {} },
			}),
		);
		await screen.findByRole("link", { name: "Page2" });
		// previous page returns to offset 0
		fns.viewQueryFn.mockResolvedValue({ ...cardsWire(), total: 60 });
		fireEvent.click(screen.getByText("Previous"));
		await waitFor(() =>
			expect(fns.viewQueryFn).toHaveBeenLastCalledWith({
				data: { path: "/v/cards", offset: 0, values: {} },
			}),
		);
	});

	it("applies card filter changes through the shared filter bar", async () => {
		fns.viewQueryFn.mockResolvedValue(cardsWire());
		render(<ViewPage data={cardsWire()} ctx={ctx()} />);
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "wid" } });
		await waitFor(() =>
			expect(fns.viewQueryFn).toHaveBeenCalledWith({
				data: { path: "/v/cards", offset: 0, values: { name: "wid" } },
			}),
		);
	});

	it("falls back to the first field and #id when cardTitleField is absent", () => {
		const wire = cardsWire();
		render(
			<ViewPage
				data={{
					...wire,
					path: "/v/cards2",
					def: CARDS_NOMATCH,
					rows: [rec({ id: 3, collection: "clinic.items", data: {} as never })],
				}}
				ctx={ctx()}
			/>,
		);
		// first field is "name"; empty data → #id fallback
		expect(screen.getByRole("link", { name: "#3" })).toBeTruthy();
	});
});

describe("ViewPage — detail view", () => {
	it("renders labeled detail fields and a back link", () => {
		render(<ViewPage data={detailWire()} ctx={ctx()} />);
		expect(screen.getByText("name")).toBeTruthy();
		expect(screen.getByText("Thing")).toBeTruthy();
		expect(screen.getByText('{"a":1}')).toBeTruthy();
		// Button render={<Link>} keeps button semantics (role="button")
		// per the design-system convention — href still navigates.
		const back = screen.getByRole("button", { name: /Back to Detail/ });
		expect(back.getAttribute("href")).toBe("/v/detail");
	});

	it("renders record-not-found for missing records", () => {
		render(<ViewPage data={detailWire({ record: null })} ctx={ctx()} />);
		expect(screen.getByText("Record not found")).toBeTruthy();
	});

	it("defaults detailFields to fields", () => {
		render(
			<ViewPage
				data={detailWire({
					path: "/v/plaindetail",
					def: DETAIL_PLAIN,
					record: rec({ id: 9, collection: "clinic.items", data: { name: "Only" } as never }),
				})}
				ctx={ctx()}
			/>,
		);
		expect(screen.getByText("Only")).toBeTruthy();
		expect(screen.queryByText('{"a":1}')).toBeNull();
	});
});
