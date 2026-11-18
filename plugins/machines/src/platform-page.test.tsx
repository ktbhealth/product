// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fns.ts", () => ({
	machinesCreateFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
	machinesUpdateFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
	machinesRemoveFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
	machinesCheckFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
	machinesCheckAllFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: [] })),
	machinesBeatFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { MachineCard } from "./machines.ts";
import { MachinesPanelPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

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

afterEach(cleanup);

describe("MachinesPanelPage", () => {
	it("passes card arrays through to the view", () => {
		render(
			<MachinesPanelPage
				data={[card(), card({ id: 2, name: "dev-shell", kind: "shell" })]}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("gpu-node-1")).toBeTruthy();
		expect(screen.getByText("dev-shell")).toBeTruthy();
	});

	it("narrows non-array loader data to an empty list", () => {
		render(<MachinesPanelPage data={{ nope: true }} ctx={ctx} />);
		expect(screen.getByText(/No machines registered yet/)).toBeTruthy();
	});
});
