// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	create: vi.fn(async () => ({ ok: true })),
	update: vi.fn(async () => ({ ok: true })),
	remove: vi.fn(async () => ({ ok: true })),
	check: vi.fn(async () => ({ ok: true })),
	checkAll: vi.fn(async () => ({ ok: true, data: [] })),
	beat: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./apis.ts", () => ({ machinesApi: api }));

import type { PanelPageContext } from "@ktb/kernel";

import type { MachineCard } from "./machines.ts";
import { MachinesPanelPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const machine = (over: Partial<MachineCard> = {}): MachineCard => ({
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
	status: "online",
	lastSeenAt: null,
	lastCheckAt: null,
	checkError: null,
	enabled: true,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: null,
	...over,
});

afterEach(cleanup);

describe("MachinesPanelPage", () => {
	it("renders loader cards", () => {
		render(<MachinesPanelPage data={[machine()]} ctx={ctx} />);
		expect(screen.getByText("gpu-node-1")).toBeTruthy();
	});

	it("tolerates missing or malformed loader data", () => {
		render(<MachinesPanelPage data={undefined} ctx={ctx} />);
		expect(screen.getByText("No machines registered yet.")).toBeTruthy();
		cleanup();
		render(<MachinesPanelPage data="nope" ctx={ctx} />);
		expect(screen.getByText("No machines registered yet.")).toBeTruthy();
	});
});
