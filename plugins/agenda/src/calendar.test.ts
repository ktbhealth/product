import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventBus, type EventBusShape, makeEventBus } from "@effect-server-utils/cqrs";
import { Principal } from "@ktb/authz";
import { Calendars, makeCalendarsRegistry, type ExternalCalendarEvent } from "@ktb/calendar";
import { ConsultationsLive } from "@ktb/consultations";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { appointments } from "@ktb/db/schema";
import { eq } from "drizzle-orm";
import { PatientsLive, PatientsQueriesLive } from "@ktb/patients";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { buildPermissions, Permissions } from "@ktb/rbac";
import { Secrets, secretRefFor, type SecretMeta } from "@ktb/vault";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { CalendarIntegrations, CalendarIntegrationsLive } from "./calendar.ts";
import { AppointmentsLive } from "./service.ts";

const FIXTURE_SQL = `
INSERT INTO "user" (id, name, email, email_verified, image, banned, created_at, updated_at) VALUES ('u1', 'Dra', 'd@x.com', 0, NULL, 0, 0, 0), ('u2', 'Drb', 'b@x.com', 0, NULL, 0, 0, 0);
INSERT INTO patients (id, owner_id, name, created_at) VALUES (1, 'u1', 'Ana Silva', 0), (2, 'u1', 'Bia Souza', 0), (3, 'u2', 'Ana Silva', 0);
INSERT INTO relation_tuples (object_type, object_id, relation, subject_kind, subject_id, effect, created_at) VALUES
('patient', '1', 'owner', 'user', 'u1', 'allow', 0),
('patient', '2', 'owner', 'user', 'u1', 'allow', 0),
('patient', '3', 'owner', 'user', 'u2', 'allow', 0);
`;

const event = (
	id: string,
	title: string,
	startsAt: Date,
	minutes: number,
	extra: Partial<ExternalCalendarEvent> = {},
): ExternalCalendarEvent => ({
	id,
	calendarId: "primary",
	title,
	startsAt,
	endsAt: new Date(startsAt.getTime() + minutes * 60_000),
	status: "confirmed",
	updatedAt: startsAt,
	...extra,
});

const memorySecrets = () => {
	let seq = 0;
	const values = new Map<string, string>();
	return {
		values,
		service: Secrets.of({
			list: () => Effect.succeed([]),
			put: (input) =>
				Effect.sync(() => {
					const id = ++seq;
					values.set(secretRefFor(id), input.value);
					return {
						id,
						scope: `user:${input.userId ?? ""}`,
						tenantId: null,
						name: input.name,
						provider: input.provider ?? null,
						kind: input.kind ?? "generic",
						hint: input.hint ?? null,
						version: 1,
						status: "active",
						kekVersion: null,
						createdBy: null,
						createdAt: new Date(),
						updatedAt: null,
						rotatedAt: null,
					} satisfies SecretMeta;
				}),
			resolve: (ref) => Effect.succeed(values.get(ref) ?? null),
			rotate: () => Effect.die(new Error("unused")),
			remove: () => Effect.void,
		}),
	};
};

describe("CalendarIntegrationsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<CalendarIntegrations, never>;
	let db: ReturnType<typeof makeDb>;
	let externalEvents: ExternalCalendarEvent[];
	let refreshCalls: string[];

	beforeAll(async () => {
		db = makeDb(makeTestD1(FIXTURE_SQL));
		const busRuntime = ManagedRuntime.make(makeEventBus());
		const bus: EventBusShape = await busRuntime.runPromise(EventBus);
		externalEvents = [];
		refreshCalls = [];
		const google = {
			id: "google",
			oauth: {
				authorizationUrl: () => "https://oauth.example/auth",
				exchangeCode: async () => ({ accessToken: "unused" }),
				refresh: async (credentials: { readonly refreshToken?: string }) => {
					refreshCalls.push(credentials.refreshToken ?? "");
					return {
						accessToken: "access-refreshed",
						refreshToken: credentials.refreshToken,
						expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
					};
				},
			},
			connect: async () => ({
				provider: "google",
				listEvents: async () => externalEvents,
				createEvent: async () => {
					throw new Error("unused");
				},
				updateEvent: async () => {
					throw new Error("unused");
				},
				cancelEvent: async () => {},
				syncEvents: async () => ({ events: [], deletedIds: [], nextSyncToken: "1" }),
			}),
		};
		const secrets = memorySecrets();
		const infra = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			Layer.succeed(Permissions, buildPermissions(db)),
			Layer.succeed(EventBus, bus),
			Layer.succeed(Calendars, makeCalendarsRegistry([google])),
			Layer.succeed(Secrets, secrets.service),
		);
		const queries = PatientsQueriesLive.pipe(Layer.provide(infra));
		const patients = PatientsLive.pipe(Layer.provide(infra));
		const consults = ConsultationsLive.pipe(Layer.provideMerge(queries), Layer.provideMerge(infra));
		const appointmentsSvc = AppointmentsLive.pipe(
			Layer.provideMerge(consults),
			Layer.provideMerge(queries),
			Layer.provideMerge(infra),
		);
		const services = CalendarIntegrationsLive.pipe(
			Layer.provideMerge(appointmentsSvc),
			Layer.provideMerge(patients),
			Layer.provideMerge(infra),
		);
		runtime = ManagedRuntime.make(services);
	});

	afterAll(() => runtime.dispose());

	const asDoctor = <A, E>(effect: Effect.Effect<A, E, CalendarIntegrations>) =>
		runtime.runPromise(Effect.provideService(effect, Principal, { userId: "u1" }));
	const asDoctor2 = <A, E>(effect: Effect.Effect<A, E, CalendarIntegrations>) =>
		runtime.runPromise(Effect.provideService(effect, Principal, { userId: "u2" }));
	const call = <A, E>(f: (p: CalendarIntegrations["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(CalendarIntegrations, f);

	it("stores OAuth material in the vault and exposes only connection metadata", async () => {
		const connection = await asDoctor(
			call((p) =>
				p.completeOAuth("u1", {
					provider: "google",
					calendarId: "primary",
					credentials: { accessToken: "access", refreshToken: "refresh" },
				}),
			),
		);
		expect(connection).toMatchObject({
			provider: "google",
			calendarId: "primary",
			status: "active",
		});
		expect(JSON.stringify(connection)).not.toContain("refresh");
		expect(await asDoctor(call((p) => p.connection("u1", "google", "primary")))).toMatchObject({
			id: connection.id,
		});
	});

	it("imports confident patient matches once and returns unmatched events for review", async () => {
		const base = new Date(Date.now() + 24 * 60 * 60 * 1000);
		externalEvents = [
			event("evt-ana", "Consulta Ana Silva", base, 30),
			event("evt-personal", "Lunch with family", new Date(base.getTime() + 60 * 60_000), 30),
			event("evt-mariana", "Consulta Mariana", new Date(base.getTime() + 90 * 60_000), 30),
			event("evt-allday", "Conference", new Date(base.getTime() + 2 * 60 * 60_000), 60, {
				allDay: true,
			}),
		];
		await asDoctor(
			call((p) =>
				p.completeOAuth("u1", {
					provider: "google",
					calendarId: "primary",
					credentials: { accessToken: "access", refreshToken: "refresh" },
				}),
			),
		);
		const input = {
			provider: "google",
			calendarId: "primary",
			from: new Date(base.getTime() - 60_000),
			to: new Date(base.getTime() + 4 * 60 * 60_000),
		};
		const first = await asDoctor(call((p) => p.importEvents("u1", input)));
		expect(first.imported).toBe(1);
		expect(first.review.map((item) => item.externalEventId).sort()).toEqual([
			"evt-allday",
			"evt-mariana",
			"evt-personal",
		]);
		const rows = await db
			.select()
			.from(appointments)
			.where(eq(appointments.externalEventId, "evt-ana"));
		expect(rows[0]).toMatchObject({
			patientId: 1,
			externalProvider: "google",
			externalCalendarId: "primary",
			syncState: "synced",
		});

		const second = await asDoctor(call((p) => p.importEvents("u1", input)));
		expect(second).toMatchObject({ imported: 0, existing: 1 });
	});

	it("dedupes external event identity per owner, not globally across doctors", async () => {
		const base = new Date(Date.now() + 96 * 60 * 60 * 1000);
		externalEvents = [event("evt-shared-alias", "Consulta Ana Silva", base, 30)];
		for (const [as, owner] of [
			[asDoctor, "u1"],
			[asDoctor2, "u2"],
		] as const) {
			await as(
				call((p) =>
					p.completeOAuth(owner, {
						provider: "google",
						calendarId: "primary",
						credentials: { accessToken: "access", refreshToken: "refresh" },
					}),
				),
			);
		}
		const input = {
			provider: "google",
			calendarId: "primary",
			from: new Date(base.getTime() - 60_000),
			to: new Date(base.getTime() + 60 * 60_000),
		};
		expect((await asDoctor(call((p) => p.importEvents("u1", input)))).imported).toBe(1);
		const secondDoctor = await asDoctor2(call((p) => p.importEvents("u2", input)));
		expect(secondDoctor).toMatchObject({ imported: 1, existing: 0 });
		const rows = await db
			.select({ ownerId: appointments.ownerId })
			.from(appointments)
			.where(eq(appointments.externalEventId, "evt-shared-alias"));
		expect(rows.map((row) => row.ownerId).sort()).toEqual(["u1", "u2"]);
	});

	it("refreshes expired OAuth credentials before reading provider events", async () => {
		const base = new Date(Date.now() + 72 * 60 * 60 * 1000);
		externalEvents = [event("evt-refresh", "Consulta Ana Silva", base, 30)];
		await asDoctor(
			call((p) =>
				p.completeOAuth("u1", {
					provider: "google",
					calendarId: "primary",
					credentials: {
						accessToken: "expired",
						refreshToken: "refresh-me",
						expiresAt: new Date(Date.now() - 60_000).toISOString(),
					},
				}),
			),
		);
		const result = await asDoctor(
			call((p) =>
				p.importEvents("u1", {
					provider: "google",
					calendarId: "primary",
					from: new Date(base.getTime() - 60_000),
					to: new Date(base.getTime() + 60 * 60_000),
				}),
			),
		);
		expect(result.imported).toBe(1);
		expect(refreshCalls).toContain("refresh-me");
	});

	it("reports overlap as a per-event conflict instead of failing the import", async () => {
		const base = new Date(Date.now() + 48 * 60 * 60 * 1000);
		externalEvents = [event("evt-bia", "Consulta Bia Souza", base, 30)];
		await asDoctor(
			call((p) =>
				p.completeOAuth("u1", {
					provider: "google",
					calendarId: "primary",
					credentials: { accessToken: "access", refreshToken: "refresh" },
				}),
			),
		);
		await db.insert(appointments).values({
			ownerId: "u1",
			patientId: 2,
			startsAt: base,
			durationMin: 30,
			status: "scheduled",
			reminderSentAt: null,
			consultationId: null,
			createdAt: new Date(),
		});
		const result = await asDoctor(
			call((p) =>
				p.importEvents("u1", {
					provider: "google",
					calendarId: "primary",
					from: new Date(base.getTime() - 60_000),
					to: new Date(base.getTime() + 60 * 60_000),
				}),
			),
		);
		expect(result).toMatchObject({ imported: 0 });
		expect(result.conflicts).toEqual([
			{ externalEventId: "evt-bia", conflictingId: expect.any(Number) },
		]);
	});
});
