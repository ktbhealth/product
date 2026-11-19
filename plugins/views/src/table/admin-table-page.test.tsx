// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));

import { adminTablePage, defineAdminTable, type AdminTableDef } from "./admin-table-page.tsx";

afterEach(cleanup);

beforeEach(() => {
	invalidate.mockClear();
});

interface Row {
	id: number;
	name: string;
	email: string;
}

const ROWS: Row[] = [
	{ id: 1, name: "Ana", email: "ana@x.com" },
	{ id: 2, name: "Bob", email: "bob@x.com" },
];

interface Msgs {
	title: string;
	description: string;
	colName: string;
	colEmail: string;
	searchPlaceholder: string;
	searchLabel: string;
	noMatch: string;
	emptyTitle: string;
	emptyDescription: string;
	suspend: string;
	suspendTitle: string;
	suspendDescription: string;
	confirmSuspend: string;
	deleteSelected: string;
	newUser: string;
	createTitle: string;
	fieldName: string;
	createSubmit: string;
	actionError: string;
}

const MSGS: Msgs = {
	title: "Users",
	description: "All users",
	colName: "Name",
	colEmail: "Email",
	searchPlaceholder: "Search users…",
	searchLabel: "Search users",
	noMatch: "No users match the search.",
	emptyTitle: "No users",
	emptyDescription: "Users appear here once they sign up.",
	suspend: "Suspend",
	suspendTitle: "Suspend user?",
	suspendDescription: "They will be signed out.",
	confirmSuspend: "Yes, suspend",
	deleteSelected: "Delete",
	newUser: "New user",
	createTitle: "New user",
	fieldName: "Name",
	createSubmit: "Create",
	actionError: "Could not save. Try again.",
};

const i18n = { namespace: "test", messages: () => MSGS };

type Def = AdminTableDef<Row, Msgs>;

const baseDef = (over: Partial<Def> = {}): Def =>
	defineAdminTable({
		id: "test.users",
		i18n,
		title: (t) => t.title,
		description: (t) => t.description,
		search: {
			keys: ["name", "email"],
			placeholder: (t) => t.searchPlaceholder,
			label: (t) => t.searchLabel,
		},
		columns: [
			{ key: "name", header: (t) => t.colName },
			{ key: "email", header: "Email", format: "mono" },
		],
		empty: {
			title: (t) => t.emptyTitle,
			description: (t) => t.emptyDescription,
		},
		noMatch: (t) => t.noMatch,
		...over,
	});

const renderPage = (def: Def, rows: readonly Row[] = ROWS) => {
	const Page = adminTablePage(def);
	render(<Page rows={rows} />);
	return Page;
};

describe("adminTablePage", () => {
	it("renders the TablePage shell with t-resolved title/description/headers", () => {
		renderPage(baseDef());
		expect(screen.getByText("Users")).toBeTruthy();
		expect(screen.getByText("All users")).toBeTruthy();
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.getByText("bob@x.com")).toBeTruthy();
		expect(screen.getByPlaceholderText("Search users…")).toBeTruthy();
	});

	it("sets a displayName from the def id", () => {
		const Page = adminTablePage(baseDef());
		expect(Page.displayName).toBe("AdminTablePage(test.users)");
	});

	it("filters rows client-side and shows the noMatch row", () => {
		renderPage(baseDef());
		fireEvent.change(screen.getByPlaceholderText("Search users…"), {
			target: { value: "zzz" },
		});
		expect(screen.queryByText("Ana")).toBeNull();
		expect(screen.queryByText("Bob")).toBeNull();
		expect(screen.getByText("No users match the search.")).toBeTruthy();
	});

	it("shows the custom empty state when there are no rows", () => {
		renderPage(baseDef(), []);
		expect(screen.getByText("No users")).toBeTruthy();
		expect(screen.getByText("Users appear here once they sign up.")).toBeTruthy();
	});

	it("runs a confirm row action, invalidates on ok and shows the error line on failure", async () => {
		const run = vi.fn<(row: Row) => Promise<unknown>>(async () => ({ ok: true, data: {} }));
		renderPage(
			baseDef({
				rowActions: [
					{
						id: "suspend",
						label: (t) => t.suspend,
						confirm: {
							title: (t) => t.suspendTitle,
							description: (t) => t.suspendDescription,
							confirmLabel: (t) => t.confirmSuspend,
						},
						run,
					},
				],
				actionError: (t) => t.actionError,
			}),
		);
		fireEvent.click(screen.getAllByRole("button", { name: "Suspend" })[0]!);
		expect(await screen.findByRole("alertdialog")).toBeTruthy();
		expect(screen.getByText("Suspend user?")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Yes, suspend" }));
		await waitFor(() => expect(run).toHaveBeenCalledWith(ROWS[0]));
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
	});

	it("shows the single error line when an action fails", async () => {
		const run = vi.fn<(row: Row) => Promise<unknown>>(async () => ({ ok: false }));
		renderPage(
			baseDef({
				rowActions: [{ id: "suspend", label: "Suspend", run }],
				actionError: (t) => t.actionError,
			}),
		);
		fireEvent.click(screen.getAllByRole("button", { name: "Suspend" })[0]!);
		await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
		expect(await screen.findByText("Could not save. Try again.")).toBeTruthy();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("hides row actions per row via hidden()", () => {
		renderPage(
			baseDef({
				rowActions: [
					{
						id: "suspend",
						label: "Suspend",
						hidden: (row) => row.id === 2,
						run: async () => ({ ok: true }),
					},
				],
			}),
		);
		expect(screen.getAllByRole("button", { name: "Suspend" })).toHaveLength(1);
	});

	it("shows the bulk bar on selection and runs bulk actions with selected rows", async () => {
		const run = vi.fn<(rows: readonly Row[]) => Promise<unknown>>(async () => ({ ok: true }));
		renderPage(
			baseDef({
				bulkActions: [{ id: "delete", label: (t) => t.deleteSelected, run }],
			}),
		);
		expect(screen.queryByText("1 selected")).toBeNull();
		fireEvent.click(screen.getByLabelText("Select row 1"));
		expect(screen.getByText("1 selected")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(run).toHaveBeenCalledWith([ROWS[0]]));
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		// selection cleared after success
		await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
	});

	it("renders create dialog, submits values and invalidates", async () => {
		const onSubmit = vi.fn<(values: Record<string, string>) => Promise<unknown>>(async () => ({
			ok: true,
		}));
		renderPage(
			baseDef({
				create: {
					label: (t) => t.newUser,
					title: (t) => t.createTitle,
					fields: (t) => [{ name: "name", label: t.fieldName, required: true }],
					submitLabel: (t) => t.createSubmit,
					onSubmit,
				},
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "New user" }));
		// The header button and the dialog title share the "New user"
		// copy — assert on the dialog role instead of the text.
		expect(await screen.findByRole("dialog")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Cid" } });
		fireEvent.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: "Cid" }));
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("keeps the create dialog open and shows the error on failure", async () => {
		const onSubmit = vi.fn<(values: Record<string, string>) => Promise<unknown>>(async () => ({
			ok: false,
		}));
		renderPage(
			baseDef({
				create: {
					label: "New user",
					fields: [{ name: "name", label: "Name" }],
					submitLabel: "Create",
					onSubmit,
				},
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "New user" }));
		await screen.findByRole("dialog");
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Cid" } });
		fireEvent.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(await screen.findByText("Action failed. Try again.")).toBeTruthy();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("renders extensions as an escape slot", () => {
		renderPage(baseDef({ extensions: <div data-testid="ext-slot">Extra panel</div> }));
		expect(screen.getByTestId("ext-slot")).toBeTruthy();
		expect(screen.getByText("Extra panel")).toBeTruthy();
	});

	it("applies DB catalog overrides through sliceMessages", () => {
		const Page = adminTablePage(baseDef());
		render(
			<Page
				rows={ROWS}
				i18n={{
					locale: "en",
					catalog: { "test.colName": "DB Name", "test.title": "DB Users" },
				}}
			/>,
		);
		// colName/title are string leaves inside MSGS → overridden; the
		// function-valued def fields read the merged t.
		expect(screen.getByText("DB Name")).toBeTruthy();
		expect(screen.getByText("DB Users")).toBeTruthy();
	});

	it("supports a predicate search", () => {
		renderPage(
			baseDef({
				search: {
					predicate: (row, needle) => row.email.startsWith(needle),
					placeholder: "Search users…",
				},
			}),
		);
		fireEvent.change(screen.getByPlaceholderText("Search users…"), {
			target: { value: "bob@" },
		});
		expect(screen.getByText("Bob")).toBeTruthy();
		expect(screen.queryByText("Ana")).toBeNull();
	});

	it("renders a loading row", () => {
		const Page = adminTablePage(baseDef());
		render(<Page rows={ROWS} loading />);
		expect(screen.getByRole("status")).toBeTruthy();
		expect(screen.queryByText("Ana")).toBeNull();
	});
});
