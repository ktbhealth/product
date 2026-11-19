// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	kvListFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	kvNamespacesFn: vi.fn<() => Promise<unknown>>(),
	kvGetFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	kvSetFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	kvDeleteFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

vi.mock("../fns.ts", () => fns);

// Base UI's Select needs pointer/portal plumbing jsdom lacks; render a
// native <select> with the same value/onValueChange contract. Options
// come from SelectItem children; a11y props ride on SelectTrigger and
// are forwarded onto the <select> element.
vi.mock("@ktbhealth/ui/components/select", async () => {
	const React = await import("react");
	const SelectTriggerMock = (props: Record<string, unknown>) =>
		React.createElement("ktb-select-trigger", props);
	const Select = ({
		value,
		onValueChange,
		children,
	}: {
		value?: string | null;
		onValueChange?: (v: string | null) => void;
		children?: React.ReactNode;
	}) => {
		let triggerProps: Record<string, unknown> = {};
		const inner = React.Children.map(children, (child) => {
			if (React.isValidElement(child) && child.type === SelectTriggerMock) {
				const { children: _c, size: _s, ...props } = child.props as Record<string, unknown>;
				triggerProps = props;
				return null;
			}
			return child;
		});
		return React.createElement(
			"select",
			{
				value: value ?? "",
				onChange: (e: { target: { value: string } }) => onValueChange?.(e.target.value),
				...triggerProps,
			},
			inner,
		);
	};
	return {
		Select,
		SelectTrigger: SelectTriggerMock,
		SelectValue: () => null,
		SelectContent: ({ children }: { children?: React.ReactNode }) =>
			React.createElement(React.Fragment, null, children),
		SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) =>
			React.createElement("option", { value }, children),
	};
});

import { KvAdminPage, type KvAdminPageData } from "./KvAdminPage.tsx";
import type { KvEntryWire } from "../fns.ts";

const row = (over: Partial<KvEntryWire> = {}): KvEntryWire =>
	({
		namespace: "alpha",
		key: "k1",
		tenantId: null,
		ownerId: null,
		value: 1,
		version: 1,
		expiresAt: null,
		expired: false,
		...over,
	}) as KvEntryWire;

const data = (
	items: readonly KvEntryWire[] = [row()],
	total = items.length,
	namespaces: readonly { namespace: string; count: number }[] = [
		{ namespace: "alpha", count: items.length },
	],
): KvAdminPageData => ({ items, total, namespaces });

const okList = (items: readonly KvEntryWire[] = [row()], total = items.length) => {
	fns.kvListFn.mockResolvedValue({ items, total });
	fns.kvNamespacesFn.mockResolvedValue([{ namespace: "alpha", count: items.length }]);
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("KvAdminPage", () => {
	it("renders rows with scope, value, expiry and version", () => {
		const now = Date.now();
		render(
			<KvAdminPage
				data={data([
					row({}),
					row({
						namespace: "beta",
						key: "t1",
						tenantId: 5,
						value: { x: 1 },
						version: 3,
						expiresAt: now + 3_600_000,
					}),
					row({
						namespace: "gamma",
						key: "o1",
						ownerId: "user-9",
						expiresAt: now - 1000,
						expired: true,
					}),
				])}
				locale="en"
			/>,
		);
		expect(screen.getByText("k1")).toBeTruthy();
		expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
		expect(screen.getByText("beta")).toBeTruthy();
		expect(screen.getByText("gamma")).toBeTruthy();
		expect(screen.getByText("Global")).toBeTruthy();
		expect(screen.getByText("Tenant #5")).toBeTruthy();
		expect(screen.getByText("User user-9")).toBeTruthy();
		expect(screen.getByText('{"x":1}')).toBeTruthy();
		expect(screen.getByText("Expired")).toBeTruthy();
		expect(screen.getByText("No expiry")).toBeTruthy();
		expect(screen.getByText("in 1h")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
		expect(screen.getByText("3 entries")).toBeTruthy();
		expect(screen.getByText("Namespaces:")).toBeTruthy();
	});

	it("truncates long value previews and survives unserializable values", () => {
		render(
			<KvAdminPage
				data={data([
					row({ key: "long", value: "x".repeat(200) }),
					row({
						key: "bigint",
						namespace: "b",
						value: BigInt(10) as never,
					}),
					row({ key: "undef", namespace: "c", value: undefined as never }),
				])}
				locale="en"
			/>,
		);
		expect(screen.getByText(/…$/)).toBeTruthy();
		expect(screen.getByText("10")).toBeTruthy();
		expect(screen.getByText("undefined")).toBeTruthy();
	});

	it("shows the empty state and localizes copy", () => {
		render(<KvAdminPage data={data([], 0, [])} locale="pt-BR" />);
		expect(screen.getByText("Armazenamento chave-valor")).toBeTruthy();
		expect(screen.getByText("Nenhuma entrada encontrada")).toBeTruthy();
	});

	it("filters by namespace through the select", async () => {
		const user = userEvent.setup();
		okList([row({ namespace: "beta", key: "b1" })], 1);
		fns.kvNamespacesFn.mockResolvedValue([
			{ namespace: "alpha", count: 1 },
			{ namespace: "beta", count: 1 },
		]);
		render(
			<KvAdminPage
				data={data([row({})], 1, [
					{ namespace: "alpha", count: 1 },
					{ namespace: "beta", count: 1 },
				])}
				locale="en"
			/>,
		);
		await user.selectOptions(screen.getByLabelText("All namespaces"), "beta");
		await waitFor(() =>
			expect(fns.kvListFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ namespace: "beta", limit: 50, offset: 0 }),
			}),
		);
		await waitFor(() => expect(screen.getByText("b1")).toBeTruthy());
	});

	it("filters by key prefix on form submit", async () => {
		const user = userEvent.setup();
		okList([row({ key: "pre-1" })], 1);
		const { container } = render(<KvAdminPage data={data([row({})], 1)} locale="en" />);
		const input = screen.getByLabelText("Filter by key prefix…");
		await user.type(input, "pre");
		fireEvent.submit(container.querySelector("form")!);
		await waitFor(() =>
			expect(fns.kvListFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ prefix: "pre" }),
			}),
		);
	});

	it("paginates forward and back", async () => {
		const user = userEvent.setup();
		okList([row({ key: "p2" })], 1);
		render(<KvAdminPage data={data([row({})], 60)} locale="en" />);
		expect(screen.getByText("Page 1 of 2")).toBeTruthy();
		await user.click(screen.getByText("Next"));
		await waitFor(() =>
			expect(fns.kvListFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ offset: 50 }),
			}),
		);
		await waitFor(() => expect(screen.getByText("p2")).toBeTruthy());
		await user.click(screen.getByText("Previous"));
		await waitFor(() =>
			expect(fns.kvListFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ offset: 0 }),
			}),
		);
	});

	it("keeps prior rows and chips when a reload fails", async () => {
		fns.kvListFn.mockResolvedValue(null);
		fns.kvNamespacesFn.mockResolvedValue(null);
		const { container } = render(<KvAdminPage data={data([row({})], 1)} locale="en" />);
		fireEvent.submit(container.querySelector("form")!);
		await waitFor(() =>
			expect(screen.getByText("Could not load entries. Try again.")).toBeTruthy(),
		);
		expect(screen.getByText("k1")).toBeTruthy();
		expect(screen.getByText("alpha · 1")).toBeTruthy();
	});

	it("keeps namespace chips when the namespaces fn is denied", async () => {
		fns.kvListFn.mockResolvedValue({ items: [row({ key: "n1" })], total: 1 });
		fns.kvNamespacesFn.mockResolvedValue(null);
		const { container } = render(<KvAdminPage data={data([row({})], 1)} locale="en" />);
		fireEvent.submit(container.querySelector("form")!);
		await waitFor(() => expect(screen.getByText("n1")).toBeTruthy());
		expect(screen.getByText("alpha · 1")).toBeTruthy();
	});

	it("defaults the table chrome locale to en when none is passed", () => {
		render(<KvAdminPage data={data([], 0, [])} />);
		expect(screen.getByText("No entries found")).toBeTruthy();
	});

	it("shows the load error when the list fn fails or returns null", async () => {
		fns.kvListFn.mockResolvedValue(null);
		fns.kvNamespacesFn.mockResolvedValue(null);
		const { container } = render(<KvAdminPage data={data([], 0, [])} locale="en" />);
		fireEvent.submit(container.querySelector("form")!);
		await waitFor(() =>
			expect(screen.getByText("Could not load entries. Try again.")).toBeTruthy(),
		);
		// Empty + failed: no empty-state box.
		expect(screen.queryByText("No entries found")).toBeNull();
		fns.kvListFn.mockRejectedValue(new Error("boom"));
		fireEvent.submit(container.querySelector("form")!);
		await waitFor(() =>
			expect(screen.getByText("Could not load entries. Try again.")).toBeTruthy(),
		);
	});

	it("creates an entry with JSON validation and TTL modes", async () => {
		const user = userEvent.setup();
		okList();
		fns.kvSetFn.mockResolvedValue({
			ok: true,
			entry: row({ key: "new" }),
		});
		render(<KvAdminPage data={data([], 0, [])} locale="en" />);
		await user.click(screen.getByText("New entry"));
		await user.type(screen.getByLabelText("Namespace"), "ns");
		await user.type(screen.getByLabelText("Key"), "new");
		await user.type(screen.getByLabelText("Tenant ID (optional)"), " 12 ");
		await user.type(screen.getByLabelText("Owner ID (optional)"), "owner-1");
		const value = screen.getByLabelText("Value (JSON)");
		await user.clear(value);
		fireEvent.change(value, { target: { value: "{bad" } });
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(screen.getByText("Value must be valid JSON.")).toBeTruthy();
		expect(fns.kvSetFn).not.toHaveBeenCalled();

		await user.clear(value);
		fireEvent.change(value, { target: { value: '{"a":1}' } });
		// Custom TTL with invalid seconds → ttl error, no call.
		await user.selectOptions(screen.getByLabelText("TTL"), "custom");
		const secs = screen.getByLabelText("Seconds");
		await user.clear(secs);
		await user.type(secs, "0");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(screen.getByText("TTL must be a positive number of seconds.")).toBeTruthy();
		expect(fns.kvSetFn).not.toHaveBeenCalled();

		await user.clear(secs);
		await user.type(secs, "60");
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.kvSetFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					namespace: "ns",
					key: "new",
					tenantId: "12",
					ownerId: "owner-1",
					valueJson: '{"a":1}',
					ttlMs: 60_000,
				}),
			}),
		);
		await waitFor(() => expect(fns.kvListFn).toHaveBeenCalledTimes(1));
	});

	it("edits an entry with CAS version and keep-TTL default", async () => {
		const user = userEvent.setup();
		okList();
		fns.kvSetFn.mockResolvedValue({ ok: true, entry: row({ version: 2 }) });
		const expiring = Date.now() + 60_000;
		render(
			<KvAdminPage
				data={data([row({ key: "e1", value: { n: 1 }, version: 7, expiresAt: expiring })])}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		const value = screen.getByLabelText("Value (JSON)") as HTMLTextAreaElement;
		expect(value.value).toContain('"n": 1');
		expect((screen.getByLabelText("Namespace") as HTMLInputElement).disabled).toBe(true);
		expect(screen.getByText("Version: 7")).toBeTruthy();
		await user.clear(value);
		fireEvent.change(value, { target: { value: '{"n":2}' } });
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.kvSetFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					namespace: "alpha",
					key: "e1",
					tenantId: null,
					ownerId: null,
					valueJson: '{"n":2}',
					ttlMs: undefined,
					expectedVersion: 7,
				}),
			}),
		);
	});

	it("edits a scoped row and clears TTL explicitly", async () => {
		const user = userEvent.setup();
		okList();
		fns.kvSetFn.mockResolvedValue({ ok: true, entry: row({}) });
		render(
			<KvAdminPage
				data={data([
					row({
						key: "s1",
						tenantId: 4,
						ownerId: null,
						value: "v",
						version: 2,
						expiresAt: Date.now() + 60_000,
					}),
				])}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		expect((screen.getByLabelText("Tenant ID (optional)") as HTMLInputElement).value).toBe("4");
		await user.selectOptions(screen.getByLabelText("TTL"), "none");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.kvSetFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					tenantId: "4",
					ownerId: null,
					ttlMs: null,
					expectedVersion: 2,
				}),
			}),
		);
	});

	it("surfaces CAS conflicts and generic save failures", async () => {
		const user = userEvent.setup();
		okList();
		fns.kvSetFn.mockResolvedValue({
			ok: false,
			reason: "conflict",
			actualVersion: 9,
		});
		render(<KvAdminPage data={data([row({})])} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.getByText(/changed since you loaded it/)).toBeTruthy());
		fns.kvSetFn.mockResolvedValue({ ok: false, reason: "invalid" });
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByText("Could not save the entry. Try again.")).toBeTruthy(),
		);
		fns.kvSetFn.mockRejectedValue(new Error("boom"));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByText("Could not save the entry. Try again.")).toBeTruthy(),
		);
	});

	it("deletes an entry after confirmation and reports failures", async () => {
		const user = userEvent.setup();
		okList();
		fns.kvDeleteFn.mockResolvedValue(true);
		render(<KvAdminPage data={data([row({ tenantId: 2, ownerId: null })])} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		expect(screen.getByText('Delete "k1"? This cannot be undone.')).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() =>
			expect(fns.kvDeleteFn).toHaveBeenCalledWith({
				data: { namespace: "alpha", key: "k1", tenantId: 2, ownerId: null },
			}),
		);
		await waitFor(() => expect(fns.kvListFn).toHaveBeenCalledTimes(1));
	});

	it("reports failed deletes without refreshing", async () => {
		const user = userEvent.setup();
		okList();
		fns.kvDeleteFn.mockResolvedValue(false);
		render(<KvAdminPage data={data([row({})])} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() =>
			expect(screen.getByText("Could not save the entry. Try again.")).toBeTruthy(),
		);
		fns.kvDeleteFn.mockRejectedValue(new Error("boom"));
		await user.click(screen.getByLabelText("Delete"));
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() =>
			expect(screen.getByText("Could not save the entry. Try again.")).toBeTruthy(),
		);
	});

	it("closes the form dialog on Escape", async () => {
		const user = userEvent.setup();
		render(<KvAdminPage data={data([], 0, [])} locale="en" />);
		await user.click(screen.getByText("New entry"));
		expect(screen.getByLabelText("Namespace")).toBeTruthy();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByLabelText("Value (JSON)")).toBeNull());
	});

	it("cancels the dialogs without calling the fns", async () => {
		const user = userEvent.setup();
		render(<KvAdminPage data={data([row({})])} locale="en" />);
		await user.click(screen.getByText("New entry"));
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await user.click(screen.getByLabelText("Delete"));
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(fns.kvSetFn).not.toHaveBeenCalled();
		expect(fns.kvDeleteFn).not.toHaveBeenCalled();
	});

	it("opens the edit dialog for unserializable values", async () => {
		const user = userEvent.setup();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		render(
			<KvAdminPage
				data={data([
					row({ key: "big", value: BigInt(7) as never }),
					row({ key: "circ", namespace: "b", value: circular as never }),
				])}
				locale="en"
			/>,
		);
		const edits = screen.getAllByLabelText("Edit");
		await user.click(edits[0]!);
		expect((screen.getByLabelText("Value (JSON)") as HTMLTextAreaElement).value).toBe("7");
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByLabelText("Value (JSON)")).toBeNull());
		await user.click(screen.getAllByLabelText("Edit")[1]!);
		expect((screen.getByLabelText("Value (JSON)") as HTMLTextAreaElement).value).toBe(
			"[unserializable]",
		);
	});
});
