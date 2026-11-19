import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
	CalendarSyncError,
	Calendars,
	makeCalendarsRegistry,
	makeMemoryCalendarProvider,
	nullCalendarsDriver,
	type ExternalEventDraft,
} from "./index.ts";

const draft: ExternalEventDraft = {
	title: "Consulta — J.S.",
	startsAt: new Date("2026-11-20T14:00:00Z"),
	endsAt: new Date("2026-11-20T14:30:00Z"),
	description: "apt-42",
};

describe("makeCalendarsRegistry", () => {
	it("indexes adapters by id and lists them", () => {
		const memory = makeMemoryCalendarProvider();
		const registry = makeCalendarsRegistry([memory]);
		expect(registry.provider("memory")).toBe(memory);
		expect(registry.provider("google")).toBeUndefined();
		expect(registry.providers()).toEqual(["memory"]);
	});
});

describe("CalendarSyncError", () => {
	it("carries name, message and optional provider", () => {
		const error = new CalendarSyncError("boom", { provider: "google" });
		expect(error.name).toBe("CalendarSyncError");
		expect(error.message).toBe("boom");
		expect(error.provider).toBe("google");
	});

	it("allows omitting options entirely", () => {
		const error = new CalendarSyncError("boom");
		expect(error.provider).toBeUndefined();
	});
});

describe("nullCalendarsDriver", () => {
	it("is always eligible and provides an empty registry", () => {
		expect(nullCalendarsDriver.id).toBe("calendar-none");
		expect(nullCalendarsDriver.port).toBe("@ktb/calendar/Calendars");
		expect(nullCalendarsDriver.when?.({})).toBeUndefined();
	});

	it("provides an empty Calendars registry", async () => {
		const layer = nullCalendarsDriver.provides({}) as Layer.Layer<Calendars>;
		const registry = await Effect.runPromise(Effect.service(Calendars).pipe(Effect.provide(layer)));
		expect(registry.providers()).toEqual([]);
	});
});

describe("memory calendar", () => {
	const connect = () => makeMemoryCalendarProvider().connect({});

	it("creates, lists, updates and cancels events per calendar", async () => {
		const cal = await connect();
		const event = await cal.createEvent("primary", draft);
		expect(event.calendarId).toBe("primary");
		expect(event.status).toBe("confirmed");
		expect(cal.provider).toBe("memory");
		expect(event.id).toMatch(/^memory-evt-\d+$/);
		expect(Number.isNaN(event.updatedAt?.getTime())).toBe(false);

		expect(await cal.listEvents("primary")).toEqual([event]);
		expect(await cal.listEvents("other")).toEqual([]);

		const moved = { ...draft, startsAt: new Date("2026-11-21T14:00:00Z") };
		const updated = await cal.updateEvent("primary", event.id, moved);
		expect(updated.startsAt).toEqual(moved.startsAt);
		expect(updated.id).toBe(event.id);
		expect(await cal.listEvents("primary")).toEqual([updated]);

		await cal.cancelEvent("primary", event.id);
		expect(await cal.listEvents("primary")).toEqual([]);
	});

	it("fails updates on unknown events", async () => {
		const cal = await connect();
		const error = await cal.updateEvent("primary", "nope", draft).catch((e) => e);
		expect(error).toBeInstanceOf(CalendarSyncError);
		expect(error.message).toContain("nope");
		expect(error.provider).toBe("memory");
	});

	it("returns a fresh sync token per sync call", async () => {
		const cal = await connect();
		await cal.createEvent("primary", draft);
		const first = await cal.syncEvents("primary", null);
		const second = await cal.syncEvents("primary", first.nextSyncToken);
		expect(first.events).toHaveLength(1);
		expect(first.deletedIds).toEqual([]);
		expect(first.nextSyncToken).toBe("1");
		expect(second.nextSyncToken).toBe("2");
	});

	it("assigns unique increasing event ids", async () => {
		const cal = await connect();
		const a = await cal.createEvent("primary", draft);
		const b = await cal.createEvent("primary", draft);
		expect(a.id).toMatch(/^memory-evt-\d+$/);
		expect(b.id).toMatch(/^memory-evt-\d+$/);
		expect(b.id).not.toBe(a.id);
	});

	it("isolates connections like separate accounts", async () => {
		const provider = makeMemoryCalendarProvider();
		const a = await provider.connect({});
		const b = await provider.connect({});
		await a.createEvent("primary", draft);
		expect(await b.listEvents("primary")).toEqual([]);
	});
});
