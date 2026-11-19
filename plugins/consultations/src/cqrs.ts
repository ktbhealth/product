import * as Effect from "effect/Effect";

import { Forbidden, Principal } from "@ktb/authz";
import { Permissions } from "@ktb/rbac";
import { Option } from "effect";
import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";
import {
	PatientCascadeCommands,
	PatientRecordConsultationsQueries,
	PatientsCommands,
	PatientsQueries,
} from "@ktb/patients/api";
import { decodeAnamnesisOption } from "@ktb/anamnesis/schema";
import { Command, Query } from "@effect-server-utils/cqrs";

import { ConsultationsQueries } from "./api.ts";
import { listAudioJobRows } from "./audio-jobs.ts";
import {
	deletePatientConsultations,
	listAllConsultations,
	listConsultations,
	patientConsultationRows,
} from "./queries.ts";
import { parseStored } from "./shared.ts";
import {
	authorizeConsultationRow,
	consultationScope,
	isPlatformAdmin,
} from "./tenant-visibility.ts";

/** Cross-plugin query surface — registered so other plugins can
 * `Query.dispatcher(ConsultationsQueries)` against it. */
export const ConsultationsQueriesLive = Query.handlersOf(ConsultationsQueries, {
	// Cross-owner read — same gate as `Consultations.adminList`: the
	// platform-admin check fails Forbidden for non-admins and for
	// system contexts (null principal) alike.
	"consultations.audioJobs": () =>
		Effect.gen(function* () {
			const platformAdmin = yield* PlatformAdmin;
			yield* platformAdmin.requireAdmin();
			const db = yield* Db;
			return yield* Effect.promise(() => listAudioJobRows(db));
		}),
});

/**
 * `patients.*` CQRS surface owned by this plugin (P-033): the patients
 * plugin's server functions dispatch these groups; the defs live in
 * @ktb/patients/api so patients never imports @ktb/consultations.
 * Handlers reuse the same authz + row helpers as the Consultations
 * service methods they mirror.
 */
export const PatientRecordConsultationsLive = Query.handlersOf(PatientRecordConsultationsQueries, {
	"patients.recordConsultations": ({ patientId }) =>
		Effect.gen(function* () {
			const principal = yield* Principal;
			if (principal === null) return yield* Effect.fail(new Forbidden({ path: "principal" }));
			const db = yield* Db;
			const platformAdmin = yield* PlatformAdmin;
			// Platform admins get the cross-owner view — the admin delete
			// dialog needs the real cascade count, not just the admin's
			// own consultations.
			if (yield* isPlatformAdmin(platformAdmin)) {
				const all = yield* Effect.promise(() => listAllConsultations(db));
				return all
					.filter((r) => r.patientId === patientId)
					.map((r) => ({
						id: r.id,
						patientId,
						createdAt: r.createdAt,
						status: r.status,
						hasAnamnesis: r.anamnesis !== null,
						chiefComplaint: (() => {
							const parsed = parseStored(r.anamnesis, decodeAnamnesisOption);
							return parsed?.queixa_principal.content ?? null;
						})(),
					}));
			}
			// Same gate as Consultations.list — owner + tenant scoped read.
			// (The retired permix self-check `consultation.read` on
			// { userId: principal.userId } was tautological — the row
			// scope below is the real fence.)
			const scope = yield* consultationScope(principal.userId);
			const rows = yield* Effect.promise(() => listConsultations(db, patientId, scope));
			return rows.map((r) => ({
				id: r.id,
				// Rows are filtered by patientId — the column is nullable
				// in the schema but the query param is the link here.
				patientId,
				createdAt: r.createdAt,
				status: r.status,
				hasAnamnesis: r.hasAnamnesis,
				chiefComplaint: r.chiefComplaint,
			}));
		}),
});

export const PatientDeleteCascadeLive = Command.handlersOf(PatientCascadeCommands, {
	"patients.deleteCascade": ({ patientId }) =>
		Effect.gen(function* () {
			const principal = yield* Principal;
			if (principal === null) return yield* Effect.fail(new Forbidden({ path: "principal" }));
			const db = yield* Db;
			const platformAdmin = yield* PlatformAdmin;
			const patientQueries = yield* Query.dispatcher(PatientsQueries);
			const patientCommands = yield* Command.dispatcher(PatientsCommands);
			// Patient cascade owned by this plugin — the caller is the bound
			// Principal (no userId param to cross-check), so the flow is:
			// patient owner lookup → per-consultation authz → cascade →
			// `patients.delete` (which owns patient authz + the row delete).
			const owner = yield* patientQueries["patients.ownerOf"]({ id: patientId });
			if (owner === null) return null;
			const rows = yield* Effect.promise(() => patientConsultationRows(db, patientId));
			// Platform admins skip the per-row owner check — they act
			// cross-owner; `patients.delete` applies the same override.
			const admin = yield* isPlatformAdmin(platformAdmin);
			// Record authz resolves owner tuples through the rbac plugin's
			// Permissions port — optional like the service layer's; absent
			// fails the per-row check closed (Forbidden).
			const permissionsOption = yield* Effect.serviceOption(Permissions);
			const permissions = Option.isSome(permissionsOption) ? permissionsOption.value : null;
			for (const row of rows) {
				// Tenant members pass on tenant-owned rows; personal rows
				// keep the per-row owner check (admin already skipped).
				if (!admin) {
					yield* authorizeConsultationRow(platformAdmin, permissions, row, "consultation.delete");
				}
			}
			// Every row passed the per-row authz above — delete exactly
			// those ids. Admins act cross-owner, so the scanned set is
			// already the full linked set either way.
			yield* Effect.promise(() =>
				deletePatientConsultations(
					db,
					patientId,
					rows.map((r) => r.id),
				),
			);
			yield* patientCommands["patients.delete"]({ id: patientId });
			// The `patients.delete` command handler records the audit row
			// for EVERY patient delete (owner and admin alike — P-080);
			// writing one here too would double-log admin deletes.
			return {
				consultations: rows.length,
				audioKeys: rows.flatMap((r) => (r.audioKey ? [r.audioKey] : [])),
			};
		}),
});
