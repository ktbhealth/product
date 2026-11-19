import { createServerFn } from "@tanstack/react-start";

import { Command, Query } from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";
import { Schema } from "effect";

import {
	ensureDoctorUser,
	ensureSessionUser,
	getDoctorAccess,
	getDoctorContext,
	getDoctorUser,
	getLocale,
	getServerRuntime,
	getSessionUser,
	purgeAudio,
	runAs,
} from "@ktb/server-fns";

import { Vault } from "@ktb/vault";
import { Db } from "@ktb/db";
import { Tenant, tenantScopeId } from "@ktb/tenant";

import { deletePatientRow, Patients, type AdminPatientRow } from "./index.ts";
import { patientCipher } from "./cipher.ts";
import {
	TEXT_FIELDS,
	validatePatient,
	type PatientDraft,
	type PatientErrors,
	type PatientFields,
	type TextField,
} from "./record.ts";
import { PatientCascadeCommands, PatientRecordConsultationsQueries } from "./api.ts";

// Patients plugin server functions (P-033): the route modules under
// src/routes/** are owned by this package and reach the app runtime
// through @ktb/server-fns — no host imports. Services enforce
// authorization and fail `Forbidden`; handlers translate denial into the
// same "not visible" response as a missing entity (null / { ok: false })
// via Effect.catchTag — other errors still propagate.

// ---------- wire validation (effect/schema) ----------

const decodeNumber = Schema.decodeUnknownSync(Schema.Number);

// Patient record: every FHIR text field optional/nullable on the wire;
// semantic validation (codes, CPF/CNS, dates) is validatePatient's job.
// `ciphered: true` marks a ZK payload (T-144): values arrive as `v1.`
// AEAD envelopes — semantic validation cannot run on ciphertext, so the
// wire asserts envelope shape instead and the service enforces the
// tenant's zk flag.
const draftFields = Object.fromEntries(
	TEXT_FIELDS.map((k) => [k, Schema.optionalKey(Schema.NullishOr(Schema.String))]),
);
/** Wrapped-DEK grant the browser computed for a clinic device — the
 * create fn persists it atomically with the row (T-144). */
const GrantInput = Schema.Struct({
	readerKind: Schema.Literals(["device", "patient"]),
	readerPubkey: Schema.NonEmptyString,
	readerId: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	wrappedDek: Schema.NonEmptyString,
});
const PatientDraftInput = Schema.Struct({
	...draftFields,
	active: Schema.optionalKey(Schema.Boolean),
	ciphered: Schema.optionalKey(Schema.Literal(true)),
	grants: Schema.optionalKey(Schema.Array(GrantInput)),
});
const PatientUpdateInput = Schema.Struct({
	...draftFields,
	active: Schema.optionalKey(Schema.Boolean),
	ciphered: Schema.optionalKey(Schema.Literal(true)),
	id: Schema.Number,
});
/** Admin create: the doctor-facing draft plus the target owner. */
const AdminPatientCreateInput = Schema.Struct({
	...draftFields,
	active: Schema.optionalKey(Schema.Boolean),
	ownerId: Schema.String,
});

const decodePatientDraft = Schema.decodeUnknownSync(PatientDraftInput);
const decodeAdminPatientCreate = Schema.decodeUnknownSync(AdminPatientCreateInput);

const ENVELOPE = /^v1\./;

/**
 * Build `PatientFields` from a `ciphered` wire draft: every non-empty
 * text value MUST be a `v1.` envelope — a plaintext value in a ciphered
 * write would persist readable PII into a ZK tenant, so the write
 * fails closed (returns null → `{ ok: false }`). `name`/`birthDate`
 * stay required, mirroring plaintext validation; the semantic checks
 * a server cannot run on ciphertext are the client's job (it ran
 * `validatePatient` before encrypting).
 */
const cipheredFields = (data: Record<string, unknown>): PatientFields | null => {
	const fields = {} as Record<TextField, string | null>;
	for (const key of TEXT_FIELDS) {
		const raw = data[key];
		const value = typeof raw === "string" && raw !== "" ? raw : null;
		if (value !== null && !ENVELOPE.test(value)) return null;
		fields[key] = value;
	}
	if (fields.name === null || fields.birthDate === null) return null;
	return {
		...fields,
		name: fields.name,
		birthDate: fields.birthDate,
		active: typeof data.active === "boolean" ? data.active : true,
	};
};

/** Plaintext drafts go through `validatePatient`; `ciphered` payloads
 * only assert envelope shape — the service still gates on the tenant's
 * zk flag, so a ciphered write to a non-ZK tenant fails there. */
const validateDraft = (
	ciphered: true | undefined,
	draft: PatientDraft,
):
	| { readonly ok: true; readonly fields: PatientFields }
	| { readonly ok: false; readonly errors: PatientErrors } => {
	if (!ciphered) return validatePatient(draft);
	const fields = cipheredFields(draft);
	return fields === null ? { ok: false, errors: {} } : { ok: true, fields };
};

/** `id` tolerates a numeric string, like `patientId` elsewhere. */
const decodePatientUpdate = (input: unknown) => {
	const o = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	const id = typeof o.id === "string" && o.id.trim() !== "" ? Number(o.id) : o.id;
	return Schema.decodeUnknownSync(PatientUpdateInput)({ ...o, id });
};

/** Session user for route guards — null when anonymous. */
export const sessionUserFn = createServerFn({ method: "GET" }).handler(() => getSessionUser());

/** Doctor-side standing of the request — drives the route guard. */
export const doctorAccessFn = createServerFn({ method: "GET" }).handler(() => getDoctorAccess());

/** Which clinical portal instance this request belongs in — "doctor"
 * for own-profile accounts, "secretary" for delegated-only ones. Null
 * for anonymous visitors and for accounts with no doctor side. */
export const clinicalPortalFn = createServerFn({ method: "GET" }).handler(async () => {
	const context = await getDoctorContext();
	if (!context) return null;
	return context.profiles.some((p) => p.role === "owner") ? "doctor" : "secretary";
});

/** Active UI locale for the current request — route loaders attach it
 * to their data so plugin views never import the host's i18n runtime. */
export const localeFn = createServerFn({ method: "GET" }).handler(() => getLocale());

// ---------- patients ----------
// All domain calls go through `runAs(user, …)`: the service enforces
// ownership via the bound Principal — no handler-level permission checks.

export const listPatientsFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await getDoctorUser();
	if (!user) return [];
	return runAs(
		user,
		Effect.gen(function* () {
			const patients = yield* Patients;
			return yield* patients.list(user.id);
		}),
	);
});

/** What deleting a patient takes with it — shown before the doctor confirms. */
export const patientDeletionImpactFn = createServerFn({ method: "GET" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: id }) => {
		const user = await getDoctorUser();
		if (!user) return null;
		return runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const patients = yield* Patients;
					const patient = yield* patients
						.get(user.id, id)
						.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
					if (!patient) return null;
					const queries = yield* Query.dispatcher(PatientRecordConsultationsQueries);
					const consultations = yield* queries["patients.recordConsultations"]({
						patientId: id,
					});
					return { consultations: consultations.length };
				}),
			),
		);
	});

/**
 * Permanently delete a patient and every consultation linked to them
 * (one D1 batch), then purge their recordings from R2. Missing or not
 * owned → `{ ok: false }`.
 */
export const deletePatientFn = createServerFn({ method: "POST" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: id }) => {
		const user = await ensureDoctorUser();
		const result = await runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const commands = yield* Command.dispatcher(PatientCascadeCommands);
					return yield* commands["patients.deleteCascade"]({
						patientId: id,
					}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
				}),
			),
		);
		if (!result) return { ok: false as const };
		const leftover = await purgeAudio(getServerRuntime().audio, result.audioKeys);
		return {
			ok: true as const,
			consultations: result.consultations,
			/** Recordings still in storage after a failed purge (0 when clean). */
			orphanedAudio: leftover.length,
		};
	});

export const getPatientFn = createServerFn({ method: "GET" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: id }) => {
		const user = await getDoctorUser();
		if (!user) return null;
		// Someone else's patient fails Forbidden inside the service → null (404).
		return runAs(
			user,
			Effect.gen(function* () {
				const patients = yield* Patients;
				return yield* patients
					.get(user.id, id)
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
			}),
		);
	});

/** Field errors come back as data (`ok: false`) so the form can show them inline. */
export const createPatientFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodePatientDraft(input))
	.handler(async ({ data: { ciphered, grants, ...draft } }) => {
		const user = await ensureDoctorUser();
		const result = validateDraft(ciphered, draft);
		if (!result.ok) return { ok: false as const, errors: result.errors };
		// T-144: a ciphered row without at least one wrapped DEK is
		// unreadable forever — the create must carry its grants.
		if (ciphered === true && (grants === undefined || grants.length === 0)) {
			return { ok: false as const, errors: {} };
		}
		if (grants !== undefined && ciphered !== true) {
			return { ok: false as const, errors: {} };
		}
		return runAs(
			user,
			Effect.gen(function* () {
				const patients = yield* Patients;
				const patient = yield* patients.create(user.id, result.fields);
				if (patient === null) return { ok: false as const, errors: {} };
				if (grants !== undefined) {
					// Atomic-ish: the vault write failing orphans the record —
					// no device could ever unwrap it — so the row is rolled back.
					const db = yield* Db;
					const tenant = yield* Tenant;
					const tenantId = tenantScopeId(tenant);
					const vault = yield* Effect.serviceOption(Vault);
					const granted = yield* tenantId !== null && vault._tag === "Some"
						? vault.value
								.grantAccess({
									tenantId,
									entityType: patientCipher.entity,
									entityId: patient.id,
									grants,
								})
								.pipe(
									Effect.map(() => true),
									Effect.catch(() => Effect.succeed(false)),
								)
						: Effect.succeed(false);
					if (!granted) {
						yield* Effect.promise(() => deletePatientRow(db, patient.id));
						return { ok: false as const, errors: {} };
					}
				}
				return { ok: true as const, patient };
			}),
		);
	});

/**
 * Platform-admin create on behalf of another user — the service
 * re-checks the PlatformAdmin gate; non-admins get the same
 * `{ ok: false }` shape as a validation failure.
 */
/**
 * Cross-owner patient rows for the /platform dashboard stat — the
 * service re-checks the PlatformAdmin gate; non-admins and missing
 * sessions get the same empty feed as an empty table.
 */
export const adminListPatientsFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await getDoctorUser();
	if (!user) return [];
	return runAs(
		user,
		Effect.gen(function* () {
			const patients = yield* Patients;
			return yield* patients
				.adminList()
				.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as AdminPatientRow[])));
		}),
	);
});

export const adminCreatePatientFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeAdminPatientCreate(input))
	.handler(async ({ data: { ownerId, ...draft } }) => {
		const user = await ensureSessionUser();
		const result = validatePatient(draft);
		if (!result.ok) return { ok: false as const, errors: result.errors };
		return runAs(
			user,
			Effect.gen(function* () {
				const patients = yield* Patients;
				const patient = yield* patients
					.adminCreate(ownerId, result.fields)
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
				return patient ? { ok: true as const, patient } : { ok: false as const, errors: {} };
			}),
		);
	});

export const updatePatientFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodePatientUpdate(input))
	.handler(async ({ data: { id, ciphered, ...draft } }) => {
		const user = await ensureDoctorUser();
		const result = validateDraft(ciphered, draft);
		if (!result.ok) return { ok: false as const, errors: result.errors };
		return runAs(
			user,
			Effect.gen(function* () {
				const patients = yield* Patients;
				// Missing or not owned → same "not saved" answer.
				const patient = yield* patients
					.update(user.id, id, result.fields)
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
				return patient ? { ok: true as const, patient } : { ok: false as const, errors: {} };
			}),
		);
	});

/** The patient record page's consultation list (owner-scoped) — the
 * `patients.recordConsultations` CQRS query, dispatched inside runAs so
 * the bound Principal reaches the handler's authz checks. */
export const patientConsultationsFn = createServerFn({ method: "GET" })
	.validator((patientId: number) => decodeNumber(patientId))
	.handler(async ({ data: patientId }) => {
		const user = await getDoctorUser();
		if (!user) return [];
		return runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const queries = yield* Query.dispatcher(PatientRecordConsultationsQueries);
					return yield* queries["patients.recordConsultations"]({ patientId });
				}),
			),
		);
	});
