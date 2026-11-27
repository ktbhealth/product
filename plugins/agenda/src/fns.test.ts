import { describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";

import { Forbidden } from "@ktb/authz";

const mocks = vi.hoisted(() => ({
	ensureDoctorUser: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "u1" })),
	runAs: vi.fn<(user: unknown, effect: unknown) => Promise<unknown>>(async () => ({
		ok: true as const,
	})),
}));

// Same fake as patients/fns.test.ts: handlers run as plain async fns
// and the validator is applied to the incoming `data`.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((value: unknown) => unknown) | undefined;
		const api = {
			validator: (fn: (value: unknown) => unknown) => {
				validate = fn;
				return api;
			},
			handler: (h: (arg: { data: unknown }) => unknown) => async (call: { data?: unknown }) =>
				h({ data: validate === undefined ? call?.data : validate(call?.data) }),
		};
		return api;
	},
}));
vi.mock("@ktb/server-fns", async (importOriginal) => ({
	...(await importOriginal<typeof import("@ktb/server-fns")>()),
	ensureDoctorUser: mocks.ensureDoctorUser,
	runAs: mocks.runAs,
}));

import { AppointmentConflict, Appointments } from "./service.ts";
import {
	createAppointmentFn,
	listAppointmentsFn,
	setAppointmentStatusFn,
	startAppointmentFn,
	updateAppointmentFn,
} from "./fns.ts";

/** `runAs` executes the effect against a stub Appointments service. */
const runEffects = (impl: Partial<Appointments["Service"]>) => {
	mocks.runAs.mockImplementation(async (_user, effect) =>
		Effect.runPromise(
			(effect as Effect.Effect<unknown>).pipe(
				Effect.provideService(Appointments, Appointments.of(impl as Appointments["Service"])),
			),
		),
	);
};

const row = { id: 5, ownerId: "u1", patientId: 1 };

describe("createAppointmentFn", () => {
	it("decodes ISO and epoch startsAt into a Date before the schema", async () => {
		runEffects({ create: () => Effect.succeed(row as never) });
		const iso = (await createAppointmentFn({
			data: { patientId: 1, startsAt: "2030-01-01T10:00:00Z" },
		})) as { ok: boolean };
		expect(iso.ok).toBe(true);
		const epoch = (await createAppointmentFn({
			data: { patientId: 1, startsAt: 1893453600000 },
		})) as { ok: boolean };
		expect(epoch.ok).toBe(true);
	});

	it("collapses service denial to { ok: false }", async () => {
		runEffects({
			create: () => Effect.fail(new Forbidden({ path: "appointment.create" })),
		});
		const out = (await createAppointmentFn({
			data: { patientId: 1, startsAt: new Date(0) },
		})) as { ok: boolean };
		expect(out).toEqual({ ok: false });
	});

	it("reports a double-booking as { ok: false, reason: 'conflict' }", async () => {
		runEffects({
			create: () => Effect.fail(new AppointmentConflict({ conflictingId: 3 })),
		});
		expect(await createAppointmentFn({ data: { patientId: 1, startsAt: new Date(0) } })).toEqual({
			ok: false,
			reason: "conflict",
			conflictingId: 3,
		});
	});

	it("collapses a null service row to { ok: false }", async () => {
		runEffects({ create: () => Effect.succeed(null as never) });
		const out = (await createAppointmentFn({
			data: { patientId: 1, startsAt: new Date(0) },
		})) as { ok: boolean };
		expect(out).toEqual({ ok: false });
	});

	it("rejects malformed wire input before the handler runs", async () => {
		await expect(
			createAppointmentFn({ data: { startsAt: "not-a-date", patientId: "x" } }),
		).rejects.toThrow(/./);
		await expect(createAppointmentFn({ data: { patientId: 1 } })).rejects.toThrow(/./);
	});

	it("passes non-object wire values through the normalizer untouched", async () => {
		await expect(createAppointmentFn({ data: "junk" })).rejects.toThrow(/./);
	});
});

describe("updateAppointmentFn", () => {
	it("strips id from the patch and forwards the rest", async () => {
		let seen: unknown;
		runEffects({
			update: (_o: string, _id: number, patch: unknown) => {
				seen = patch;
				return Effect.succeed(row as never);
			},
		});
		const out = (await updateAppointmentFn({
			data: { id: 5, startsAt: "2030-01-01T10:00:00Z", note: "x" },
		})) as { ok: boolean };
		expect(out.ok).toBe(true);
		expect(seen).toMatchObject({ note: "x" });
		expect((seen as Record<string, unknown>).startsAt).toBeInstanceOf(Date);
		expect((seen as Record<string, unknown>).id).toBeUndefined();
	});

	it("collapses denial and missing rows", async () => {
		runEffects({
			update: () => Effect.fail(new Forbidden({ path: "appointment.update" })),
		});
		expect((await updateAppointmentFn({ data: { id: 5, note: null } })) as { ok: boolean }).toEqual(
			{ ok: false },
		);
	});

	it("keeps the conflict reason for a double-booking", async () => {
		runEffects({
			update: () => Effect.fail(new AppointmentConflict({ conflictingId: 9 })),
		});
		expect(await updateAppointmentFn({ data: { id: 5, startsAt: new Date(0) } })).toEqual({
			ok: false,
			reason: "conflict",
			conflictingId: 9,
		});
	});
});

describe("setAppointmentStatusFn", () => {
	it("accepts only declared statuses", async () => {
		runEffects({ setStatus: () => Effect.succeed(row as never) });
		expect(
			(await setAppointmentStatusFn({ data: { id: 5, status: "confirmed" } })) as {
				ok: boolean;
			},
		).toEqual({ ok: true, appointment: row });
		await expect(setAppointmentStatusFn({ data: { id: 5, status: "bogus" } })).rejects.toThrow(/./);
	});

	it("collapses denial to { ok: false }", async () => {
		runEffects({
			setStatus: () => Effect.fail(new Forbidden({ path: "appointment.update" })),
		});
		expect(
			(await setAppointmentStatusFn({ data: { id: 5, status: "cancelled" } })) as {
				ok: boolean;
			},
		).toEqual({ ok: false });
	});
});

describe("startAppointmentFn", () => {
	it("returns the consultation id on success", async () => {
		runEffects({
			start: () => Effect.succeed({ appointment: row, consultationId: 42 } as never),
		});
		expect(await startAppointmentFn({ data: { id: 5 } })).toEqual({
			ok: true,
			consultationId: 42,
		});
	});

	it("collapses nulls and denial to { ok: false }", async () => {
		runEffects({ start: () => Effect.succeed(null as never) });
		expect(await startAppointmentFn({ data: { id: 5 } })).toEqual({ ok: false });
		runEffects({
			start: () => Effect.fail(new Forbidden({ path: "appointment.update" })),
		});
		expect(await startAppointmentFn({ data: { id: 5 } })).toEqual({ ok: false });
	});
});

describe("listAppointmentsFn", () => {
	const day = 86_400_000;

	it("lists the range for the acting doctor, decoding wire dates", async () => {
		let seen: unknown;
		runEffects({
			list: (_owner: string, range: unknown) => {
				seen = range;
				return Effect.succeed([row] as never);
			},
		});
		expect(
			await listAppointmentsFn({ data: { from: "2030-01-01T00:00:00Z", to: 1893542400000 } }),
		).toEqual({ ok: true, appointments: [row] });
		expect((seen as { from: Date }).from).toBeInstanceOf(Date);
		expect((seen as { to: Date }).to).toBeInstanceOf(Date);
	});

	it("refuses inverted and over-wide ranges before touching the service", async () => {
		mocks.ensureDoctorUser.mockClear();
		expect(await listAppointmentsFn({ data: { from: new Date(day), to: new Date(0) } })).toEqual({
			ok: false,
		});
		expect(
			await listAppointmentsFn({ data: { from: new Date(0), to: new Date(63 * day) } }),
		).toEqual({ ok: false });
		expect(mocks.ensureDoctorUser).not.toHaveBeenCalled();
	});

	it("collapses denial to { ok: false } and rejects malformed input", async () => {
		runEffects({ list: () => Effect.fail(new Forbidden({ path: "appointment.read" })) });
		expect(await listAppointmentsFn({ data: { from: new Date(0), to: new Date(day) } })).toEqual({
			ok: false,
		});
		await expect(listAppointmentsFn({ data: { from: "nope" } })).rejects.toThrow(/./);
		await expect(listAppointmentsFn({ data: null })).rejects.toThrow(/./);
	});
});
