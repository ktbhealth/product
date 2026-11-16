import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, asc, desc, eq, isNotNull, or, type SQL } from "drizzle-orm";
import { physical } from "@tanstack/virtual-file-routes";
import { UsersIcon } from "lucide-react";

import { audit, auditServicesPlugin } from "@ktb/audit";
import { Db, type DbClient } from "@ktb/db";
import { patientDocuments, patients, user as users } from "@ktb/db/schema";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { Command, EventBus, Query } from "@effect-server-utils/cqrs";
import { PatientCreated, PatientDeleted, PatientsCommands, PatientsQueries } from "./api.ts";
import { PatientsPlatformPage } from "./platform-page.tsx";
import {
	PlatformAdmin,
	platformAdminPlugin,
	platformPanelPlugin,
	type PlatformAdminShape,
} from "@ktb/platform";
import { Forbidden, requireCanAs, requirePrincipalUser } from "@ktb/authz";
import { accessibleTenantIds, Tenant, tenantScopeCondition, tenantScopeId } from "@ktb/tenant";
import { tenantIsZk } from "@ktb/vault";
import {
	isPatientDocumentType,
	PATIENT_DOCUMENT_KEYS,
	PATIENT_DOCUMENT_TYPES,
	TEXT_FIELDS,
	type PatientDocumentType,
	type PatientFields,
	type PatientIdentifiers,
} from "./record.ts";

type PatientRow = typeof patients.$inferSelect;

/**
 * A patient as the app reads it: the `patients` row plus its documents
 * (`patient_documents`) flattened into one field per kind — `cpf`,
 * `cns`, `passport` — null where the record has none. Storage is one
 * row per document; this read model keeps every consumer (views, PDF,
 * interop exports) on plain fields.
 */
export type Patient = PatientRow & PatientIdentifiers;

const noIdentifiers = (): PatientIdentifiers =>
	Object.fromEntries(PATIENT_DOCUMENT_KEYS.map((type) => [type, null])) as PatientIdentifiers;

/**
 * Attach each row's documents. One query for the whole set, joined on
 * the same condition that selected the rows — never an id list, which
 * would run into D1's bound-parameter limit on a large register.
 */
async function withIdentifiers<R extends { readonly id: number }>(
	db: DbClient,
	rows: readonly R[],
	where?: SQL,
): Promise<(R & PatientIdentifiers)[]> {
	if (rows.length === 0) return [];
	const documents = await db
		.select({
			patientId: patientDocuments.patientId,
			type: patientDocuments.type,
			number: patientDocuments.number,
		})
		.from(patientDocuments)
		.innerJoin(patients, eq(patientDocuments.patientId, patients.id))
		.where(where);
	const byPatient = new Map<number, PatientIdentifiers>();
	for (const document of documents) {
		// A type this build does not know (written by a newer one) is not
		// part of the read model.
		if (!isPatientDocumentType(document.type)) continue;
		const identifiers = byPatient.get(document.patientId) ?? noIdentifiers();
		identifiers[document.type] = document.number;
		byPatient.set(document.patientId, identifiers);
	}
	return rows.map((row) => ({
		...row,
		...(byPatient.get(row.id) ?? noIdentifiers()),
	}));
}

/** Split validated record fields into the `patients` columns and the
 * document rows — one per identifier the record actually has. */
const splitFields = (fields: PatientFields) => {
	const row: Partial<PatientFields> = { ...fields };
	const identifiers = noIdentifiers();
	const documents: {
		type: PatientDocumentType;
		country: string | null;
		number: string;
	}[] = [];
	for (const type of PATIENT_DOCUMENT_KEYS) {
		const number = fields[type];
		delete row[type];
		identifiers[type] = number;
		if (number !== null) {
			documents.push({
				type,
				country: PATIENT_DOCUMENT_TYPES[type].country,
				number,
			});
		}
	}
	return {
		row: row as Omit<PatientFields, PatientDocumentType>,
		identifiers,
		documents,
	};
};

/** Admin-console row: patient plus the owning user's display fields. */
export interface AdminPatientRow extends Patient {
	readonly ownerEmail: string | null;
	readonly ownerName: string | null;
}

/**
 * Tenant visibility fence (P-053-B). A patient row is visible to the
 * caller when the `tenantScopeCondition` fence admits it (its
 * `tenant_id` is NULL or in the caller's accessible tenant set —
 * `Tenant`/`TenantAccess`) AND it is either a personal row they own
 * (`owner_id` = caller, `tenant_id` NULL) or a tenant-owned row
 * (`tenant_id` NOT NULL — membership already proved by the fence).
 * In personal scope the accessible set is empty, so this degrades to
 * "own personal rows only".
 */
export const patientScope = (ownerId: string) =>
	Effect.map(tenantScopeCondition(patients), (fence) =>
		and(fence, or(eq(patients.ownerId, ownerId), isNotNull(patients.tenantId))),
	);

export async function listPatients(db: DbClient, ownerId: string, where?: SQL) {
	const scope = where ?? eq(patients.ownerId, ownerId);
	const rows = await db.select().from(patients).where(scope).orderBy(asc(patients.name));
	return withIdentifiers(db, rows, scope);
}

/** Fetches by id regardless of caller — authz happens in the service. */
export async function getPatient(db: DbClient, id: number) {
	const scope = eq(patients.id, id);
	const rows = await db.select().from(patients).where(scope).limit(1);
	const [patient] = await withIdentifiers(db, rows, scope);
	return patient ?? null;
}

/**
 * Cross-owner listing for the /platform console. Callers MUST have
 * passed the `PlatformAdmin` gate first — this repo function itself is
 * unauthenticated, like the other `*Patients` helpers.
 */
export async function listAllPatients(db: DbClient): Promise<AdminPatientRow[]> {
	const rows = await db
		.select({
			patient: patients,
			ownerEmail: users.email,
			ownerName: users.name,
		})
		.from(patients)
		.leftJoin(users, eq(patients.ownerId, users.id))
		.orderBy(desc(patients.id));
	return withIdentifiers(
		db,
		rows.map(({ patient, ownerEmail, ownerName }) => ({
			...patient,
			ownerEmail,
			ownerName,
		})),
	);
}

/** Owner-picker options for admin create forms — id + display label. */
export interface OwnerOption {
	readonly id: string;
	readonly label: string;
}

/**
 * User accounts eligible as patient owners. Unauthenticated repo
 * helper — callers MUST pass the `PlatformAdmin` gate first (the
 * `Patients.adminOwners` service method does).
 */
export async function listOwnerOptions(db: DbClient): Promise<OwnerOption[]> {
	const rows = await db
		.select({ id: users.id, email: users.email, name: users.name })
		.from(users)
		.orderBy(asc(users.name));
	return rows.map((r) => ({ id: r.id, label: r.name || r.email || r.id }));
}

/** Owner lookup exposed to other plugins via the `patients.ownerOf`
 * query. `tenantId` lets callers apply tenant visibility (P-053). */
export async function getPatientOwnerId(db: DbClient, id: number) {
	const rows = await db
		.select({ ownerId: patients.ownerId, tenantId: patients.tenantId })
		.from(patients)
		.where(eq(patients.id, id))
		.limit(1);
	return rows[0] ?? null;
}

/** Row delete behind the `patients.delete` command — authz happens in
 * the command handler, not here. The documents go in the same batch
 * rather than relying on the foreign key's cascade alone. */
export async function deletePatientRow(db: DbClient, id: number) {
	await db.batch([
		db.delete(patientDocuments).where(eq(patientDocuments.patientId, id)),
		db.delete(patients).where(eq(patients.id, id)),
	]);
}

export async function createPatient(
	db: DbClient,
	ownerId: string,
	fields: PatientFields,
	tenantId: number | null = null,
) {
	const { row, identifiers, documents } = splitFields(fields);
	const [created] = await db
		.insert(patients)
		.values({ ...row, ownerId, tenantId, createdAt: new Date() })
		.returning();
	if (created === undefined) return null;
	if (documents.length > 0) {
		await db
			.insert(patientDocuments)
			.values(documents.map((document) => ({ ...document, patientId: created.id })));
	}
	return { ...created, ...identifiers };
}

/**
 * Replace the record's fields and documents in one batch (a
 * transaction on D1), so a failed write never leaves the row and its
 * documents out of step. Callers resolve and authorize the row first —
 * `id` is an existing patient.
 */
export async function updatePatient(db: DbClient, id: number, fields: PatientFields) {
	const { row, identifiers, documents } = splitFields(fields);
	const clear = db.delete(patientDocuments).where(eq(patientDocuments.patientId, id));
	const update = db
		.update(patients)
		.set({ ...row, updatedAt: new Date() })
		.where(eq(patients.id, id))
		.returning();
	const [, [updated]] =
		documents.length === 0
			? await db.batch([clear, update])
			: await db.batch([
					clear,
					update,
					db
						.insert(patientDocuments)
						.values(documents.map((document) => ({ ...document, patientId: id }))),
				]);
	return updated === undefined ? null : { ...updated, ...identifiers };
}

/**
 * Owner-scoped authz that a platform admin may override: regular
 * principals must own the row, allowlisted admins pass either way.
 * Used on read/update/delete so the /platform console can manage
 * cross-owner records through the same code paths as owners.
 */
const orPlatformAdmin = (
	platformAdmin: PlatformAdminShape,
	check: Effect.Effect<void, Forbidden>,
) =>
	check.pipe(
		Effect.catchTag("Forbidden", (err) =>
			// Admin override passes silently; when it also fails, re-raise
			// the original owner-violation error (path stays accurate).
			platformAdmin.requireAdmin().pipe(Effect.catchTag("Forbidden", () => Effect.fail(err))),
		),
	);

/** True when `tenantId` is in the caller's accessible tenant set
 * (`Tenant`/`TenantAccess` — empty in personal scope). Ids compare
 * numerically so string|number directory ids both match. */
const tenantRowVisible = (tenantId: number) =>
	Effect.map(accessibleTenantIds, (ids) => ids.some((id) => Number(id) === tenantId));

/**
 * Row-level authz (P-053-B). Tenant-owned rows (`tenant_id` set) are
 * governed by tenant membership: any member of the row's tenant may
 * read/operate it — `ownerId` stays creator attribution and is NOT an
 * access grant outside the tenant (the creator reaches the row by
 * acting inside the tenant, not from personal scope). Everyone else
 * needs the platform-admin override, which works cross-tenant.
 * Personal rows (`tenant_id` NULL) keep the owner-scoped permix check.
 */
const authorizePatientRow = (
	platformAdmin: PlatformAdminShape,
	row: { readonly ownerId: string; readonly tenantId: number | null },
	action: "patient.read" | "patient.update" | "patient.delete",
) =>
	Effect.gen(function* () {
		if (row.tenantId !== null) {
			if (yield* tenantRowVisible(row.tenantId)) return;
			yield* platformAdmin
				.requireAdmin()
				.pipe(Effect.catchTag("Forbidden", () => Effect.fail(new Forbidden({ path: action }))));
			return;
		}
		yield* orPlatformAdmin(platformAdmin, requireCanAs(action, { ownerId: row.ownerId }));
	});

const ENVELOPE = /^v1\./;

/**
 * ZK write gate (PL-007 F3, T-144): under a ZK tenant every non-null
 * PII field must already be a `v1.` AEAD envelope — the server never
 * stores plaintext PII there, so a plaintext write is denied like an
 * authz violation. `name`/`birthDate` stay required (mirroring
 * `validatePatient`), `active` is declared plaintext BY DESIGN. Reads
 * need no gate: rows come back exactly as stored (envelopes for ZK,
 * plaintext otherwise) and clients decrypt.
 */
const zkCipheredFields = (fields: PatientFields) =>
	fields.name !== null &&
	fields.birthDate !== null &&
	TEXT_FIELDS.every((key) => fields[key] === null || ENVELOPE.test(fields[key]!));

/** Any populated PII field already looks like ciphertext. */
const hasCipheredField = (fields: PatientFields) =>
	TEXT_FIELDS.some((key) => fields[key] !== null && ENVELOPE.test(fields[key]!));

const requireCipheredWhenZk = Effect.fn("Patients.requireCipheredWhenZk")(function* (
	db: DbClient,
	tenantId: number | null,
	fields: PatientFields,
	action: "patient.create" | "patient.update",
) {
	const zk = tenantId !== null && (yield* Effect.promise(() => tenantIsZk(db, tenantId)));
	// Fails closed both ways: under ZK every populated PII field must be
	// an envelope; outside ZK (non-ZK tenant or personal scope — no
	// clinic keyring exists there) an envelope write is unreadable
	// forever, so it is denied the same way.
	if (zk ? !zkCipheredFields(fields) : hasCipheredField(fields)) {
		yield* Effect.fail(new Forbidden({ path: action }));
	}
});

/**
 * Patients domain port — Effect service, swappable in tests.
 *
 * Every method enforces authorization against the request `Principal`
 * (@ktb/authz): `ownerId` must be the bound principal's userId and the
 * permix rule for the action must pass against the row's real owner. With
 * no principal (system context) all methods fail `Forbidden` — there is
 * no unauthenticated patient access. `adminList` is the exception: it
 * requires the `PlatformAdmin` env-allowlist gate instead of ownership.
 * `fields` arrive already validated (`validatePatient` in ./record.ts).
 */
export class Patients extends Context.Service<
	Patients,
	{
		readonly list: (ownerId: string) => Effect.Effect<Patient[], Forbidden>;
		readonly get: (ownerId: string, id: number) => Effect.Effect<Patient | null, Forbidden>;
		readonly create: (
			ownerId: string,
			fields: PatientFields,
		) => Effect.Effect<Patient | null, Forbidden>;
		readonly update: (
			ownerId: string,
			id: number,
			fields: PatientFields,
		) => Effect.Effect<Patient | null, Forbidden>;
		/** Cross-owner listing for the /platform console — platform admins only. */
		readonly adminList: () => Effect.Effect<AdminPatientRow[], Forbidden>;
		/**
		 * Create a patient on behalf of `ownerId` — platform admins only.
		 * Owner picker options come from `adminOwners`.
		 */
		readonly adminCreate: (
			ownerId: string,
			fields: PatientFields,
		) => Effect.Effect<Patient | null, Forbidden>;
		/** User accounts for the admin create-form owner picker — platform admins only. */
		readonly adminOwners: () => Effect.Effect<OwnerOption[], Forbidden>;
	}
>()("@ktb/patients/Patients") {}

export const PatientsLive = Layer.effect(
	Patients,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		const events = yield* EventBus;
		return Patients.of({
			list: Effect.fn("Patients.list")(function* (ownerId: string) {
				yield* requireCanAs("patient.read", { ownerId });
				const where = yield* patientScope(ownerId);
				return yield* Effect.promise(() => listPatients(db, ownerId, where));
			}),
			get: Effect.fn("Patients.get")(function* (ownerId: string, id: number) {
				yield* requirePrincipalUser(ownerId, "patient.read");
				const row = yield* Effect.promise(() => getPatient(db, id));
				if (row === null) return null;
				// Tenant members read tenant-owned rows; personal rows stay
				// owner-scoped and platform admins read cross-owner either
				// way (admin detail/edit pages).
				yield* authorizePatientRow(platformAdmin, row, "patient.read");
				// Sensitive-read audit (P-086 feed): the ROW's tenant_id is
				// authoritative — a cross-owner admin read must scope to the
				// record's tenant, not the ambient one. ids only, never fields.
				yield* audit({
					action: "patients.read",
					targetType: "patient",
					targetId: row.id,
					tenantId: row.tenantId,
				});
				return row;
			}),
			create: Effect.fn("Patients.create")(function* (ownerId: string, fields: PatientFields) {
				yield* requirePrincipalUser(ownerId, "patient.create");
				yield* requireCanAs("patient.create");
				const tenant = yield* Tenant;
				yield* requireCipheredWhenZk(db, tenantScopeId(tenant), fields, "patient.create");
				yield* Effect.annotateCurrentSpan({ ownerId });
				yield* Effect.logInfo("patient create", { ownerId });
				const row = yield* Effect.promise(() =>
					createPatient(db, ownerId, fields, tenantScopeId(tenant)),
				);
				if (row !== null) {
					yield* events.dispatch([
						PatientCreated.make({
							id: row.id,
							ownerId,
							name: row.name,
							tenantId: tenantScopeId(tenant),
						}),
					]);
					// ids only — patient fields are PHI and stay out of the
					// audit log (same rule as adminCreate).
					yield* audit({
						action: "patients.create",
						targetType: "patient",
						targetId: row.id,
						tenantId: tenantScopeId(tenant),
						detail: { ownerId },
					});
				}
				return row;
			}),
			update: Effect.fn("Patients.update")(function* (
				ownerId: string,
				id: number,
				fields: PatientFields,
			) {
				yield* requirePrincipalUser(ownerId, "patient.update");
				const row = yield* Effect.promise(() => getPatient(db, id));
				if (row === null) return null;
				yield* authorizePatientRow(platformAdmin, row, "patient.update");
				yield* requireCipheredWhenZk(db, row.tenantId, fields, "patient.update");
				yield* Effect.annotateCurrentSpan({ ownerId, patientId: id });
				yield* Effect.logInfo("patient update", { ownerId, patientId: id });
				const updated = yield* Effect.promise(() => updatePatient(db, id, fields));
				if (updated !== null) {
					// ids only — the row's tenant_id and owner_id are
					// authoritative (the caller may be a cross-owner admin).
					yield* audit({
						action: "patients.update",
						targetType: "patient",
						targetId: id,
						tenantId: row.tenantId,
						detail: { ownerId: row.ownerId },
					});
				}
				return updated;
			}),
			adminList: Effect.fn("Patients.adminList")(function* () {
				// Platform gate first — fails Forbidden for non-admins and
				// for system contexts (null principal) alike.
				yield* platformAdmin.requireAdmin();
				yield* Effect.annotateCurrentSpan({ adminList: true });
				yield* Effect.logInfo("patients admin list");
				return yield* Effect.promise(() => listAllPatients(db));
			}),
			adminCreate: Effect.fn("Patients.adminCreate")(function* (
				ownerId: string,
				fields: PatientFields,
			) {
				yield* platformAdmin.requireAdmin();
				const tenant = yield* Tenant;
				yield* requireCipheredWhenZk(db, tenantScopeId(tenant), fields, "patient.create");
				yield* Effect.annotateCurrentSpan({ ownerId });
				yield* Effect.logInfo("patient admin create", { ownerId });
				const row = yield* Effect.promise(() =>
					createPatient(db, ownerId, fields, tenantScopeId(tenant)),
				);
				if (row !== null) {
					yield* events.dispatch([
						PatientCreated.make({
							id: row.id,
							ownerId,
							name: row.name,
							tenantId: tenantScopeId(tenant),
						}),
					]);
					// T-037: admin-created patient — ids only, never the
					// record fields (PHI stays out of the audit log).
					yield* audit({
						action: "patients.create",
						targetType: "patient",
						targetId: row.id,
						tenantId: tenantScopeId(tenant),
						detail: { ownerId },
					});
				}
				return row;
			}),
			adminOwners: Effect.fn("Patients.adminOwners")(function* () {
				yield* platformAdmin.requireAdmin();
				return yield* Effect.promise(() => listOwnerOptions(db));
			}),
		});
	}),
);

export const patientsTablesPlugin = definePlugin({
	id: "patients.tables",
	tables: { patients },
});

/** Cross-plugin query surface — registered on the app query bus so other
 * plugins can `Query.dispatcher(PatientsQueries)` against it. */
export const PatientsQueriesLive = Query.handlersOf(PatientsQueries, {
	"patients.ownerOf": ({ id }) =>
		Effect.gen(function* () {
			const db = yield* Db;
			return yield* Effect.promise(() => getPatientOwnerId(db, id));
		}),
});

/** `patients.delete` command — authz + row delete + `patient.deleted`
 * event. Consumers (e.g. consultations cascade) execute it through
 * `Command.dispatcher(PatientsCommands)` instead of touching the
 * patients table directly. */
export const PatientsCommandsLive = Command.handlersOf(PatientsCommands, {
	"patients.delete": ({ id }) =>
		Effect.gen(function* () {
			const db = yield* Db;
			const events = yield* EventBus;
			const platformAdmin = yield* PlatformAdmin;
			const row = yield* Effect.promise(() => getPatient(db, id));
			if (row === null) return;
			yield* authorizePatientRow(platformAdmin, row, "patient.delete");
			yield* Effect.promise(() => deletePatientRow(db, id));
			yield* events.dispatch([
				// The row's tenant_id is authoritative — ambient Tenant may
				// differ from the deleted row's owner scope.
				PatientDeleted.make({
					id,
					ownerId: row.ownerId,
					tenantId: row.tenantId,
				}),
			]);
			// P-080: every patient delete is audited here — owner and
			// platform-admin paths alike (the consultations cascade no
			// longer writes its own row). ids only, never record fields.
			yield* audit({
				action: "patients.delete",
				targetType: "patient",
				targetId: id,
				tenantId: row.tenantId,
				detail: { ownerId: row.ownerId },
			});
		}),
});

export const patientsServicesPlugin = definePlugin({
	id: "patients.services",
	// adminList consumes the PlatformAdmin gate — the dep edge keeps the
	// platform module ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	// Audit writes resolve the Audit service via serviceOption — the dep
	// edge is an ordering hint only; absence is legal.
	optionalDeps: [auditServicesPlugin.id],
	services: Layer.mergeAll(PatientsLive, PatientsQueriesLive, PatientsCommandsLive),
});

// Route subtree composed into the host's virtualRouteConfig (P-033):
// the route modules live in THIS package (src/routes/**) and are
// discovered by a physical() directory scan. The directory path is
// resolved relative to the host's routes directory
// (apps/web/src/routes) — "../../../../" escapes to the repo root —
// and the modules reach the app runtime through @ktb/server-fns, so
// the plugin owns routes end to end with zero host route files.
export const patientsRoutesPlugin = definePlugin({
	id: "patients.routes",
	routes: [physical("/patients", "../../../../plugins/patients/src/routes")],
});

// Chrome contributions (P-060): the app-shell nav link and the console
// sidebar entry live in `chrome` regions; the dep edge orders the
// sidebar item after the platform shell like the retired panel entry.
export const patientsChromePlugin = definePlugin({
	id: "patients.chrome",
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "patients.nav",
			region: "app.header.nav",
			content: { kind: "link", to: "/patients", label: "Patients" },
		},
		{
			id: "patients.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/patients",
					label: "Patients",
					icon: UsersIcon,
					group: "Domains",
				},
			},
		},
	],
});

// Panel (system console) contribution: /platform/patients is mounted by
// the platform plugin's physical route subtree; this plugin only declares
// the page descriptor. The dep edge orders it after the platform shell.
export const patientsPanelPlugin = definePlugin({
	id: "patients.panel",
	requiredDeps: [platformPanelPlugin.id],
	meta: {
		name: "Patients",
		description: "Patient records and demographics",
		icon: UsersIcon,
	},
	panel: {
		pages: [
			{
				id: "patients.admin",
				path: "/platform/patients",
				component: PatientsPlatformPage,
				// Cross-owner listing for the console — the service
				// re-checks the PlatformAdmin gate; Forbidden collapses
				// to the same empty table the old server fn returned.
				loader: () =>
					Effect.gen(function* () {
						const patients = yield* Patients;
						const [rows, owners] = yield* Effect.all([
							patients
								.adminList()
								.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as AdminPatientRow[]))),
							patients
								.adminOwners()
								.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as OwnerOption[]))),
						]);
						return { patients: rows, owners };
					}),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	patientsTablesPlugin,
	patientsServicesPlugin,
	patientsRoutesPlugin,
	patientsChromePlugin,
	patientsPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"patients.tables": true;
		"patients.services": true;
		"patients.routes": true;
		"patients.chrome": true;
		"patients.panel": true;
	}
}
