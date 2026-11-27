import { describe, expect, it, vi } from "vitest";

type Fn = (arg: { data: unknown }) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	createAppointmentFn: vi.fn<Fn>(async (arg) => ({ tag: "create", arg })),
	updateAppointmentFn: vi.fn<Fn>(async (arg) => ({ tag: "update", arg })),
	setAppointmentStatusFn: vi.fn<Fn>(async (arg) => ({ tag: "status", arg })),
	startAppointmentFn: vi.fn<Fn>(async (arg) => ({ tag: "start", arg })),
	listAppointmentsFn: vi.fn<Fn>(async (arg) => ({ tag: "list", arg })),
}));

vi.mock("./fns.ts", () => ({
	createAppointmentFn: mocks.createAppointmentFn,
	updateAppointmentFn: mocks.updateAppointmentFn,
	setAppointmentStatusFn: mocks.setAppointmentStatusFn,
	startAppointmentFn: mocks.startAppointmentFn,
	listAppointmentsFn: mocks.listAppointmentsFn,
}));

import { agendaApi } from "./apis.ts";

describe("agendaApi adapter", () => {
	it("posts the draft to createAppointmentFn", async () => {
		const draft = { patientId: 1, startsAt: new Date(0) };
		await expect(agendaApi.create(draft)).resolves.toEqual({
			tag: "create",
			arg: { data: draft },
		});
	});

	it("posts the patch + id to updateAppointmentFn", async () => {
		const patch = { note: "room 2" };
		await expect(agendaApi.update(7, patch)).resolves.toEqual({
			tag: "update",
			arg: { data: { note: "room 2", id: 7 } },
		});
	});

	it("posts status transitions and start", async () => {
		await expect(agendaApi.setStatus(3, "cancelled")).resolves.toEqual({
			tag: "status",
			arg: { data: { id: 3, status: "cancelled" } },
		});
		await expect(agendaApi.start(3)).resolves.toEqual({
			tag: "start",
			arg: { data: { id: 3 } },
		});
	});

	it("fetches a calendar range through listAppointmentsFn", async () => {
		const from = new Date(0);
		const to = new Date(86_400_000);
		await expect(agendaApi.list!(from, to)).resolves.toEqual({
			tag: "list",
			arg: { data: { from, to } },
		});
	});
});
