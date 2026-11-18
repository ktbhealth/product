import { afterEach, describe, expect, it, vi } from "vitest";

import { runScheduledAgendaReminders } from "./agenda-reminders.ts";

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
