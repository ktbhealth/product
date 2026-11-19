// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Column } from "./columns.tsx";
import { CollectionDialog, type CollectionLoadResult } from "./CollectionDialog.tsx";

afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	role: string;
}

const ROWS: Row[] = [
	{ id: 1, name: "Ana", role: "admin" },
	{ id: 2, name: "Bob", role: "member" },
];

const COLUMNS: Column<Row>[] = [
	{ key: "name", header: "Name" },
	{ key: "role", header: "Role", format: "mono" },
];

const MESSAGES = {
	loading: "Loading members…",
	empty: "No members yet.",
	error: "Failed to load.",
	remove: "Remove",
	removeTitle: "Remove member?",
	removeConfirm: "Yes, remove",
	cancel: "Cancel",
};

const DEFAULT_LOAD = async (): Promise<CollectionLoadResult<Row>> => ({
	ok: true,
	data: ROWS,
});

const setup = ({
	load = DEFAULT_LOAD,
	remove,
	addForm,
	open = true,
}: {
	load?: () => Promise<CollectionLoadResult<Row>>;
	remove?: (row: Row) => Promise<unknown>;
	addForm?: (ctx: { reload: () => Promise<void>; busy: boolean; error: boolean }) => ReactNode;
	open?: boolean;
} = {}) => {
	render(
		<CollectionDialog
			open={open}
			onOpenChange={() => {}}
			title="Members"
			description="Tenant roster"
			columns={COLUMNS}
			rowKey={(row) => String(row.id)}
			load={load}
			remove={remove}
			addForm={addForm}
			messages={MESSAGES}
		/>,
	);
};

describe("CollectionDialog", () => {
	it("loads on open and renders rows through the column pipeline", async () => {
		setup();
		expect(await screen.findByText("Ana")).toBeTruthy();
		expect(screen.getByText("Bob")).toBeTruthy();
		expect(screen.getByText("admin")).toBeTruthy();
		expect(screen.getByText("Members")).toBeTruthy();
		expect(screen.getByText("Tenant roster")).toBeTruthy();
	});

	it("shows loading then the empty state", async () => {
		setup({ load: async () => [] });
		expect(await screen.findByText("No members yet.")).toBeTruthy();
	});

	it("shows the error line when load fails", async () => {
		setup({ load: async () => ({ ok: false }) });
		expect(await screen.findByText("Failed to load.")).toBeTruthy();
		expect(screen.queryByText("Ana")).toBeNull();
	});

	it("shows the error line when load rejects", async () => {
		setup({
			load: async () => {
				throw new Error("boom");
			},
		});
		expect(await screen.findByText("Failed to load.")).toBeTruthy();
	});

	it("removes a row through the internal confirm dialog and reloads", async () => {
		const load = vi.fn<() => Promise<CollectionLoadResult<Row>>>(async () => ({
			ok: true,
			data: ROWS,
		}));
		const remove = vi.fn<(row: Row) => Promise<unknown>>(async () => ({ ok: true }));
		setup({ load, remove });
		await screen.findByText("Ana");
		expect(load).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
		expect(await screen.findByRole("alertdialog")).toBeTruthy();
		expect(screen.getByText("Remove member?")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));

		await waitFor(() => expect(remove).toHaveBeenCalledWith(ROWS[0]));
		await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
	});

	it("sets the error line when remove fails", async () => {
		const remove = vi.fn<(row: Row) => Promise<unknown>>(async () => ({ ok: false }));
		setup({ remove });
		await screen.findByText("Ana");
		fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
		fireEvent.click(await screen.findByRole("button", { name: "Yes, remove" }));
		expect(await screen.findByText("Failed to load.")).toBeTruthy();
	});

	it("cancel on the confirm dialog does not call remove", async () => {
		const remove = vi.fn<(row: Row) => Promise<unknown>>(async () => ({ ok: true }));
		setup({ remove });
		await screen.findByText("Ana");
		fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(remove).not.toHaveBeenCalled();
	});

	it("hides the actions column when remove is omitted", async () => {
		setup();
		await screen.findByText("Ana");
		expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
	});

	it("passes reload/busy/error to addForm and reload refetches", async () => {
		const load = vi.fn<() => Promise<CollectionLoadResult<Row>>>(async () => ({
			ok: true,
			data: ROWS,
		}));
		let ctx: { reload: () => Promise<void>; busy: boolean; error: boolean } | null = null;
		setup({
			load,
			addForm: (c) => {
				ctx = c;
				return (
					<button type="button" onClick={() => void c.reload()}>
						Reload list
					</button>
				);
			},
		});
		await screen.findByText("Ana");
		expect(ctx).not.toBeNull();
		expect(ctx!.busy).toBe(false);
		expect(ctx!.error).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Reload list" }));
		await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
	});

	it("normalizes an ok envelope with non-array data to the empty state", async () => {
		setup({
			load: async () => ({ ok: true, data: "oops" }) as unknown as CollectionLoadResult<Row>,
		});
		expect(await screen.findByText("No members yet.")).toBeTruthy();
	});

	it("renders without description or rowKey and honours column width/render", async () => {
		render(
			<CollectionDialog
				open
				onOpenChange={() => {}}
				title="Members"
				columns={[
					{
						key: "name",
						header: "Name",
						width: 120,
						render: (row) => <em>{row.name}!</em>,
					},
					{ key: "role", header: "Role" },
				]}
				load={DEFAULT_LOAD}
				messages={MESSAGES}
			/>,
		);
		expect(await screen.findByText("Ana!")).toBeTruthy();
		expect(screen.getByText("Bob!")).toBeTruthy();
		expect(screen.queryByText("Tenant roster")).toBeNull();
	});

	it("sets the error line when remove rejects", async () => {
		const remove = vi.fn<(row: Row) => Promise<unknown>>(async () => {
			throw new Error("nope");
		});
		setup({ remove });
		await screen.findByText("Ana");
		fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
		fireEvent.click(await screen.findByRole("button", { name: "Yes, remove" }));
		expect(await screen.findByText("Failed to load.")).toBeTruthy();
	});

	it("does not load while closed", () => {
		const load = vi.fn<() => Promise<CollectionLoadResult<Row>>>(async () => ({
			ok: true,
			data: ROWS,
		}));
		setup({ load, open: false });
		expect(load).not.toHaveBeenCalled();
	});
});
