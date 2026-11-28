import { describe, expect, it } from "vitest";
import { Event } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import type { Plugin } from "@ktb/kernel";

import {
	makeNotificationIngestions,
	NotificationIngestions,
	notificationIngestMessages,
	notificationIngestion,
	type NotificationDraft,
} from "./index.ts";

const Ping = Event.make("test.ping", { id: Schema.Number, note: Schema.String });
const Pong = Event.make("test.pong", { id: Schema.Number });

const draft = (over: Partial<NotificationDraft> = {}): NotificationDraft => ({
	userId: "u1",
	kind: "test.kind",
	title: "Title",
	...over,
});

describe("notificationIngestion", () => {
	it("wraps an event def and projector into an ingestion entry", () => {
		const entry = notificationIngestion(Ping, (e, ctx) =>
			draft({ kind: "test.ping", body: `${e.note}:${ctx.zk}:${ctx.locale}` }),
		);
		expect(entry.event).toBe(Ping);
		expect(entry.project(Ping.make({ id: 1, note: "hi" }), { zk: true, locale: "pt-BR" })).toEqual(
			draft({ kind: "test.ping", body: "hi:true:pt-BR" }),
		);
	});

	it("rejects non-event defs and non-function projectors", () => {
		expect(() => notificationIngestion({ tag: "x" } as never, () => draft())).toThrow(
			"must be an Event def",
		);
		expect(() => notificationIngestion(Ping, "nope" as never)).toThrow(
			'projector for "test.ping" must be a function',
		);
	});
});

describe("makeNotificationIngestions", () => {
	const plugin = (id: string, ingestions: Plugin["notificationIngestions"]): Plugin =>
		({ id, notificationIngestions: ingestions }) as unknown as Plugin;

	it("collects entries across plugins in order, skipping absent fields", () => {
		const a = notificationIngestion(Ping, () => draft({ kind: "a" }));
		const b = notificationIngestion(Pong, () => draft({ kind: "b" }));
		const c = notificationIngestion(Ping, () => draft({ kind: "c" }));
		const registry = makeNotificationIngestions([
			plugin("one", [a]),
			plugin("two", undefined),
			plugin("three", [b, c]),
		]);
		expect(
			registry.ingestions.map(
				(i) => i.project(Ping.make({ id: 0, note: "" }), { zk: false, locale: "en" }).kind,
			),
		).toEqual(["a", "b", "c"]);
	});

	it("produces the service shape NotificationIngestions declares", () => {
		const registry = makeNotificationIngestions([]);
		expect(registry).toEqual({ ingestions: [] });
		expect(NotificationIngestions.key).toContain("notifications-port");
	});
});

describe("notificationIngestMessages", () => {
	it("resolves known locales and falls back to en", () => {
		expect(notificationIngestMessages("pt-BR").titles.patientCreated).toBe("Paciente criado");
		expect(notificationIngestMessages("es").titles.appointmentReminder).toBe(
			"Consulta a punto de comenzar",
		);
		expect(notificationIngestMessages("fr")).toBe(notificationIngestMessages("en"));
		expect(notificationIngestMessages("")).toBe(notificationIngestMessages("en"));
	});

	it("interpolates reminder bodies per locale", () => {
		const en = notificationIngestMessages("en");
		expect(en.bodies.appointmentReminder("Ana", "10:00")).toBe("Ana — 10:00");
		expect(en.bodies.appointmentReminderZk("10:00")).toBe("Starts at 10:00");
	});
});
