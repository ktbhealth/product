import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import { and, eq, inArray } from "drizzle-orm";

import { Forbidden, requirePrincipalUser } from "@ktb/authz";
import {
	Calendars,
	overlapWindowFilter,
	type CalendarCredentials,
	type ExternalCalendarEvent,
} from "@ktb/calendar";
import type { FilterExpr } from "@ktb/filters";
import { Db, type DbClient } from "@ktb/db";
import { appointments, calendarConnections } from "@ktb/db/schema";
import { Patients, type Patient } from "@ktb/patients";
import { Tenant, tenantScopeId } from "@ktb/tenant";
import { Secrets, secretRefFor } from "@ktb/vault";

import { Appointments } from "./service.ts";
import type { CalendarConnection } from "./schema.ts";

export class CalendarIntegrationError extends Data.TaggedError("CalendarIntegrationError")<{
	readonly reason: "unavailable" | "not-connected" | "invalid-credentials" | "provider-error";
	readonly detail?: string;
}> {}

export interface CalendarConnectionCard {
	readonly id: number;
	readonly provider: string;
	readonly calendarId: string;
	readonly status: string;
	readonly lastSyncAt: Date | null;
}

export interface CalendarImportReviewItem {
	readonly externalEventId: string;
	readonly title: string;
	readonly startsAt: Date;
	readonly endsAt: Date;
	readonly reason: "patient-needed" | "ambiguous-patient" | "all-day" | "cancelled";
}

export interface CalendarImportConflictItem {
	readonly externalEventId: string;
	readonly conflictingId?: number;
}

/** Outcome of scheduling one review item with a chosen patient. */
export type CalendarImportResolveResult =
	| { readonly status: "created" | "existing" }
	| { readonly status: "conflict"; readonly conflictingId?: number };

export interface CalendarImportResult {
	readonly imported: number;
	readonly existing: number;
	readonly skipped: number;
	readonly review: readonly CalendarImportReviewItem[];
	readonly conflicts: readonly CalendarImportConflictItem[];
}

const toCard = (row: CalendarConnection): CalendarConnectionCard => ({
	id: row.id,
	provider: row.provider,
	calendarId: row.externalCalendarId,
	status: row.status,
	lastSyncAt: row.lastSyncAt,
});

export async function findConnection(
	db: DbClient,
	ownerId: string,
	provider: string,
	calendarId: string,
): Promise<CalendarConnection | null> {
	const rows = await db
		.select()
		.from(calendarConnections)
		.where(
			and(
				eq(calendarConnections.ownerId, ownerId),
				eq(calendarConnections.provider, provider),
				eq(calendarConnections.externalCalendarId, calendarId),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

export async function upsertConnection(
	db: DbClient,
	values: {
		readonly ownerId: string;
		readonly tenantId: number | null;
		readonly provider: string;
		readonly calendarId: string;
		readonly credentialRef: string;
	},
): Promise<CalendarConnection> {
	const rows = await db
		.insert(calendarConnections)
		.values({
			ownerId: values.ownerId,
			tenantId: values.tenantId,
			provider: values.provider,
			externalCalendarId: values.calendarId,
			credentialRef: values.credentialRef,
			status: "active",
			createdAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [
				calendarConnections.ownerId,
				calendarConnections.provider,
				calendarConnections.externalCalendarId,
			],
			set: {
				credentialRef: values.credentialRef,
				status: "active",
				tenantId: values.tenantId,
			},
		})
		.returning();
	return rows[0]!;
}

const secretName = (provider: string, calendarId: string) => `calendar:${provider}:${calendarId}`;

const parseCredentials = (raw: string | null): CalendarCredentials | null => {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? (parsed as CalendarCredentials) : null;
	} catch {
		return null;
	}
};

const normalize = (value: string): string =>
	value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

/** Exact normalized-name containment on token boundaries. Substring
 * matching without the boundaries is not a confident match ("Ana"
 * inside "Mariana"), while fuzzy matching is deliberately out of MVP. */
const matchingPatients = (title: string, patients: readonly Patient[]): readonly Patient[] => {
	const haystack = ` ${normalize(title)} `;
	return patients.filter((patient) => {
		const needle = normalize(patient.name);
		return needle.length >= 3 && haystack.includes(` ${needle} `);
	});
};

const durationMin = (event: ExternalCalendarEvent): number =>
	Math.max(1, Math.round((event.endsAt.getTime() - event.startsAt.getTime()) / 60_000));

/** External-calendar connection/import domain. One-way import first:
 * provider events become appointments only when exactly one patient can
 * be matched with high confidence; ambiguous events are returned for
 * review instead of being silently imported. */
export class CalendarIntegrations extends Context.Service<
	CalendarIntegrations,
	{
		readonly connection: (
			ownerId: string,
			provider: string,
			calendarId?: string,
		) => Effect.Effect<CalendarConnectionCard | null, Forbidden>;
		readonly completeOAuth: (
			ownerId: string,
			input: {
				readonly provider: string;
				readonly calendarId?: string;
				readonly credentials: CalendarCredentials;
			},
		) => Effect.Effect<CalendarConnectionCard, Forbidden | CalendarIntegrationError>;
		readonly importEvents: (
			ownerId: string,
			input: {
				readonly provider: string;
				readonly calendarId?: string;
				/** Provider-agnostic filter (@ktb/filters AST) — the date
				 * range rides inside it as `endsAt gt`/`startsAt lt` overlap
				 * conditions. Absent → the current month (UTC) is imported. */
				readonly filter?: FilterExpr;
			},
		) => Effect.Effect<CalendarImportResult, Forbidden | CalendarIntegrationError>;
		readonly resolveImportItem: (
			ownerId: string,
			input: {
				readonly provider: string;
				readonly calendarId?: string;
				readonly externalEventId: string;
				readonly startsAt: Date;
				readonly endsAt: Date;
				readonly patientId: number;
			},
		) => Effect.Effect<CalendarImportResolveResult, Forbidden | CalendarIntegrationError>;
	}
>()("@ktb/agenda/CalendarIntegrations") {}

/** Server-side default import window: the current month in UTC —
 * overlap semantics, so events bleeding across the boundary come along.
 * The UI normally sends an explicit range in the user's own timezone;
 * this fallback exists for bare API callers. */
const currentMonthWindowFilter = (now: Date): FilterExpr => {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
	return overlapWindowFilter(start, end);
};

export const CalendarIntegrationsLive = Layer.effect(
	CalendarIntegrations,
	Effect.gen(function* () {
		const db = yield* Db;
		const calendars = yield* Calendars;
		const appointmentsSvc = yield* Appointments;
		const patientsSvc = yield* Patients;
		const secretsOption = yield* Effect.serviceOption(Secrets);
		const secrets = Option.isSome(secretsOption) ? secretsOption.value : null;

		const requireSecrets = () =>
			secrets === null
				? Effect.fail(
						new CalendarIntegrationError({
							reason: "unavailable",
							detail: "vault secrets unavailable",
						}),
					)
				: Effect.succeed(secrets);

		return CalendarIntegrations.of({
			connection: Effect.fn("CalendarIntegrations.connection")(function* (
				ownerId,
				provider,
				calendarId = "primary",
			) {
				yield* requirePrincipalUser(ownerId, "calendar.read");
				const row = yield* Effect.promise(() => findConnection(db, ownerId, provider, calendarId));
				return row === null || row.status !== "active" ? null : toCard(row);
			}),
			completeOAuth: Effect.fn("CalendarIntegrations.completeOAuth")(function* (ownerId, input) {
				yield* requirePrincipalUser(ownerId, "calendar.connect");
				if (calendars.provider(input.provider) === undefined) {
					return yield* Effect.fail(
						new CalendarIntegrationError({
							reason: "unavailable",
							detail: "provider not registered",
						}),
					);
				}
				const vault = yield* requireSecrets();
				const serialized = JSON.stringify(input.credentials);
				const meta = yield* vault
					.put({
						tenantId: null,
						userId: ownerId,
						name: secretName(input.provider, input.calendarId ?? "primary"),
						value: serialized,
						provider: input.provider,
						kind: "token",
					})
					.pipe(
						Effect.mapError((error) => {
							const structured =
								typeof error === "object" && error !== null && "reason" in error
									? `${String((error as { reason: unknown }).reason)}: ${String((error as { detail?: unknown }).detail ?? "")}`
									: error instanceof Error
										? error.message
										: String(error);
							return new CalendarIntegrationError({
								reason: "unavailable",
								detail: structured,
							});
						}),
					);
				const tenant = yield* Tenant;
				const row = yield* Effect.promise(() =>
					upsertConnection(db, {
						ownerId,
						tenantId: tenantScopeId(tenant),
						provider: input.provider,
						calendarId: input.calendarId ?? "primary",
						credentialRef: secretRefFor(meta.id),
					}),
				);
				return toCard(row);
			}),
			importEvents: Effect.fn("CalendarIntegrations.importEvents")(function* (ownerId, input) {
				yield* requirePrincipalUser(ownerId, "calendar.import");
				const calendarId = input.calendarId ?? "primary";
				const connectionRow = yield* Effect.promise(() =>
					findConnection(db, ownerId, input.provider, calendarId),
				);
				if (connectionRow === null || connectionRow.status !== "active") {
					return yield* Effect.fail(new CalendarIntegrationError({ reason: "not-connected" }));
				}
				const vault = yield* requireSecrets();
				const provider = calendars.provider(input.provider);
				if (provider === undefined) {
					return yield* Effect.fail(
						new CalendarIntegrationError({
							reason: "unavailable",
							detail: "provider not registered",
						}),
					);
				}
				const raw = yield* vault.resolve(connectionRow.credentialRef).pipe(
					Effect.mapError(
						(error) =>
							new CalendarIntegrationError({
								reason: "invalid-credentials",
								detail: String(error),
							}),
					),
				);
				let credentials = parseCredentials(raw);
				if (credentials === null) {
					return yield* Effect.fail(
						new CalendarIntegrationError({ reason: "invalid-credentials" }),
					);
				}
				const expiresAt =
					typeof credentials.expiresAt === "string" ? Date.parse(credentials.expiresAt) : null;
				if (expiresAt !== null && expiresAt <= Date.now() + 60_000) {
					if (provider.oauth === undefined) {
						return yield* Effect.fail(
							new CalendarIntegrationError({ reason: "invalid-credentials" }),
						);
					}
					credentials = yield* Effect.tryPromise({
						try: () => provider.oauth!.refresh(credentials!),
						catch: (error) =>
							new CalendarIntegrationError({ reason: "provider-error", detail: String(error) }),
					});
					yield* vault
						.put({
							tenantId: null,
							userId: ownerId,
							name: secretName(input.provider, calendarId),
							value: JSON.stringify(credentials),
							provider: input.provider,
							kind: "token",
						})
						.pipe(Effect.catch(() => Effect.void));
				}
				const external = yield* Effect.tryPromise({
					try: () => provider.connect(credentials!),
					catch: (error) =>
						new CalendarIntegrationError({ reason: "provider-error", detail: String(error) }),
				});
				const filter = input.filter ?? currentMonthWindowFilter(new Date());
				const events = yield* Effect.tryPromise({
					try: () =>
						external.listEvents(calendarId, {
							filter,
							expandRecurring: true,
						}),
					catch: (error) =>
						new CalendarIntegrationError({ reason: "provider-error", detail: String(error) }),
				});
				const eventIds = events.map((event) => event.id);
				const existingRows =
					eventIds.length === 0
						? []
						: yield* Effect.promise(() =>
								db
									.select({ externalEventId: appointments.externalEventId })
									.from(appointments)
									.where(
										and(
											eq(appointments.ownerId, ownerId),
											eq(appointments.externalProvider, input.provider),
											eq(appointments.externalCalendarId, calendarId),
											inArray(appointments.externalEventId, eventIds),
										),
									),
							);
				const existingIds = new Set(existingRows.map((row) => row.externalEventId));
				const patientRows = yield* patientsSvc.list(ownerId);
				const review: CalendarImportReviewItem[] = [];
				const conflicts: CalendarImportConflictItem[] = [];
				let imported = 0;
				let existing = 0;
				let skipped = 0;
				for (const event of events) {
					if (existingIds.has(event.id)) {
						existing += 1;
						continue;
					}
					if (event.status === "cancelled") {
						skipped += 1;
						review.push({
							externalEventId: event.id,
							title: event.title,
							startsAt: event.startsAt,
							endsAt: event.endsAt,
							reason: "cancelled",
						});
						continue;
					}
					if (event.allDay === true) {
						skipped += 1;
						review.push({
							externalEventId: event.id,
							title: event.title,
							startsAt: event.startsAt,
							endsAt: event.endsAt,
							reason: "all-day",
						});
						continue;
					}
					const matches = matchingPatients(event.title, patientRows);
					if (matches.length !== 1) {
						skipped += 1;
						review.push({
							externalEventId: event.id,
							title: event.title,
							startsAt: event.startsAt,
							endsAt: event.endsAt,
							reason: matches.length === 0 ? "patient-needed" : "ambiguous-patient",
						});
						continue;
					}
					const created = yield* appointmentsSvc
						.create(ownerId, {
							patientId: matches[0]!.id,
							startsAt: event.startsAt,
							durationMin: durationMin(event),
							external: {
								provider: input.provider,
								calendarId,
								eventId: event.id,
								...(event.etag === undefined ? {} : { etag: event.etag }),
							},
						})
						.pipe(Effect.result);
					if (Result.isSuccess(created)) {
						if (created.success !== null) imported += 1;
						continue;
					}
					if (created.failure._tag === "AppointmentConflict") {
						conflicts.push({
							externalEventId: event.id,
							conflictingId: created.failure.conflictingId,
						});
						skipped += 1;
						continue;
					}
					return yield* Effect.fail(created.failure);
				}
				yield* Effect.promise(() =>
					db
						.update(calendarConnections)
						.set({ lastSyncAt: new Date() })
						.where(eq(calendarConnections.id, connectionRow.id)),
				);
				return { imported, existing, skipped, review, conflicts };
			}),
			resolveImportItem: Effect.fn("CalendarIntegrations.resolveImportItem")(
				function* (ownerId, input) {
					yield* requirePrincipalUser(ownerId, "calendar.import");
					const minutes = Math.max(
						1,
						Math.round((input.endsAt.getTime() - input.startsAt.getTime()) / 60_000),
					);
					const created = yield* appointmentsSvc
						.create(ownerId, {
							patientId: input.patientId,
							startsAt: input.startsAt,
							durationMin: minutes,
							external: {
								provider: input.provider,
								calendarId: input.calendarId ?? "primary",
								eventId: input.externalEventId,
							},
						})
						.pipe(Effect.result);
					if (Result.isSuccess(created)) {
						return { status: created.success === null ? "existing" : "created" } as const;
					}
					if (created.failure._tag === "AppointmentConflict") {
						return {
							status: "conflict",
							...(created.failure.conflictingId === undefined
								? {}
								: { conflictingId: created.failure.conflictingId }),
						} as const;
					}
					return yield* Effect.fail(created.failure);
				},
			),
		});
	}),
);
