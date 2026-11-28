import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Command, EventBus, makeEventBus, Query } from "@effect-server-utils/cqrs";
import { Principal } from "@ktb/authz";
import { AppointmentReminderDue } from "@ktb/agenda/api";
import { ConsultationCreated } from "@ktb/consultations/api";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { PatientCreated, PatientDeleted } from "@ktb/patients/api";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";

import {
	countUnreadNotifications,
	insertNotification,
	listNotifications,
	markAllNotificationsRead,
	markNotificationsRead,
	Notifications,
	NotificationsCommands,
	NotificationsCommandsLive,
	NotificationsLive,
	NotificationsQueries,
	NotificationsQueriesLive,
	notificationsDashboardPlugin,
	notificationsHeaderPlugin,
	notificationsServicesPlugin,
	notificationsTablesPlugin,
	plugins,
} from "./index.ts";

const DDL = `
INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ('u1', 'Dra', 'd@x.com', 0, NULL, 0, 0);
INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ('u2', 'Dr B', 'b@x.com', 0, NULL, 0, 0);
INSERT INTO groups (id, name, slug, kind, zk, created_at, updated_at) VALUES (7, 'Clinic', 'clinic-7', 'clinic', 0, 0, 0), (8, 'ZK Clinic', 'clinic-8', 'clinic', 1, 0, 0);
`;

describe("notifications repo", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeTestD1(DDL));
	});

	it("inserts and lists scoped by user, newest first", async () => {
		await insertNotification(db, {
			userId: "u1",
			kind: "patient.created",
			title: "One",
		});
		await insertNotification(db, {
			userId: "u1",
			kind: "patient.deleted",
			title: "Two",
			body: "Ana",
		});
		await insertNotification(db, { userId: "u2", kind: "x", title: "Other" });
		const rows = await listNotifications(db, "u1");
		expect(rows.map((r) => r.title)).toEqual(["Two", "One"]);
		expect(rows[0]?.body).toBe("Ana");
		expect(rows[0]?.readAt).toBeNull();
		expect(await listNotifications(db, "u2")).toHaveLength(1);
	});

	it("applies the limit when given", async () => {
		const rows = await listNotifications(db, "u1", 1);
		expect(rows).toHaveLength(1);
	});

	it("counts unread and marks read per user", async () => {
		expect(await countUnreadNotifications(db, "u1")).toBe(2);
		const [first] = await listNotifications(db, "u1");
		await markNotificationsRead(db, "u1", [first!.id]);
		expect(await countUnreadNotifications(db, "u1")).toBe(1);
		// Ids of another user are ignored.
		await markNotificationsRead(db, "u1", [9999]);
		await markAllNotificationsRead(db, "u1");
		expect(await countUnreadNotifications(db, "u1")).toBe(0);
	});
});

type AppServices =
	| Notifications
	| EventBus
	| Query.Registered<typeof NotificationsQueries>
	| Command.Registered<typeof NotificationsCommands>;

describe("NotificationsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<AppServices, never>;

	beforeAll(() => {
		const db = makeDb(makeTestD1(DDL));
		// Shared infra object → layer memoization → one EventBus instance
		// for the service subscriptions and the test's dispatches.
		const infra = Layer.mergeAll(Layer.succeed(Db, db), makeEventBus());
		// Commands delegate to the Notifications service — mirror the
		// plugin's provideMerge composition so they share the one PubSub.
		const services = Layer.mergeAll(NotificationsQueriesLive, NotificationsCommandsLive).pipe(
			Layer.provideMerge(NotificationsLive),
			Layer.provideMerge(infra),
		);
		runtime = ManagedRuntime.make(
			services as Layer.Layer<AppServices, never, never>,
		) as ManagedRuntime.ManagedRuntime<AppServices, never>;
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(userId: string | null, effect: Effect.Effect<A, E, Notifications>) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId }),
		);

	const call = <A, E>(f: (p: Notifications["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Notifications, f);

	it("ingests PatientCreated after commit and lists it", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const bus = yield* EventBus;
				yield* bus.dispatch([PatientCreated.make({ id: 1, ownerId: "u1", name: "Ana" })]);
			}),
		);
		const rows = await asUser(
			"u1",
			call((n) => n.list("u1")),
		);
		const hit = rows.find((r) => r.kind === "patient.created");
		expect(hit).toMatchObject({
			userId: "u1",
			title: "Patient created",
			body: "Ana",
		});
	});

	it("stores metadata-only rows for ZK tenants (T-149)", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const bus = yield* EventBus;
				yield* bus.dispatch([
					PatientCreated.make({ id: 30, ownerId: "u1", name: "v1.ciphertext", tenantId: 8 }),
					ConsultationCreated.make({ id: 31, userId: "u1", source: "browser", tenantId: 8 }),
				]);
			}),
		);
		const rows = await asUser(
			"u1",
			call((n) => n.list("u1")),
		);
		const patient = rows.find((r) => r.kind === "patient.created" && r.title === "Patient created");
		const consult = rows.find((r) => r.kind === "consultation.created");
		// Under ZK the server cannot read record content — no name, no
		// source field, nothing derived from the record in the row.
		expect(patient?.body).toBeNull();
		expect(consult?.body).toBeNull();
	});

	it("keeps record-derived bodies for non-ZK tenants and fails closed for unknown ones", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const bus = yield* EventBus;
				yield* bus.dispatch([
					PatientCreated.make({ id: 32, ownerId: "u1", name: "Cleo", tenantId: 7 }),
					// A tenantId with no group row projects metadata-only copy.
					PatientCreated.make({ id: 33, ownerId: "u1", name: "Ghost", tenantId: 999 }),
				]);
			}),
		);
		const rows = await asUser(
			"u1",
			call((n) => n.list("u1")),
		);
		const created = rows.filter((r) => r.kind === "patient.created");
		expect(created.find((r) => r.body === "Cleo")).toBeDefined();
		expect(created.find((r) => r.body === "Ghost")).toBeUndefined();
		// Exactly the ZK row and the unknown-tenant row are metadata-only.
		expect(created.filter((r) => r.body === null)).toHaveLength(2);
	});

	it("ingests AppointmentReminderDue with the appointment payload", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const bus = yield* EventBus;
				yield* bus.dispatch([
					AppointmentReminderDue.make({
						id: 40,
						ownerId: "u1",
						patientName: "Ana",
						startsAt: new Date("2030-01-01T10:00:00Z"),
					}),
					// ZK tenant rows keep only the schedule metadata — the
					// `v1.` envelope never lands in the persisted body.
					AppointmentReminderDue.make({
						id: 41,
						ownerId: "u1",
						patientName: "v1.ciphertext",
						startsAt: new Date("2030-01-01T11:00:00Z"),
						tenantId: 8,
					}),
					// Null patient name (unknown/deleted link) still notifies,
					// time-only like the ZK branch.
					AppointmentReminderDue.make({
						id: 42,
						ownerId: "u1",
						patientName: null,
						startsAt: new Date("2030-01-01T12:00:00Z"),
					}),
				]);
			}),
		);
		const rows = await asUser(
			"u1",
			call((n) => n.list("u1")),
		);
		const reminders = rows.filter((r) => r.kind === "appointment.reminder");
		expect(reminders).toHaveLength(3);
		expect(reminders.every((r) => r.title === "Appointment starting soon")).toBe(true);
		const plaintext = reminders.find((r) => r.payload?.includes('"appointmentId":40'));
		expect(plaintext?.body).toContain("Ana");
		// ZK/unnamed bodies carry the formatted time only — never the
		// stored envelope nor the (absent) name.
		const zk = reminders.find((r) => r.payload?.includes('"appointmentId":41'));
		expect(zk?.body).toBeTruthy();
		expect(zk?.body).not.toContain("v1.");
		expect(zk?.body).not.toContain("Ana");
		const unnamed = reminders.find((r) => r.payload?.includes('"appointmentId":42'));
		expect(unnamed?.body).toBeTruthy();
		expect(unnamed?.body).not.toContain("Ana");
	});

	it("ingests PatientDeleted and ConsultationCreated", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const bus = yield* EventBus;
				yield* bus.dispatch([
					PatientDeleted.make({ id: 2, ownerId: "u1" }),
					ConsultationCreated.make({ id: 3, userId: "u1", source: "browser" }),
				]);
			}),
		);
		const rows = await asUser(
			"u1",
			call((n) => n.list("u1")),
		);
		expect(rows.map((r) => r.kind)).toEqual(
			expect.arrayContaining(["patient.deleted", "consultation.created"]),
		);
	});

	it("unreadCount and markRead/markAllRead round-trip", async () => {
		const before = await asUser(
			"u1",
			call((n) => n.unreadCount("u1")),
		);
		expect(before).toBeGreaterThan(0);
		const rows = await asUser(
			"u1",
			call((n) => n.list("u1")),
		);
		const unread = rows.filter((r) => r.readAt === null);
		await asUser(
			"u1",
			call((n) =>
				n.markRead(
					"u1",
					unread.slice(0, 1).map((r) => r.id),
				),
			),
		);
		expect(
			await asUser(
				"u1",
				call((n) => n.unreadCount("u1")),
			),
		).toBe(before - 1);
		await asUser(
			"u1",
			call((n) => n.markAllRead("u1")),
		);
		expect(
			await asUser(
				"u1",
				call((n) => n.unreadCount("u1")),
			),
		).toBe(0);
	});

	it("stream replays the persisted backlog for the principal", async () => {
		const head = await asUser(
			"u1",
			Effect.gen(function* () {
				const n = yield* Notifications;
				return yield* Stream.runHead(Stream.take(1)(n.stream("u1")));
			}),
		);
		expect(head._tag).toBe("Some");
	});

	it("live fan-out reaches only the owning user's stream", async () => {
		// u2 has no persisted rows in this db → its stream waits on the
		// pubsub; the u1 event must be filtered out.
		const result = await runtime.runPromise(
			Effect.provideService(
				Effect.gen(function* () {
					const n = yield* Notifications;
					const bus = yield* EventBus;
					const fiber = yield* Stream.runCollect(Stream.take(1)(n.stream("u2"))).pipe(
						Effect.forkChild,
					);
					// Let the stream subscribe to the pubsub before publishing.
					yield* Effect.sleep("50 millis");
					yield* bus.dispatch([
						PatientCreated.make({ id: 10, ownerId: "u1", name: "Not Yours" }),
						PatientCreated.make({ id: 11, ownerId: "u2", name: "Live" }),
					]);
					return yield* Fiber.join(fiber);
				}),
				Principal,
				{ userId: "u2" },
			),
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			title: "Patient created",
			description: "Live",
		});
	});

	it("fails Forbidden for another userId and for null principal", async () => {
		await expect(
			asUser(
				"u2",
				call((n) => n.list("u1")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				null,
				call((n) => n.unreadCount("u1")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u1",
				call((n) => n.markAllRead("u2")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("CQRS queries and commands dispatch with principal authz", async () => {
		const out = await runtime.runPromise(
			Effect.provideService(
				Effect.gen(function* () {
					const bus = yield* EventBus;
					yield* bus.dispatch([PatientCreated.make({ id: 12, ownerId: "u1", name: "Counted" })]);
					const queries = yield* Query.dispatcher(NotificationsQueries);
					const commands = yield* Command.dispatcher(NotificationsCommands);
					const count = yield* queries["notifications.unreadCount"]({
						userId: "u1",
					});
					yield* commands["notifications.markAllRead"]({ userId: "u1" });
					const after = yield* queries["notifications.unreadCount"]({
						userId: "u1",
					});
					return { count, after };
				}).pipe(Effect.scoped),
				Principal,
				{ userId: "u1" },
			),
		);
		expect(out.count).toBeGreaterThan(0);
		expect(out.after).toBe(0);
	});

	it("CQRS list query and markRead command dispatch with principal authz", async () => {
		const out = await runtime.runPromise(
			Effect.provideService(
				Effect.gen(function* () {
					const bus = yield* EventBus;
					yield* bus.dispatch([PatientCreated.make({ id: 13, ownerId: "u1", name: "Listed" })]);
					const queries = yield* Query.dispatcher(NotificationsQueries);
					const commands = yield* Command.dispatcher(NotificationsCommands);
					const rows = yield* queries["notifications.list"]({
						userId: "u1",
						limit: 1,
					});
					yield* commands["notifications.markRead"]({
						userId: "u1",
						ids: rows.map((r) => r.id),
					});
					const after = yield* queries["notifications.list"]({
						userId: "u1",
						limit: 1,
					});
					return { rows, after };
				}).pipe(Effect.scoped),
				Principal,
				{ userId: "u1" },
			),
		);
		expect(out.rows).toHaveLength(1);
		expect(out.rows[0]?.readAt).toBeNull();
		expect(out.after[0]?.readAt).toBeInstanceOf(Date);
	});

	it("markRead fans the updated row out so other streams see it read", async () => {
		const result = await runtime.runPromise(
			Effect.provideService(
				Effect.gen(function* () {
					const n = yield* Notifications;
					const bus = yield* EventBus;
					yield* bus.dispatch([PatientCreated.make({ id: 20, ownerId: "u1", name: "StreamRead" })]);
					const rows = yield* n.list("u1");
					const target = rows.find((r) => r.body === "StreamRead");
					if (target === undefined) return null;
					// A second "device": same userId stream, waiting for the
					// live read-update frame (backlog replay emits read:false
					// first and is filtered out).
					const fiber = yield* Stream.runHead(
						n.stream("u1").pipe(
							Stream.filter((item) => item.id === String(target.id) && item.read === true),
							Stream.take(1),
						),
					).pipe(Effect.forkChild);
					// Let the stream subscribe to the pubsub before publishing.
					yield* Effect.sleep("50 millis");
					yield* n.markRead("u1", [target.id]);
					return yield* Fiber.join(fiber);
				}),
				Principal,
				{ userId: "u1" },
			),
		);
		expect(result).toMatchObject({
			_tag: "Some",
			value: { read: true, meta: "patient.created" },
		});
	});

	it("command-dispatched markAllRead propagates read state to the stream", async () => {
		const result = await runtime.runPromise(
			Effect.provideService(
				Effect.gen(function* () {
					const n = yield* Notifications;
					const bus = yield* EventBus;
					const commands = yield* Command.dispatcher(NotificationsCommands);
					yield* bus.dispatch([PatientCreated.make({ id: 21, ownerId: "u1", name: "CmdRead" })]);
					const rows = yield* n.list("u1");
					const target = rows.find((r) => r.body === "CmdRead");
					if (target === undefined) return null;
					const fiber = yield* Stream.runHead(
						n.stream("u1").pipe(
							Stream.filter((item) => item.id === String(target.id) && item.read === true),
							Stream.take(1),
						),
					).pipe(Effect.forkChild);
					yield* Effect.sleep("50 millis");
					yield* commands["notifications.markAllRead"]({ userId: "u1" });
					return yield* Fiber.join(fiber);
				}).pipe(Effect.scoped),
				Principal,
				{ userId: "u1" },
			),
		);
		expect(result).toMatchObject({ _tag: "Some", value: { read: true } });
	});
});

describe("plugins", () => {
	it("declares the header action contribution", () => {
		expect(notificationsHeaderPlugin.id).toBe("notifications.header");
		expect(notificationsHeaderPlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(notificationsHeaderPlugin.optionalDeps).toEqual(["platform.header"]);
		expect(notificationsHeaderPlugin.chrome).toHaveLength(1);
		expect(notificationsHeaderPlugin.chrome?.[0]).toMatchObject({
			region: "portal.header.actions",
			content: { kind: "headerAction", id: "notifications" },
		});
	});

	it("declares the /platform dashboard slot contribution", () => {
		expect(notificationsDashboardPlugin.id).toBe("notifications.dashboard");
		expect(notificationsDashboardPlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(notificationsDashboardPlugin.chrome).toHaveLength(1);
		expect(notificationsDashboardPlugin.chrome?.[0]).toMatchObject({
			region: "portal.dashboard.sections",
			when: { paths: ["/platform"] },
			content: { kind: "component" },
		});
	});

	it("declares tables and services as single-concern plugins", () => {
		expect(notificationsTablesPlugin.id).toBe("notifications.tables");
		expect(notificationsTablesPlugin.tables?.notifications).toBeDefined();
		expect(notificationsServicesPlugin.id).toBe("notifications.services");
		expect(notificationsServicesPlugin.requiredDeps).toEqual([
			"patients.services",
			"consultations.services",
		]);
		expect(notificationsServicesPlugin.services).toBeDefined();
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"notifications.header",
			"notifications.dashboard",
			"notifications.tables",
			"notifications.services",
			"notifications.cqrs",
			"notifications.routes",
		]);
	});
});
