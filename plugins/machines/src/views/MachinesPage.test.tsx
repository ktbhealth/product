// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MachinesApi } from "../apis.ts";
import type { MachineCard } from "../machines.ts";
import { MachinesPage } from "./MachinesPage.tsx";

const machine = (over: Partial<MachineCard> = {}): MachineCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	name: "gpu-node-1",
	kind: "gpu",
	host: "10.0.0.5",
	port: 22,
	capabilities: ["acp"],
	secretRef: "vault:3",
	healthUrl: "http://10.0.0.5/health",
	status: "online",
	lastSeenAt: new Date("2026-11-01T10:00:00Z"),
	lastCheckAt: new Date("2026-11-01T10:05:00Z"),
	checkError: null,
	enabled: true,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: null,
	...over,
});

const api = (): MachinesApi & {
	create: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
	check: ReturnType<typeof vi.fn>;
	checkAll: ReturnType<typeof vi.fn>;
	beat: ReturnType<typeof vi.fn>;
} => ({
	create: vi.fn(async () => ({ ok: true })),
	update: vi.fn(async () => ({ ok: true })),
	remove: vi.fn(async () => ({ ok: true })),
	check: vi.fn(async () => ({ ok: true })),
	checkAll: vi.fn(async () => ({ ok: true, data: [] as MachineCard[] })),
	beat: vi.fn(async () => ({ ok: true })),
});

afterEach(cleanup);

describe("MachinesPage", () => {
	it("renders the empty state", () => {
		render(<MachinesPage machines={[]} api={api()} />);
		expect(screen.getByText("No machines registered yet.")).toBeTruthy();
	});

	it("renders machine rows with status, refs and actions", () => {
		const disabled = machine({
			id: 2,
			name: "old-shell",
			kind: "shell",
			host: "shell.local",
			port: null,
			secretRef: null,
			status: "draining",
			enabled: false,
			lastSeenAt: null,
			lastCheckAt: null,
		});
		render(<MachinesPage machines={[machine(), disabled]} api={api()} locale="en" />);
		expect(screen.getByText("gpu-node-1")).toBeTruthy();
		expect(screen.getByText("10.0.0.5:22")).toBeTruthy();
		expect(screen.getByText("vault:3")).toBeTruthy();
		expect(screen.getByText("old-shell")).toBeTruthy();
		expect(screen.getAllByText("Draining").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Disable").length).toBeGreaterThan(0);
		// null dates render the em-dash fallback.
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("check-all refreshes the row set from the api", async () => {
		const a = api();
		a.checkAll.mockResolvedValue({ ok: true, data: [machine({ name: "fresh" })] });
		render(<MachinesPage machines={[]} api={a} />);
		await userEvent.click(screen.getByRole("button", { name: "Check all" }));
		await waitFor(() => expect(screen.getByText("fresh")).toBeTruthy());
		expect(a.checkAll).toHaveBeenCalled();
	});

	it("creates a machine through the dialog with parsed fields", async () => {
		const a = api();
		render(<MachinesPage machines={[]} api={a} />);
		await userEvent.click(screen.getByRole("button", { name: "Register machine" }));
		await userEvent.selectOptions(screen.getByRole("combobox"), "gpu");
		await userEvent.type(screen.getByPlaceholderText("Name"), "new-box");
		await userEvent.type(screen.getByPlaceholderText("Host"), "new.local");
		await userEvent.type(screen.getByPlaceholderText("Port"), "2200");
		await userEvent.type(screen.getByPlaceholderText("Capabilities"), "acp, eval-runner");
		await userEvent.type(screen.getByPlaceholderText("Secret ref"), "vault:9");
		await userEvent.type(screen.getByPlaceholderText("Health URL"), "http://new.local/h");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith({
				name: "new-box",
				kind: "gpu",
				host: "new.local",
				port: 2200,
				capabilities: ["acp", "eval-runner"],
				secretRef: "vault:9",
				healthUrl: "http://new.local/h",
			}),
		);
	});

	it("creates with minimal fields and surfaces offline/unknown statuses", async () => {
		const a = api();
		const extra = [
			machine({ id: 3, name: "down-box", status: "offline", checkError: "timeout" }),
			machine({ id: 4, name: "mystery-box", status: "unknown", kind: "endpoint" }),
			machine({
				id: 5,
				name: "bad-date",
				status: "online",
				lastSeenAt: "not-a-date" as unknown as Date,
				lastCheckAt: "2026-11-01T10:00:00Z" as unknown as Date,
			}),
		];
		a.checkAll.mockResolvedValue({ ok: true, data: extra });
		render(<MachinesPage machines={extra} api={a} locale="pt-BR" />);
		expect(screen.getByText("Offline")).toBeTruthy();
		expect(screen.getByText("Desconhecido")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Registrar máquina" }));
		await userEvent.type(screen.getByPlaceholderText("Nome"), "minimal");
		await userEvent.type(screen.getByPlaceholderText("Host"), "min.local");
		await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith({ name: "minimal", kind: "other", host: "min.local" }),
		);
	});

	it("keeps the dialog open and shows the error when create fails", async () => {
		const a = api();
		a.create.mockResolvedValue({ ok: false });
		render(<MachinesPage machines={[]} api={a} />);
		await userEvent.click(screen.getByRole("button", { name: "Register machine" }));
		await userEvent.type(screen.getByPlaceholderText("Name"), "fail-box");
		await userEvent.type(screen.getByPlaceholderText("Host"), "fail.local");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByText("Action failed — check permissions and try again.")).toBeTruthy(),
		);
		expect(screen.getByPlaceholderText("Name")).toBeTruthy();
	});

	it("check success refreshes the rows", async () => {
		const a = api();
		a.checkAll.mockResolvedValue({ ok: true, data: [machine({ name: "post-check" })] });
		render(<MachinesPage machines={[machine()]} api={a} />);
		const checkButtons = screen.getAllByRole("button", { name: "Check" });
		await userEvent.click(checkButtons[checkButtons.length - 1]!);
		await waitFor(() => expect(screen.getByText("post-check")).toBeTruthy());
		expect(a.check).toHaveBeenCalledWith(1);
	});

	it("cancel closes the dialog without saving", async () => {
		const a = api();
		render(<MachinesPage machines={[]} api={a} />);
		await userEvent.click(screen.getByRole("button", { name: "Register machine" }));
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByPlaceholderText("Name")).toBeNull());
		expect(a.create).not.toHaveBeenCalled();
	});

	it("surfaces the action error when a mutation fails", async () => {
		const a = api();
		a.check.mockResolvedValue({ ok: false });
		render(<MachinesPage machines={[machine()]} api={a} />);
		const checkButtons = screen.getAllByRole("button", { name: "Check" });
		await userEvent.click(checkButtons[checkButtons.length - 1]!);
		await waitFor(() =>
			expect(screen.getByText("Action failed — check permissions and try again.")).toBeTruthy(),
		);
	});

	it("remove failure keeps rows and surfaces nothing extra", async () => {
		const a = api();
		a.remove.mockResolvedValue({ ok: false });
		render(<MachinesPage machines={[machine()]} api={a} />);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		const confirmButtons = await screen.findAllByRole("button", { name: "Delete" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(a.remove).toHaveBeenCalledWith(1));
		await waitFor(() =>
			expect(screen.queryByText("Delete this machine? This cannot be undone.")).toBeNull(),
		);
	});

	it("confirm-dialog cancel dismisses without deleting", async () => {
		const a = api();
		render(<MachinesPage machines={[machine()]} api={a} />);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByText("Delete this machine? This cannot be undone.")).toBeNull(),
		);
		expect(a.remove).not.toHaveBeenCalled();
	});

	it("check-all without data leaves rows untouched", async () => {
		const a = api();
		a.checkAll.mockResolvedValue({ ok: true });
		render(<MachinesPage machines={[machine()]} api={a} />);
		await userEvent.click(screen.getByRole("button", { name: "Check all" }));
		await waitFor(() => expect(a.checkAll).toHaveBeenCalled());
		expect(screen.getByText("gpu-node-1")).toBeTruthy();
	});

	it("toggles enabled state and deletes through the confirm dialog", async () => {
		const a = api();
		a.checkAll.mockResolvedValue({ ok: true, data: [machine()] });
		render(<MachinesPage machines={[machine()]} api={a} />);
		await userEvent.click(screen.getByRole("button", { name: "Disable" }));
		expect(a.update).toHaveBeenCalledWith({ id: 1, enabled: false });
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		// ConfirmDialog confirm button.
		const confirmButtons = await screen.findAllByRole("button", { name: "Delete" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(a.remove).toHaveBeenCalledWith(1));
	});
});
