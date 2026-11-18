import { afterEach, describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";

import { runScheduledAgendaReminders } from "./agenda-reminders.ts";

const hoisted = vi.hoisted(() => ({
	appointments: undefined as Record<string, unknown> | undefined,
}));

// The default sweep path composes through @ktb/server-fns `run`, which
// needs the app runtime — outside the composition root it throws before
// the Effect body executes. Mock `run` to execute the effect against a
// stubbed Appointments service instead.
vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return {
		...actual,
		run: async (effect: Effect.Effect<unknown, unknown, unknown>) => {
			const { Appointments } = await import("@ktb/agenda");
			return Effect.runPromise(
				effect.pipe(
					Effect.provideService(Appointments, hoisted.appointments as never),
				) as Effect.Effect<unknown>,
			);
		},
	};
});

const silence = () => {
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runScheduledAgendaReminders", () => {
	it("returns the dispatch count and logs fired reminders", async () => {
		silence();
		const out = await runScheduledAgendaReminders({ dispatch: async () => 3 });
		expect(out).toBe(3);
		expect(console.info).toHaveBeenCalledWith(
			expect.stringContaining('"message":"agenda.reminders.dispatched"'),
		);
	});

	it("stays quiet when nothing was due", async () => {
		silence();
		const out = await runScheduledAgendaReminders({ dispatch: async () => 0 });
		expect(out).toBe(0);
		expect(console.info).not.toHaveBeenCalled();
	});

	it("uses the composed runtime sweep when no dispatch is injected", async () => {
		silence();
		hoisted.appointments = { dispatchDueReminders: () => Effect.succeed(4) };
		const out = await runScheduledAgendaReminders();
		expect(out).toBe(4);
		expect(console.info).toHaveBeenCalledWith(
			expect.stringContaining('"message":"agenda.reminders.dispatched"'),
		);
		hoisted.appointments = undefined;
	});

	it("logs and returns null when the sweep throws", async () => {
		silence();
		const out = await runScheduledAgendaReminders({
			dispatch: async () => {
				throw new Error("db down");
			},
		});
		expect(out).toBeNull();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('"message":"agenda.reminders.failed"'),
		);
	});
});
