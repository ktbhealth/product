// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MachinesApi } from "../apis.ts";
import type { MachineCard } from "../machines.ts";
import type { MachineStatus } from "../schema.ts";
import { MachinesPage } from "./MachinesPage.tsx";

const card = (over: Partial<MachineCard> = {}): MachineCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	name: "gpu-node-1",
	kind: "gpu",
	host: "10.0.0.5",
	port: 22,
	capabilities: ["acp"],
	secretRef: null,
	healthUrl: null,
	status: "unknown",
	lastSeenAt: null,
	lastCheckAt: null,
	checkError: null,
	enabled: true,
	createdAt: new Date(0),
	updatedAt: null,
	...over,
});

const makeApi = () => ({
	create: vi.fn<MachinesApi["create"]>(async (input) => ({
		ok: true as const,
		data: card({
			id: 99,
			name: input.name,
			kind: (input.kind as MachineCard["kind"]) ?? "other",
			host: input.host,
			port: input.port ?? null,
			capabilities: input.capabilities ?? [],
			secretRef: input.secretRef ?? null,
			healthUrl: input.healthUrl ?? null,
		}),
	})),
	update: vi.fn<MachinesApi["update"]>(async (input) => ({
		ok: true as const,
		data: card({ id: input.id, enabled: input.enabled ?? true }),
	})),
	remove: vi.fn<MachinesApi["remove"]>(async () => ({ ok: true as const })),
	check: vi.fn<MachinesApi["check"]>(async () => ({ ok: true as const, data: null })),
	checkAll: vi.fn<MachinesApi["checkAll"]>(async () => ({ ok: true as const, data: [] })),
	beat: vi.fn<MachinesApi["beat"]>(async () => ({ ok: true as const })),
});

const STATUS_LABEL: Record<MachineStatus, string> = {
	online: "Online",
	offline: "Offline",
	draining: "Draining",
	unknown: "Unknown",
};

afterEach(cleanup);

describe("MachinesPage", () => {
	it("renders the empty state inside the table", () => {
		render(<MachinesPage machines={[]} api={makeApi()} locale="en" />);
		expect(screen.getByText(/No machines registered yet/)).toBeTruthy();
	});

	it("lists machines with status tones, refs, port suffix and disabled badge", () => {
		const seen = new Date("2025-01-02T03:04:05Z");
		const checked = new Date("2025-01-03T03:04:05Z");
		render(
			<MachinesPage
				machines={[
					card({
						id: 1,
						name: "alpha",
						status: "online",
						port: 22,
						secretRef: "vault:3",
						lastSeenAt: seen,
						lastCheckAt: checked,
					}),
					card({ id: 2, name: "beta", status: "offline", port: null }),
					card({ id: 3, name: "gamma", status: "draining", enabled: false, port: null }),
					card({ id: 4, name: "delta", status: "unknown", port: null }),
				]}
				api={makeApi()}
				locale="en"
			/>,
		);
		for (const label of Object.values(STATUS_LABEL)) {
			expect(screen.getByText(label)).toBeTruthy();
		}
		expect(screen.getByText("vault:3")).toBeTruthy();
		// Host + port render as adjacent text nodes inside one cell.
		expect(screen.getAllByRole("cell").some((c) => c.textContent === "10.0.0.5:22")).toBe(true);
		// Enabled rows show a Disable action; the disabled row shows the
		// badge hint plus an Enable action.
		expect(screen.getAllByRole("button", { name: "Disable" })).toHaveLength(3);
		expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy();
		// beta has no port — its host cell renders bare (the port-less
		// rows share the default host, so count exact cell texts).
		expect(screen.getAllByRole("cell").filter((c) => c.textContent === "10.0.0.5").length).toBe(3);
	});

	it("renders dashes for missing and invalid timestamps", () => {
		render(
			<MachinesPage
				machines={[
					card({
						id: 1,
						lastSeenAt: null,
						lastCheckAt: "garbage" as unknown as Date,
					}),
				]}
				api={makeApi()}
				locale="en"
			/>,
		);
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
	});

	it("check-all refreshes rows; check and toggle call the api", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		const refreshed = card({ id: 7, name: "refreshed" });
		api.checkAll.mockResolvedValue({ ok: true as const, data: [refreshed] });
		render(<MachinesPage machines={[card({ id: 1, name: "stale" })]} api={api} locale="en" />);

		await user.click(screen.getByText("Check all"));
		await waitFor(() => expect(api.checkAll).toHaveBeenCalled());
		expect(await screen.findByText("refreshed")).toBeTruthy();
		expect(screen.queryByText("stale")).toBeNull();

		// Per-row check triggers a refresh too — target the row's Check
		// button (the column header is a th, not a button).
		api.check.mockResolvedValueOnce({ ok: true as const, data: null });
		await user.click(screen.getAllByRole("button", { name: "Check" })[0]!);
		await waitFor(() => expect(api.check).toHaveBeenCalledWith(7));
		await waitFor(() => expect(api.checkAll).toHaveBeenCalledTimes(2));

		// Failed check surfaces the error line.
		api.check.mockResolvedValueOnce({ ok: false });
		await user.click(screen.getAllByRole("button", { name: "Check" })[0]!);
		expect(await screen.findByText(/Action failed/)).toBeTruthy();

		// Toggle flips enabled through update.
		api.update.mockResolvedValueOnce({ ok: true as const, data: card({ id: 7, enabled: false }) });
		await user.click(screen.getAllByRole("button", { name: "Disable" })[0]!);
		await waitFor(() => expect(api.update).toHaveBeenCalledWith({ id: 7, enabled: false }));
	});

	it("surfaces checkAll failures without touching rows", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.checkAll.mockResolvedValueOnce({ ok: false });
		render(<MachinesPage machines={[card({ id: 1, name: "stay" })]} api={api} locale="en" />);
		await user.click(screen.getByText("Check all"));
		// checkAll's own Result isn't routed through run() — rows stay put.
		expect(screen.getByText("stay")).toBeTruthy();
	});

	it("ignores a checkAll payload without data", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.checkAll.mockResolvedValueOnce({ ok: true });
		render(<MachinesPage machines={[card({ id: 1, name: "stay2" })]} api={api} locale="en" />);
		await user.click(screen.getByText("Check all"));
		await waitFor(() => expect(api.checkAll).toHaveBeenCalled());
		expect(screen.getByText("stay2")).toBeTruthy();
	});

	it("creates a machine through the dialog with every field", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<MachinesPage machines={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Register machine"));

		const inputs = screen.getAllByRole("textbox");
		// name, host, port, healthUrl, capabilities, secretRef (6 inputs)
		expect(inputs).toHaveLength(6);
		await user.type(inputs[0]!, "new-box");
		await user.selectOptions(screen.getByRole("combobox"), "vm");
		await user.type(inputs[1]!, "vm.local");
		await user.type(inputs[2]!, "2222");
		await user.type(inputs[3]!, "http://vm.local/health");
		await user.type(inputs[4]!, "acp, , llm");
		await user.type(inputs[5]!, "vault:7");
		await user.click(screen.getByText("Save"));

		await waitFor(() => expect(api.create).toHaveBeenCalled());
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			name: "new-box",
			kind: "vm",
			host: "vm.local",
			port: 2222,
			capabilities: ["acp", "llm"],
			secretRef: "vault:7",
			healthUrl: "http://vm.local/health",
		});
		// Dialog closes and rows refresh via checkAll.
		await waitFor(() => expect(api.checkAll).toHaveBeenCalled());
	});

	it("keeps optionals off the wire and blocks save until name+host", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<MachinesPage machines={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Register machine"));
		const save = screen.getByText("Save");
		expect(save).toHaveProperty("disabled", true);

		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "minimal");
		expect(save).toHaveProperty("disabled", true); // host still empty
		await user.type(inputs[1]!, "min.local");
		expect(save).toHaveProperty("disabled", false);
		await user.click(save);
		await waitFor(() => expect(api.create).toHaveBeenCalled());
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			name: "minimal",
			kind: "other",
			host: "min.local",
		});
	});

	it("surfaces create failures and keeps the dialog open", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.create.mockResolvedValueOnce({ ok: false });
		render(<MachinesPage machines={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Register machine"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "x");
		await user.type(inputs[1]!, "h");
		await user.click(screen.getByText("Save"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
		// Dialog stays open — name input still rendered.
		expect(screen.getByDisplayValue("x")).toBeTruthy();
	});

	it("deletes a machine after the confirm step; cancel keeps it", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<MachinesPage machines={[card({ id: 5, name: "doomed" })]} api={api} locale="en" />);

		await user.click(screen.getByText("Delete"));
		await user.click(screen.getByText("Cancel"));
		expect(api.remove).not.toHaveBeenCalled();
		expect(screen.getByText("doomed")).toBeTruthy();

		await user.click(screen.getByText("Delete"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		await waitFor(() => expect(api.remove).toHaveBeenCalledWith(5));
		await waitFor(() => expect(api.checkAll).toHaveBeenCalled());
	});

	it("surfaces remove failures", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.remove.mockResolvedValueOnce({ ok: false });
		render(<MachinesPage machines={[card({ id: 6, name: "stuck" })]} api={api} locale="en" />);
		await user.click(screen.getByText("Delete"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
		expect(screen.getByText("stuck")).toBeTruthy();
	});

	it("closes the create dialog via Cancel and Escape", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<MachinesPage machines={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Register machine"));
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByPlaceholderText("Name")).toBeNull();

		await user.click(screen.getByText("Register machine"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByPlaceholderText("Name")).toBeNull());
	});
});
