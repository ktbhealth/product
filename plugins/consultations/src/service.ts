import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { Option } from "effect";
import type { PatientHistory } from "@ktb/anamnesis";

import { audit } from "@ktb/audit";
import { Integrity, recordVersion, type IntegrityVerification } from "@ktb/integrity";
import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";
import { Forbidden, requireCanAs, requirePrincipalUser } from "@ktb/authz";
import { PatientsQueries } from "@ktb/patients/api";
import { ConsultationAudioUpdated, ConsultationCreated } from "./api.ts";
import { EventBus, Query } from "@effect-server-utils/cqrs";
import { runAsTenantId, Tenant, tenantScopeId } from "@ktb/tenant";

import {
	ANAMNESIS_ENTITY_TYPE,
	BACKFILL_BATCH,
	countUnversionedAnamnesis,
	patientHistory,
	patientHistoryRows,
	setAnamnesisIntegrity,
	unversionedAnamnesisRows,
	anamnesisIntegrityHead,
	anamnesisIntegrityState,
	attachAnamnesis,
	type ConsultationIntegrityReport,
	type PatientHistoryRows,
} from "./anamnesis.ts";
import {
	attachAudioRecord,
	audioJobRecord,
	audioJobRow,
	listAudioJobRows,
	markAudioRouteStatus,
	requeueAudioJob,
	type AudioJobFields,
	type AudioJobRecord,
	type AudioJobRow,
	type AudioRouteStatus,
} from "./audio-jobs.ts";
import {
	appendTranscript,
	consultationAuditScope,
	consultationTenantId,
	createConsultation,
	deleteConsultationRow,
	finishConsultation,
	ownsBot,
	recordConsent,
	saveConsultation,
} from "./lifecycle.ts";
import {
	consultationOwner,
	getConsultation,
	getLiveConsultation,
	listAllConsultations,
	listConsultations,
	type AdminConsultationRow,
} from "./queries.ts";
import {
	serializeAnamnesis,
	type AttachAnamnesisInput,
	type ConsultationDetail,
	type ConsultationSummary,
	type SaveConsultationInput,
} from "./shared.ts";
import {
	authorizeConsultationRow,
	consultationScope,
	requireCipheredWhenZk,
	tenantRowVisible,
} from "./tenant-visibility.ts";

/**
 * Consultations domain port — Effect service, swappable in tests.
 *
 * User-facing methods (`create`, `save`, `list`, `get`, `getLive`,
 * `attachAnamnesis`, `recordConsent`) enforce authorization against the
 * request `Principal` (@ktb/authz) and fail `Forbidden` for non-owners
 * or when no principal is bound. The bot-channel methods
 * (`appendTranscript`, `finish`, `ownedByBot`) are system paths: they do
 * not consult `Principal` — callers MUST authorize out-of-band first
 * (`ownedByBot` binds botId ↔ consultation before any mutation).
 */
export class Consultations extends Context.Service<
	Consultations,
	{
		readonly create: (fields: {
			userId: string;
			transcript?: string;
			source: string;
			status?: string;
			botId?: string;
		}) => Effect.Effect<number | null, Forbidden>;
		readonly appendTranscript: (consultationId: number, text: string) => Effect.Effect<void>;
		readonly finish: (consultationId: number) => Effect.Effect<void>;
		readonly ownedByBot: (consultationId: number, botId: string) => Effect.Effect<boolean>;
		readonly save: (
			userId: string,
			input: SaveConsultationInput,
		) => Effect.Effect<{ id: number }, Forbidden>;
		/** Owner's consultations, optionally only those linked to `patientId`. */
		readonly list: (
			userId: string,
			patientId?: number,
		) => Effect.Effect<ConsultationSummary[], Forbidden>;
		/** Cross-owner listing for the /platform console — platform admins only. */
		readonly adminList: () => Effect.Effect<AdminConsultationRow[], Forbidden>;
		/**
		 * Live feed of the audio-pipeline projection behind the /platform
		 * jobs popover: replays the current rows (same shape as the
		 * `consultations.audioJobs` query), then emits one fresh row per
		 * `consultation.audioUpdated` event. Platform admins only.
		 */
		readonly audioJobsStream: () => Stream.Stream<AudioJobRow, Forbidden>;
		/** One-shot variant of the audioJobs projection — platform admins only. */
		readonly adminAudioJobs: () => Effect.Effect<AudioJobRow[], Forbidden>;
		/**
		 * Single audio-job record for the admin retry path (T-035):
		 * carries the R2 key + owner/tenant the re-enqueued
		 * AudioJobMessage needs. Platform admins only.
		 */
		readonly adminAudioJob: (id: number) => Effect.Effect<AudioJobRecord | null, Forbidden>;
		/**
		 * Flip a retryable audio job (stored|failed) back to "queued"
		 * after the caller re-enqueued it — platform admins only.
		 * Conditional on the retryable set so a concurrent consumer
		 * transition is never overwritten; false when the row is missing
		 * or already past those states.
		 */
		readonly adminRequeueAudio: (id: number) => Effect.Effect<boolean, Forbidden>;
		/**
		 * Create a consultation on behalf of `userId` — platform admins
		 * only. `patientId`, when given, must resolve to an existing
		 * patient (ownership is not checked — admins act cross-owner).
		 */
		readonly adminCreate: (fields: {
			userId: string;
			patientId?: number;
			transcript?: string;
			source: string;
			status?: string;
		}) => Effect.Effect<number | null, Forbidden>;
		/**
		 * Delete a consultation row — platform admins only. Returns the
		 * stored audio key (if any) so the caller can purge the
		 * recording; null when the row does not exist.
		 */
		readonly adminDelete: (
			id: number,
		) => Effect.Effect<{ audioKey: string | null } | null, Forbidden>;
		readonly get: (
			id: number,
			userId: string,
		) => Effect.Effect<ConsultationDetail | null, Forbidden>;
		readonly getLive: (
			id: number,
			userId: string,
		) => Effect.Effect<{ transcript: string; status: string } | null, Forbidden>;
		readonly attachAnamnesis: (
			userId: string,
			input: AttachAnamnesisInput,
		) => Effect.Effect<void, Forbidden>;
		/**
		 * Materialize version-1 integrity rows for anamneses written
		 * before record_versions existed (T-138 backfill) — idempotent,
		 * batched by BACKFILL_BATCH, platform admins only. `remaining`
		 * reports rows still unversioned after this pass.
		 */
		readonly adminBackfillVersions: () => Effect.Effect<
			{ backfilled: number; remaining: number },
			Forbidden
		>;
		/**
		 * `verifyIntegrity(entity, id)` for anamneses (T-139): re-derives
		 * the version chain and checks the row's integrity columns still
		 * point at the chain head. Same read authz as `get`; null when
		 * the consultation does not exist.
		 */
		readonly verifyIntegrity: (
			id: number,
			userId: string,
		) => Effect.Effect<ConsultationIntegrityReport | null, Forbidden>;
		readonly recordConsent: (id: number, userId: string) => Effect.Effect<void, Forbidden>;
		/** Link a stored R2 audio object to the consultation (status "stored"). */
		readonly attachAudio: (
			userId: string,
			input: { consultationId: number } & AudioJobFields,
		) => Effect.Effect<void, Forbidden>;
		/** Owner-facing status transition (stored | queued only). */
		readonly updateAudioStatus: (
			userId: string,
			consultationId: number,
			status: AudioRouteStatus,
		) => Effect.Effect<void, Forbidden>;
		readonly history: (
			patientId: number,
			userId: string,
			excludeId?: number,
		) => Effect.Effect<PatientHistory | null, Forbidden>;
		/**
		 * Raw history rows for the client-side history build (T-145):
		 * under ZK `anamnesis` is an opaque envelope — the client
		 * decrypts and derives `factContent` itself. Same authz and
		 * null-when-not-owned contract as `history`.
		 */
		readonly historyRows: (
			patientId: number,
			userId: string,
			excludeId?: number,
		) => Effect.Effect<PatientHistoryRows | null, Forbidden>;
	}
>()("@ktb/consultations/Consultations") {}

export const ConsultationsLive = Layer.effect(
	Consultations,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		const patientQueries = yield* Query.dispatcher(PatientsQueries);
		const events = yield* EventBus;
		// Live fan-out for audioJobsStream: every audio-status mutation
		// (service methods here, the queue consumer via the host) publishes
		// ConsultationAudioUpdated; the handler re-reads the row so stream
		// consumers always get the full projection, never a partial payload.
		const liveAudioJobs = yield* PubSub.unbounded<AudioJobRow>();
		// Patient-link guard for save/attach: a patientId must resolve to
		// a patient the acting user owns (patients.ownerOf is the
		// cross-plugin lookup). Foreign or missing ids fail `Forbidden` —
		// same denial shape as a failed permix check, so callers can't
		// probe which patient ids exist.
		const requireOwnedPatient = (patientId: number, path: string) =>
			Effect.gen(function* () {
				const owner = yield* patientQueries["patients.ownerOf"]({ id: patientId });
				if (owner === null) return yield* Effect.fail(new Forbidden({ path }));
				// Tenant-owned patients are governed by membership (P-053):
				// any member of the patient's tenant may link it; the
				// ownerId check applies to personal patients only.
				if (owner.tenantId !== null) {
					if (!(yield* tenantRowVisible(owner.tenantId))) {
						return yield* Effect.fail(new Forbidden({ path }));
					}
					return;
				}
				yield* requireCanAs("patient.read", { ownerId: owner.ownerId });
			});
		yield* events.subscribeAfterCommit(ConsultationAudioUpdated, (event) =>
			// After-commit handlers must not inherit the publisher's
			// ambient tenant — re-bind from the event payload (P-053 D).
			// null/absent = personal scope, same as old events.
			runAsTenantId(
				event.tenantId ?? null,
				Effect.gen(function* () {
					const row = yield* Effect.promise(() => audioJobRow(db, event.consultationId));
					// Missing row (deleted consultation) → nothing to emit; the
					// client's seeded copy survives until the next loader pass.
					if (row !== null) yield* PubSub.publish(liveAudioJobs, row);
				}),
			),
		);
		return Consultations.of({
			create: Effect.fn("Consultations.create")(function* (fields: {
				userId: string;
				transcript?: string;
				source: string;
				status?: string;
				botId?: string;
			}) {
				yield* requirePrincipalUser(fields.userId, "consultation.create");
				yield* requireCanAs("consultation.create");
				const tenant = yield* Tenant;
				const tenantId = tenantScopeId(tenant);
				// T-145: bot/live creates carry an empty transcript ("" stays
				// legal) — a populated transcript under ZK must be an envelope.
				yield* requireCipheredWhenZk(db, tenantId, [fields.transcript], "consultation.create");
				yield* Effect.annotateCurrentSpan({ userId: fields.userId, source: fields.source });
				yield* Effect.logInfo("consultation create", {
					userId: fields.userId,
					source: fields.source,
				});
				const id = yield* Effect.promise(() => createConsultation(db, fields, tenantId));
				if (id !== null) {
					yield* events.dispatch([
						ConsultationCreated.make({
							id,
							userId: fields.userId,
							source: fields.source,
							tenantId,
						}),
					]);
					// ids/source only — the transcript is PHI and stays out
					// of the audit log (same rule as adminCreate).
					yield* audit({
						action: "consultations.create",
						targetType: "consultation",
						targetId: id,
						tenantId,
						detail: { source: fields.source },
					});
				}
				return id;
			}),
			appendTranscript: Effect.fn("Consultations.appendTranscript")(function* (
				consultationId: number,
				text: string,
			) {
				yield* Effect.annotateCurrentSpan({ consultationId });
				yield* Effect.logInfo("consultation transcript append", {
					consultationId,
					length: text.length,
				});
				return yield* Effect.promise(() => appendTranscript(db, consultationId, text));
			}),
			finish: Effect.fn("Consultations.finish")(function* (consultationId: number) {
				yield* Effect.annotateCurrentSpan({ consultationId });
				yield* Effect.logInfo("consultation finish", { consultationId });
				// System path (no principal → actor columns NULL by design):
				// the row's tenant_id is the authoritative scope, read
				// before the status flip like the other system audits.
				const tenantId = yield* Effect.promise(() => consultationTenantId(db, consultationId));
				yield* Effect.promise(() => finishConsultation(db, consultationId));
				yield* audit({
					action: "consultations.finish",
					targetType: "consultation",
					targetId: consultationId,
					tenantId,
					detail: { status: "done" },
				});
			}),
			ownedByBot: Effect.fn("Consultations.ownedByBot")((consultationId: number, botId: string) =>
				Effect.promise(() => ownsBot(db, consultationId, botId)),
			),
			save: Effect.fn("Consultations.save")(function* (
				userId: string,
				input: SaveConsultationInput,
			) {
				yield* requirePrincipalUser(userId, "consultation.create");
				yield* requireCanAs("consultation.create");
				if (input.patientId !== undefined) {
					yield* requireOwnedPatient(input.patientId, "patient.read");
				}
				const tenant = yield* Tenant;
				// T-145: under ZK, transcript + anamnesis must already be
				// envelopes; outside ZK neither may be.
				yield* requireCipheredWhenZk(
					db,
					tenantScopeId(tenant),
					[input.transcript, serializeAnamnesis(input.anamnesis)],
					"consultation.create",
				);
				yield* Effect.annotateCurrentSpan({ userId, engine: input.engine });
				yield* Effect.logInfo("consultation save", { userId, engine: input.engine });
				const saved = yield* Effect.promise(() =>
					saveConsultation(db, userId, input, tenantScopeId(tenant)),
				);
				// T-138 interim integrity: server-side content hash as
				// version 1 — for ZK writes the client supplied the signed
				// hash of the plaintext document (T-145), which persists on
				// the same columns. A failed/absent integrity plugin never
				// blocks the save.
				const recorded = yield* recordVersion({
					entityType: ANAMNESIS_ENTITY_TYPE,
					entityId: saved.id,
					payload: serializeAnamnesis(input.anamnesis),
					contentHash: input.version?.contentHash,
					signature: input.version?.signature ?? null,
					engine: input.engine,
					actorUserId: userId,
				});
				if (recorded !== null) {
					yield* Effect.promise(() => setAnamnesisIntegrity(db, saved.id, recorded));
				}
				// ids/engine only — anamnesis content and transcript are
				// PHI and stay out of the audit log.
				yield* audit({
					action: "consultations.save",
					targetType: "consultation",
					targetId: saved.id,
					tenantId: tenantScopeId(tenant),
					detail: { engine: input.engine, patientId: input.patientId ?? null },
				});
				return saved;
			}),
			list: Effect.fn("Consultations.list")(function* (userId: string, patientId?: number) {
				yield* requireCanAs("consultation.read", { userId });
				const scope = yield* consultationScope(userId);
				return yield* Effect.promise(() => listConsultations(db, patientId, scope));
			}),
			adminList: Effect.fn("Consultations.adminList")(function* () {
				// Platform gate first — fails Forbidden for non-admins and
				// for system contexts (null principal) alike.
				yield* platformAdmin.requireAdmin();
				yield* Effect.annotateCurrentSpan({ adminList: true });
				yield* Effect.logInfo("consultations admin list");
				return yield* Effect.promise(() => listAllConsultations(db));
			}),
			audioJobsStream: () =>
				Stream.unwrap(
					Effect.gen(function* () {
						// Same gate as adminList — fails Forbidden for
						// non-admins and for system contexts (null principal).
						yield* platformAdmin.requireAdmin();
						// Backlog first, then live deltas. The backlog read
						// happens inside the stream's first effect so
						// construction stays cheap and authz is enforced on pull.
						const rows = yield* Effect.promise(() => listAudioJobRows(db));
						return Stream.concat(Stream.fromIterable(rows), Stream.fromPubSub(liveAudioJobs));
					}),
				),
			adminAudioJobs: Effect.fn("Consultations.adminAudioJobs")(function* () {
				// Same gate as adminList — fails Forbidden for non-admins
				// and for system contexts (null principal) alike.
				yield* platformAdmin.requireAdmin();
				return yield* Effect.promise(() => listAudioJobRows(db));
			}),
			adminAudioJob: Effect.fn("Consultations.adminAudioJob")(function* (id: number) {
				yield* platformAdmin.requireAdmin();
				return yield* Effect.promise(() => audioJobRecord(db, id));
			}),
			adminRequeueAudio: Effect.fn("Consultations.adminRequeueAudio")(function* (id: number) {
				yield* platformAdmin.requireAdmin();
				const queued = yield* Effect.promise(() => requeueAudioJob(db, id));
				if (!queued) return false;
				// The row's tenant_id is authoritative for the live fan-out
				// (same rule as attachAudio/updateAudioStatus).
				const tenantId = yield* Effect.promise(() => consultationTenantId(db, id));
				yield* events.dispatch([
					ConsultationAudioUpdated.make({
						consultationId: id,
						audioStatus: "queued",
						audioError: null,
						tenantId,
					}),
				]);
				// T-037: covers the /platform/ops audio-job retry, which
				// re-enqueues then lands here.
				yield* audit({
					action: "consultations.audio.requeue",
					targetType: "consultation",
					targetId: id,
					tenantId,
				});
				return true;
			}),
			adminCreate: Effect.fn("Consultations.adminCreate")(function* (fields: {
				userId: string;
				patientId?: number;
				transcript?: string;
				source: string;
				status?: string;
			}) {
				yield* platformAdmin.requireAdmin();
				const tenant = yield* Tenant;
				const tenantId = tenantScopeId(tenant);
				yield* requireCipheredWhenZk(db, tenantId, [fields.transcript], "consultation.create");
				if (fields.patientId !== undefined) {
					const owner = yield* patientQueries["patients.ownerOf"]({
						id: fields.patientId,
					});
					if (owner === null) return yield* Effect.fail(new Forbidden({ path: "patientId" }));
				}
				yield* Effect.annotateCurrentSpan({
					userId: fields.userId,
					source: fields.source,
					adminCreate: true,
				});
				yield* Effect.logInfo("consultation admin create", {
					userId: fields.userId,
					source: fields.source,
				});
				const id = yield* Effect.promise(() => createConsultation(db, fields, tenantId));
				if (id !== null) {
					yield* events.dispatch([
						ConsultationCreated.make({
							id,
							userId: fields.userId,
							source: fields.source,
							tenantId,
						}),
					]);
					// T-037: admin-created consultation — ids/source only,
					// never the transcript (PHI stays out of the audit log).
					yield* audit({
						action: "consultations.create",
						targetType: "consultation",
						targetId: id,
						tenantId,
						detail: {
							userId: fields.userId,
							patientId: fields.patientId ?? null,
							source: fields.source,
						},
					});
				}
				return id;
			}),
			adminDelete: Effect.fn("Consultations.adminDelete")(function* (id: number) {
				yield* platformAdmin.requireAdmin();
				yield* Effect.annotateCurrentSpan({ consultationId: id, adminDelete: true });
				yield* Effect.logInfo("consultation admin delete", { consultationId: id });
				// Read the tenant scope and patient link before the row is
				// gone — the audit entry keeps them (same rule as
				// adminRequeueAudio; the patientId lets the patient feed
				// find this row after the consultation is deleted).
				const scope = yield* Effect.promise(() => consultationAuditScope(db, id));
				const audioKey = yield* Effect.promise(() => deleteConsultationRow(db, id));
				// Missing row → nothing was deleted; report null so the
				// caller can answer "not found" like the owner paths do.
				if (audioKey === undefined) return null;
				yield* audit({
					action: "consultations.delete",
					targetType: "consultation",
					targetId: id,
					tenantId: scope.tenantId,
					detail: { hadAudio: audioKey !== null, patientId: scope.patientId },
				});
				return { audioKey };
			}),
			get: Effect.fn("Consultations.get")(function* (id: number, userId: string) {
				yield* requirePrincipalUser(userId, "consultation.read");
				const detail = yield* Effect.promise(() => getConsultation(db, id));
				if (detail === null) return null;
				// Tenant members read tenant-owned rows; personal rows stay
				// owner-scoped and platform admins read cross-owner either
				// way (admin detail page).
				yield* authorizeConsultationRow(platformAdmin, detail, "consultation.read");
				// Sensitive-read audit: detail.patientId joins the row to the
				// patient-facing feed; tenant_id is row-authoritative so
				// cross-owner admin reads scope correctly. ids only.
				yield* audit({
					action: "consultations.read",
					targetType: "consultation",
					targetId: detail.id,
					tenantId: detail.tenantId,
					detail: { patientId: detail.patientId, via: "detail" },
				});
				return detail;
			}),
			getLive: Effect.fn("Consultations.getLive")(function* (id: number, userId: string) {
				yield* requirePrincipalUser(userId, "consultation.read");
				const row = yield* Effect.promise(() => getLiveConsultation(db, id));
				if (row === null) return null;
				yield* authorizeConsultationRow(platformAdmin, row, "consultation.read");
				return { transcript: row.transcript, status: row.status };
			}),
			attachAnamnesis: Effect.fn("Consultations.attachAnamnesis")(function* (
				userId: string,
				input: AttachAnamnesisInput,
			) {
				yield* requirePrincipalUser(userId, "consultation.update");
				const owner = yield* Effect.promise(() => consultationOwner(db, input.consultationId));
				// Missing row → the UPDATE below is a no-op; nothing to authorize.
				if (owner !== null) {
					yield* authorizeConsultationRow(platformAdmin, owner, "consultation.update");
					// T-145: the ROW's tenant governs the cipher rule — the
					// ambient scope may be personal while the row is
					// tenant-owned.
					yield* requireCipheredWhenZk(
						db,
						owner.tenantId,
						[serializeAnamnesis(input.anamnesis)],
						"consultation.update",
					);
				}
				// Re-linking to a patient requires owning that patient;
				// null (clear) and undefined (keep) skip the lookup.
				if (typeof input.patientId === "number") {
					yield* requireOwnedPatient(input.patientId, "patient.read");
				}
				const scope = yield* consultationScope(userId);
				yield* Effect.annotateCurrentSpan({
					userId,
					consultationId: input.consultationId,
					engine: input.engine,
				});
				yield* Effect.logInfo("consultation attach anamnesis", {
					userId,
					consultationId: input.consultationId,
					engine: input.engine,
				});
				// Snapshot integrity state BEFORE the write — a pre-versioning
				// anamnesis still stored on the row seeds version 1.
				const prior = yield* Effect.promise(() =>
					anamnesisIntegrityState(db, input.consultationId),
				);
				const applied = yield* Effect.promise(() => attachAnamnesis(db, input, scope));
				if (applied) {
					if (prior !== null && prior.anamnesis !== null && prior.anamnesisVersion === null) {
						yield* recordVersion({
							entityType: ANAMNESIS_ENTITY_TYPE,
							entityId: input.consultationId,
							payload: prior.anamnesis,
							engine: null,
							actorUserId: userId,
						});
					}
					const recorded = yield* recordVersion({
						entityType: ANAMNESIS_ENTITY_TYPE,
						entityId: input.consultationId,
						payload: serializeAnamnesis(input.anamnesis),
						contentHash: input.version?.contentHash,
						signature: input.version?.signature ?? null,
						engine: input.engine,
						actorUserId: userId,
					});
					if (recorded !== null) {
						yield* Effect.promise(() => setAnamnesisIntegrity(db, input.consultationId, recorded));
					}
					// ids/engine only — never the anamnesis payload.
					yield* audit({
						action: "consultations.anamnesis.attach",
						targetType: "consultation",
						targetId: input.consultationId,
						tenantId: owner?.tenantId ?? null,
						detail: { engine: input.engine, patientId: input.patientId ?? null },
					});
				}
			}),
			adminBackfillVersions: Effect.fn("Consultations.adminBackfillVersions")(function* () {
				yield* platformAdmin.requireAdmin();
				const rows = yield* Effect.promise(() => unversionedAnamnesisRows(db, BACKFILL_BATCH));
				let backfilled = 0;
				for (const row of rows) {
					const recorded = yield* recordVersion({
						entityType: ANAMNESIS_ENTITY_TYPE,
						entityId: row.id,
						// `as string` — the query filters IS NOT NULL.
						payload: row.anamnesis as string,
						engine: row.engine,
						actorUserId: row.userId,
						createdAt: row.createdAt,
					});
					if (recorded !== null) {
						yield* Effect.promise(() => setAnamnesisIntegrity(db, row.id, recorded));
						backfilled += 1;
					}
				}
				const remaining = yield* Effect.promise(() => countUnversionedAnamnesis(db));
				if (backfilled > 0) {
					yield* audit({
						action: "consultations.integrity.backfill",
						targetType: "consultation",
						detail: { backfilled, remaining },
					});
				}
				return { backfilled, remaining };
			}),
			verifyIntegrity: Effect.fn("Consultations.verifyIntegrity")(function* (
				id: number,
				userId: string,
			) {
				yield* requirePrincipalUser(userId, "consultation.read");
				const row = yield* Effect.promise(() => anamnesisIntegrityHead(db, id));
				if (row === null) return null;
				// Same read authz as `get` — the report leaks no content, but
				// the chain's existence/shape is still record metadata.
				yield* authorizeConsultationRow(platformAdmin, row, "consultation.read");
				const option = yield* Effect.serviceOption(Integrity);
				const base: IntegrityVerification = Option.isSome(option)
					? yield* option.value.verify(ANAMNESIS_ENTITY_TYPE, id)
					: {
							status: "unversioned",
							versions: 0,
							unverifiableContent: 0,
							signed: 0,
							issues: [],
							head: null,
						};
				// The row's materialized head must point at the chain head —
				// a diverged column pair means a version write was swallowed
				// or the columns were rewritten underneath the chain.
				const headIssue =
					base.head !== null &&
					(row.anamnesisVersion !== base.head.version ||
						row.anamnesisHash !== base.head.contentHash)
						? [{ version: base.head.version, code: "head-diverged" as const }]
						: [];
				const issues = [...base.issues, ...headIssue];
				return {
					...base,
					status: issues.length > 0 ? ("tampered" as const) : base.status,
					issues,
					storedVersion: row.anamnesisVersion,
				};
			}),
			recordConsent: Effect.fn("Consultations.recordConsent")(function* (
				id: number,
				userId: string,
			) {
				yield* requirePrincipalUser(userId, "consultation.update");
				const owner = yield* Effect.promise(() => consultationOwner(db, id));
				if (owner !== null) {
					yield* authorizeConsultationRow(platformAdmin, owner, "consultation.update");
				}
				const scope = yield* consultationScope(userId);
				yield* Effect.annotateCurrentSpan({ consultationId: id, userId });
				yield* Effect.logInfo("consultation consent recorded", { consultationId: id, userId });
				yield* Effect.promise(() => recordConsent(db, id, scope));
				// ids only — the consent timestamp itself is metadata.
				yield* audit({
					action: "consultations.consent.record",
					targetType: "consultation",
					targetId: id,
					tenantId: owner?.tenantId ?? null,
				});
			}),
			attachAudio: Effect.fn("Consultations.attachAudio")(function* (
				userId: string,
				input: { consultationId: number } & AudioJobFields,
			) {
				yield* requirePrincipalUser(userId, "consultation.update");
				const owner = yield* Effect.promise(() => consultationOwner(db, input.consultationId));
				if (owner !== null) {
					yield* authorizeConsultationRow(platformAdmin, owner, "consultation.update");
				}
				yield* Effect.annotateCurrentSpan({
					userId,
					consultationId: input.consultationId,
					audioKey: input.audioKey,
				});
				yield* Effect.logInfo("consultation audio attached", {
					userId,
					consultationId: input.consultationId,
				});
				yield* Effect.promise(() => attachAudioRecord(db, input.consultationId, input));
				yield* events.dispatch([
					ConsultationAudioUpdated.make({
						consultationId: input.consultationId,
						audioStatus: "stored",
						audioError: null,
						// The row's tenant_id is authoritative — ambient
						// Tenant may not match the row's owner scope.
						tenantId: owner?.tenantId ?? null,
					}),
				]);
				// Content metadata only — the audio key itself is an
				// object-store path, not PHI, but ids suffice here.
				yield* audit({
					action: "consultations.audio.attach",
					targetType: "consultation",
					targetId: input.consultationId,
					tenantId: owner?.tenantId ?? null,
					detail: { contentType: input.contentType ?? null, size: input.size ?? null },
				});
			}),
			updateAudioStatus: Effect.fn("Consultations.updateAudioStatus")(function* (
				userId: string,
				consultationId: number,
				status: AudioRouteStatus,
			) {
				yield* requirePrincipalUser(userId, "consultation.update");
				const owner = yield* Effect.promise(() => consultationOwner(db, consultationId));
				if (owner !== null) {
					yield* authorizeConsultationRow(platformAdmin, owner, "consultation.update");
				}
				yield* Effect.annotateCurrentSpan({ userId, consultationId, audioStatus: status });
				yield* Effect.promise(() => markAudioRouteStatus(db, consultationId, status));
				yield* events.dispatch([
					ConsultationAudioUpdated.make({
						consultationId,
						audioStatus: status,
						audioError: null,
						tenantId: owner?.tenantId ?? null,
					}),
				]);
				yield* audit({
					action: "consultations.audio.status",
					targetType: "consultation",
					targetId: consultationId,
					tenantId: owner?.tenantId ?? null,
					detail: { status },
				});
			}),
			history: Effect.fn("Consultations.history")(function* (
				patientId: number,
				userId: string,
				excludeId?: number,
			) {
				yield* requireCanAs("consultation.read", { userId });
				const result = yield* Effect.promise(() =>
					patientHistory(db, patientId, userId, excludeId),
				);
				// History rows carry no tenant — scope to the ambient tenant.
				// Only a successful read is audited: a null result means the
				// patient is not visible to the caller, so there is no
				// sensitive read to record.
				if (result !== null) {
					yield* audit({
						action: "consultations.history.read",
						targetType: "patient",
						targetId: patientId,
						tenantId: tenantScopeId(yield* Tenant),
						detail: { patientId, via: "history" },
					});
				}
				return result;
			}),
			historyRows: Effect.fn("Consultations.historyRows")(function* (
				patientId: number,
				userId: string,
				excludeId?: number,
			) {
				yield* requireCanAs("consultation.read", { userId });
				const result = yield* Effect.promise(() =>
					patientHistoryRows(db, patientId, userId, excludeId),
				);
				if (result !== null) {
					yield* audit({
						action: "consultations.history.read",
						targetType: "patient",
						targetId: patientId,
						tenantId: tenantScopeId(yield* Tenant),
						detail: { patientId, via: "history-rows" },
					});
				}
				return result;
			}),
		});
	}),
);
