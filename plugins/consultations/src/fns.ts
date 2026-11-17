import { createServerFn } from "@tanstack/react-start";

import { Query } from "@effect-server-utils/cqrs";
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
import { AnamnesisEngine } from "@ktb/anamnesis/services";
import { AnamnesisSchema } from "@ktb/anamnesis/schema";
import type { PatientContext, PatientHistory } from "@ktb/anamnesis";
import { demographicContext } from "@ktb/patients/record";
import { Patients } from "@ktb/patients";
import { Vault, tenantIsZk } from "@ktb/vault";
import { Db } from "@ktb/db";
import { Tenant, tenantScopeId } from "@ktb/tenant";

import { Consultations, deleteConsultationRow } from "./index.ts";
import { consultationCipher } from "./cipher.ts";
import { ConsultationsQueries } from "./api.ts";

// Consultations plugin server functions: the route modules under
// src/routes/** are owned by this package and reach the app runtime
// through @ktb/server-fns — no host imports. Services enforce
// authorization and fail `Forbidden`; handlers translate denial into the
// same "not visible" response as a missing entity (null / { ok: false })
// via Effect.catchTag — other errors still propagate.

// ---------- wire validation (effect/schema) ----------

const decodeNumber = Schema.decodeUnknownSync(Schema.Number);

// T-145 ZK wire: under a ZK tenant `anamnesis` arrives as an opaque
// `v1.` envelope (a plain string — the server never parses it) and the
// write carries `ciphered: true` plus the wrapped-DEK grants the
// browser computed and the client-signed version entry. Envelope shape
// is asserted in the handlers; the service enforces the tenant's zk
// flag — the schema itself stays mode-agnostic so non-ZK payloads are
// unchanged.
const AnamnesisPayload = Schema.Union([AnamnesisSchema, Schema.String]);

/** Wrapped-DEK grant the browser computed for a clinic device — the
 * create/attach fns persist it via `vault.grantAccess` (T-145). */
const GrantInput = Schema.Struct({
	readerKind: Schema.Literals(["device", "patient"]),
	readerPubkey: Schema.NonEmptyString,
	readerId: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	wrappedDek: Schema.NonEmptyString,
});

/** Client-signed version entry: the canonical-JSON hash of the
 * plaintext anamnesis plus the device ECDSA signature over it. */
const SignedVersionInput = Schema.Struct({
	contentHash: Schema.NonEmptyString,
	signature: Schema.NonEmptyString,
});

const SaveInput = Schema.Struct({
	transcript: Schema.String,
	anamnesis: AnamnesisPayload,
	engine: Schema.String,
	patientId: Schema.optionalKey(Schema.Number),
	ciphered: Schema.optionalKey(Schema.Literal(true)),
	grants: Schema.optionalKey(Schema.Array(GrantInput)),
	version: Schema.optionalKey(SignedVersionInput),
});

const AttachInput = Schema.Struct({
	consultationId: Schema.Number,
	anamnesis: AnamnesisPayload,
	engine: Schema.String,
	// Tri-state patientId: absent keeps the link, null clears it, a
	// number re-links (ownership is enforced in the service).
	patientId: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	ciphered: Schema.optionalKey(Schema.Literal(true)),
	// Attaches may add readers (e.g. a patient-portal grant) — grants
	// persist BEFORE the row update so a failed grant never leaves an
	// unreadable record behind.
	grants: Schema.optionalKey(Schema.Array(GrantInput)),
	version: Schema.optionalKey(SignedVersionInput),
});

const ENVELOPE = /^v1\./;

/**
 * Wire-level shape gate for `ciphered` payloads (T-145): every populated
 * clinical field must be a `v1.` envelope and the client-signed version
 * must be present — a plaintext value would persist readable clinical
 * content into a ZK tenant, so the write fails closed (returns null /
 * `{ ok: false }`). Non-ciphered writes must not carry ZK-only fields
 * or string anamneses — a plaintext write always sends the parsed
 * document.
 */
const cipheredPayloadOk = (data: {
	readonly ciphered?: true;
	readonly transcript?: string;
	readonly anamnesis: unknown;
	readonly grants?: readonly unknown[];
	readonly version?: unknown;
}): boolean => {
	if (data.ciphered === true) {
		if (typeof data.anamnesis !== "string" || !ENVELOPE.test(data.anamnesis)) return false;
		if (data.transcript !== undefined && data.transcript !== "" && !ENVELOPE.test(data.transcript))
			return false;
		return data.version !== undefined;
	}
	return (
		typeof data.anamnesis !== "string" && data.grants === undefined && data.version === undefined
	);
};

const decodeSaveInput = (input: unknown) =>
	Schema.decodeUnknownSync(SaveInput)(normalizePatientId(input));
const decodeAttachInput = (input: unknown) => {
	const normalized = normalizePatientId(input);
	// normalizePatientId drops null ("absent") — but for attach, an
	// explicit null means "clear the patient link", so restore it.
	if (
		typeof input === "object" &&
		input !== null &&
		(input as Record<string, unknown>).patientId === null
	) {
		// normalizePatientId returns a fresh object for any object input.
		(normalized as Record<string, unknown>).patientId = null;
	}
	return Schema.decodeUnknownSync(AttachInput)(normalized);
};

/**
 * The wire payload may carry `patientId` as null/undefined (key present,
 * value absent after serialization) or a numeric string — none of which
 * `Schema.Number` accepts. Normalize before decoding: drop empty values,
 * coerce numeric strings, reject the rest via the schema as usual.
 */
function normalizePatientId(input: unknown): unknown {
	if (typeof input !== "object" || input === null) return input;
	const o = { ...(input as Record<string, unknown>) };
	const p = o.patientId;
	if (p === undefined || p === null || p === "") delete o.patientId;
	else if (typeof p === "string" && p.trim() !== "" && Number.isFinite(Number(p)))
		o.patientId = Number(p);
	else if (typeof p === "number" && !Number.isFinite(p)) delete o.patientId;
	return o;
}

const ExtractInput = Schema.Struct({
	transcript: Schema.String,
	patientId: Schema.optionalKey(Schema.Number),
});

const HistoryInput = Schema.Struct({
	patientId: Schema.Number,
	excludeId: Schema.optionalKey(Schema.Number),
});

const decodeExtractInput = (input: unknown) =>
	Schema.decodeUnknownSync(ExtractInput)(normalizePatientId(input));
const decodeHistoryInput = (input: unknown) =>
	Schema.decodeUnknownSync(HistoryInput)(normalizePatientId(input));

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

// LLM helpers touch no owned data but still require a session: they proxy
// paid model calls and must not be an open endpoint.
export const extractAnamnesisFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeExtractInput(input))
	.handler(async ({ data }) => {
		const user = await ensureDoctorUser();
		return runAs(
			user,
			Effect.gen(function* () {
				// T-145: a ZK tenant's transcript is client-side content —
				// the server-side engine (a provider call) must never see
				// it. ZK clients extract in the browser (T-146 wires the
				// BYOK port; until then the local heuristic runs there).
				const db = yield* Db;
				const tenant = yield* Tenant;
				const tenantId = tenantScopeId(tenant);
				if (tenantId !== null && (yield* Effect.promise(() => tenantIsZk(db, tenantId)))) {
					return null;
				}
				// Linked patient → factual history of prior consultations is
				// fetched server-side and fed to the engine as context only.
				let history: PatientHistory | null = null;
				let patient: PatientContext | undefined;
				if (data.patientId !== undefined) {
					const consultations = yield* Consultations;
					// userId is always the caller's own — read authz cannot deny.
					history = yield* consultations.history(data.patientId, user.id);
					// Record demographics as drafter context; someone else's
					// patient is simply not used.
					const patients = yield* Patients;
					const record = yield* patients
						.get(user.id, data.patientId)
						.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
					if (record) patient = demographicContext(record);
				}
				const engine = yield* AnamnesisEngine;
				return yield* engine.extract({
					transcript: data.transcript,
					history: history ?? undefined,
					patient,
				});
			}),
		);
	});

/** Factual summary of a patient's prior consultations (review UI). */
export const patientHistoryFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeHistoryInput(input))
	.handler(async ({ data }) => {
		const user = await getDoctorUser();
		if (!user) return null;
		return runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				return yield* consultations.history(data.patientId, user.id, data.excludeId);
			}),
		);
	});

/**
 * Raw history rows for the client-side history build (T-145): the same
 * rows `patientHistoryFn` summarizes, but with the stored `anamnesis`
 * column untouched — plaintext JSON for non-ZK tenants, `v1.`
 * envelopes under ZK. The client decrypts/parses and derives
 * `factContent` itself.
 */
export const patientHistoryRowsFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeHistoryInput(input))
	.handler(async ({ data }) => {
		const user = await getDoctorUser();
		if (!user) return null;
		return runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				return yield* consultations.historyRows(data.patientId, user.id, data.excludeId);
			}),
		);
	});

// ---------- consultations (owner-scoped) ----------

export const saveConsultationFn = createServerFn({ method: "POST" })
	.validator((input) => decodeSaveInput(input))
	.handler(async ({ data: { ciphered, grants, version, ...rest } }) => {
		const user = await ensureDoctorUser();
		if (!cipheredPayloadOk({ ciphered, ...rest, grants, version })) return null;
		// T-145: a ciphered row without its wrapped DEKs is unreadable
		// forever — the create must carry at least one grant (same rule
		// as createPatientFn).
		if (ciphered === true && (grants === undefined || grants.length === 0)) return null;
		return runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				const saved = yield* consultations.save(user.id, { ...rest, version });
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
									entityType: consultationCipher.entity,
									entityId: saved.id,
									grants,
								})
								.pipe(
									Effect.map(() => true),
									Effect.catch(() => Effect.succeed(false)),
								)
						: Effect.succeed(false);
					if (!granted) {
						yield* Effect.promise(() => deleteConsultationRow(db, saved.id));
						return null;
					}
				}
				return saved;
			}),
		);
	});

export const listConsultationsFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await getDoctorUser();
	if (!user) return [];
	return runAs(
		user,
		Effect.gen(function* () {
			const consultations = yield* Consultations;
			return yield* consultations.list(user.id);
		}),
	);
});

export const getConsultationFn = createServerFn({ method: "GET" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: id }) => {
		const user = await getDoctorUser();
		if (!user) return null;
		// Non-owner access fails Forbidden inside the service → null (404).
		return runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				return yield* consultations
					.get(id, user.id)
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
			}),
		);
	});

export const getLiveConsultationFn = createServerFn({ method: "GET" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: id }) => {
		const user = await getDoctorUser();
		if (!user) return null;
		return runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				return yield* consultations
					.getLive(id, user.id)
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
			}),
		);
	});

/**
 * Re-verify the anamnesis integrity chain (T-139): same read authz as
 * `getConsultationFn` — non-owners and missing rows get null.
 */
export const verifyConsultationIntegrityFn = createServerFn({ method: "GET" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: id }) => {
		const user = await getDoctorUser();
		if (!user) return null;
		return runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				return yield* consultations
					.verifyIntegrity(id, user.id)
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
			}),
		);
	});

export const attachAnamnesisFn = createServerFn({ method: "POST" })
	.validator((input) => decodeAttachInput(input))
	.handler(async ({ data: { ciphered, grants, version, ...rest } }) => {
		const user = await getDoctorUser();
		if (!user) return { ok: false };
		if (!cipheredPayloadOk({ ciphered, ...rest, grants, version })) return { ok: false };
		return runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				if (grants !== undefined && grants.length > 0) {
					// Grants persist BEFORE the row update: a failed grant
					// leaves the row readable instead of attaching content no
					// device could unwrap.
					const tenant = yield* Tenant;
					const tenantId = tenantScopeId(tenant);
					const vault = yield* Effect.serviceOption(Vault);
					const granted =
						tenantId !== null && vault._tag === "Some"
							? yield* vault.value
									.grantAccess({
										tenantId,
										entityType: consultationCipher.entity,
										entityId: rest.consultationId,
										grants,
									})
									.pipe(
										Effect.map(() => true),
										Effect.catch(() => Effect.succeed(false)),
									)
							: false;
					if (!granted) return { ok: false };
				}
				const ok = yield* consultations.attachAnamnesis(user.id, { ...rest, version }).pipe(
					Effect.as(true),
					Effect.catchTag("Forbidden", () => Effect.succeed(false)),
				);
				return { ok };
			}),
		);
	});

/**
 * Cross-owner audio-pipeline rows for the /platform jobs feed — the
 * `consultations.audioJobs` CQRS query, dispatched inside runAs so the
 * bound Principal reaches the handler's platform-admin check. Non-admins
 * (the layout guard 404s them first anyway) get the same empty feed as
 * an empty table.
 */
export const adminListAudioJobsFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await getDoctorUser();
	if (!user) return [];
	return runAs(
		user,
		Effect.scoped(
			Effect.gen(function* () {
				const queries = yield* Query.dispatcher(ConsultationsQueries);
				return yield* queries["consultations.audioJobs"]({}).pipe(
					Effect.catchTag("Forbidden", () => Effect.succeed([])),
				);
			}),
		),
	);
});

const AdminCreateInput = Schema.Struct({
	userId: Schema.String,
	patientId: Schema.optionalKey(Schema.Number),
	transcript: Schema.optionalKey(Schema.String),
	source: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.String),
});
const decodeAdminCreateInput = Schema.decodeUnknownSync(AdminCreateInput);

/**
 * Platform-admin create on behalf of another user — the service
 * re-checks the PlatformAdmin gate; non-admins get `{ ok: false }`.
 */
export const adminCreateConsultationFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeAdminCreateInput(input))
	.handler(async ({ data }) => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				const id = yield* consultations
					.adminCreate({ ...data, source: data.source ?? "manual" })
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
				return id === null ? { ok: false as const } : { ok: true as const, id };
			}),
		);
	});

/**
 * Platform-admin delete — removes the row and purges the stored
 * recording. Missing row or non-admin → `{ ok: false }`.
 */
export const adminDeleteConsultationFn = createServerFn({ method: "POST" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: id }) => {
		const user = await ensureSessionUser();
		const result = await runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				return yield* consultations
					.adminDelete(id)
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
			}),
		);
		if (result === null) return { ok: false as const };
		const leftover = await purgeAudio(
			getServerRuntime().audio,
			result.audioKey === null ? [] : [result.audioKey],
		);
		return { ok: true as const, orphanedAudio: leftover.length };
	});

/** Record the doctor's consent declaration (LGPD trail). */
export const recordConsentFn = createServerFn({ method: "POST" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: id }) => {
		const user = await getDoctorUser();
		if (!user) return { ok: false };
		return runAs(
			user,
			Effect.gen(function* () {
				const consultations = yield* Consultations;
				const ok = yield* consultations.recordConsent(id, user.id).pipe(
					Effect.as(true),
					Effect.catchTag("Forbidden", () => Effect.succeed(false)),
				);
				return { ok };
			}),
		);
	});
