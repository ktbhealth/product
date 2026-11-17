import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { physical } from "@tanstack/virtual-file-routes";

import { auditServicesPlugin } from "@ktb/audit";
import { integrityServicesPlugin } from "@ktb/integrity";
import { consultations } from "@ktb/db/schema";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import {
	Patients,
	patientsServicesPlugin,
	type AdminPatientRow,
	type OwnerOption,
} from "@ktb/patients";
import { patientAccessServicesPlugin } from "@ktb/patient-access";
import { vaultServicesPlugin } from "@ktb/vault";
import { ClipboardListIcon } from "lucide-react";

import { ConsultationsPlatformPage } from "./platform-page.tsx";
import {
	ConsultationsDashboardSections,
	ConsultationsDashboardStats,
} from "./views/ConsultationsDashboard.tsx";
import { Consultations, ConsultationsLive } from "./service.ts";
import type { AdminConsultationRow } from "./queries.ts";
import {
	ConsultationsQueriesLive,
	PatientDeleteCascadeLive,
	PatientRecordConsultationsLive,
} from "./cqrs.ts";

// Public surface — the implementation lives in focused modules; every
// name index.ts exported before the split is re-exported here so
// `@ktb/consultations` importers are unaffected.
export {
	ANAMNESIS_ENTITY_TYPE,
	BACKFILL_BATCH,
	HISTORY_LIMIT,
	type ConsultationIntegrityReport,
	type HistoryRow,
	type PatientHistoryRows,
} from "./anamnesis.ts";
export {
	AUDIO_RETRY_STATUSES,
	AUDIO_ROUTE_STATUSES,
	AUDIO_TRANSCRIPTION_JOB_KIND,
	attachAudioRecord,
	audioJobRecord,
	audioJobRow,
	beginAudioJob,
	completeAudioJob,
	failAudioJob,
	listAudioJobRows,
	markAudioQueued,
	markAudioRouteStatus,
	requeueAudioJob,
	saveCorrectedTranscript,
	type AudioJobFields,
	type AudioJobRecord,
	type AudioJobRow,
	type AudioRouteStatus,
} from "./audio-jobs.ts";
export {
	ConsultationsQueriesLive,
	PatientDeleteCascadeLive,
	PatientRecordConsultationsLive,
} from "./cqrs.ts";
export {
	appendTranscript,
	consultationTenantId,
	createConsultation,
	deleteConsultationRow,
	finishConsultation,
	ownsBot,
} from "./lifecycle.ts";
export { listAllConsultations, type AdminConsultationRow } from "./queries.ts";
export { Consultations, ConsultationsLive } from "./service.ts";
export {
	serializeAnamnesis,
	type AttachAnamnesisInput,
	type ConsultationDetail,
	type ConsultationRow,
	type ConsultationSummary,
	type SaveConsultationInput,
	type SignedVersion,
} from "./shared.ts";
export { consultationScope } from "./tenant-visibility.ts";

export const consultationsTablesPlugin = definePlugin({
	id: "consultations.tables",
	meta: { keywords: ["consultations", "tables"] },
	tables: { consultations },
});

export const consultationsServicesPlugin = definePlugin({
	id: "consultations.services",
	meta: { keywords: ["consultations", "services"] },
	requiredDeps: [patientsServicesPlugin.id, platformAdminPlugin.id],
	// Audit + integrity writes resolve via serviceOption — the dep edges
	// are ordering hints only; absence of either is legal. Vault and
	// patient-access are the same shape: ZK paths resolve Vault via
	// serviceOption and read clinic_keys through tenantIsZk, while the
	// views call patient-access/vault server fns (invite, portal
	// readers, DEK envelopes, grants) that degrade to hidden/failed
	// features when those plugins are absent.
	optionalDeps: [
		auditServicesPlugin.id,
		integrityServicesPlugin.id,
		patientAccessServicesPlugin.id,
		vaultServicesPlugin.id,
	],
	services: Layer.mergeAll(
		ConsultationsLive,
		ConsultationsQueriesLive,
		PatientRecordConsultationsLive,
		PatientDeleteCascadeLive,
	),
});

// Route subtree composed into the host's virtualRouteConfig (P-033):
// the route modules live in THIS package (src/routes/**) and are
// discovered by a physical() directory scan. The directory path is
// resolved relative to the host's routes directory
// (apps/web/src/routes) — "../../../../" escapes to the repo root —
// and the modules reach the app runtime through @ktb/server-fns, so
// the plugin owns routes end to end with zero host route files.
export const consultationsRoutesPlugin = definePlugin({
	id: "consultations.routes",
	meta: { keywords: ["consultations", "routes"] },
	routes: [
		physical("/consultations", "../../../../plugins/consultations/src/routes"),
		// API subtree: /api/consultations/:id/{audio,pdf}, /api/transcribe and
		// /api/patients/:id/export — owner-only record/audio/export endpoints.
		// Route modules must live directly in src/api-routes/ — the generator
		// scans every file in the mounted directory.
		physical("/api", "../../../../plugins/consultations/src/api-routes"),
	],
});

// Chrome contributions (P-060): the console sidebar entry lives in a
// `chrome` region; the dep edge orders it after the platform shell
// like the retired panel entry.
export const consultationsChromePlugin = definePlugin({
	id: "consultations.chrome",
	meta: { keywords: ["consultations", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "consultations.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/consultations",
					label: "Consultations",
					icon: ClipboardListIcon,
					group: "Domains",
				},
			},
		},
		// /platform dashboard slots (T-125): the console landing page is a
		// generic shell — this plugin contributes its stat cells and the
		// consultations section through the portal.dashboard.* regions.
		// Rows arrive via ConsultationsDashboardContext, which the
		// /platform layout provides from adminListConsultationsFn.
		{
			id: "consultations.dashboard.stats",
			region: "portal.dashboard.stats",
			when: { paths: ["/platform"] },
			content: { kind: "component", component: ConsultationsDashboardStats },
		},
		{
			id: "consultations.dashboard.sections",
			region: "portal.dashboard.sections",
			when: { paths: ["/platform"] },
			content: { kind: "component", component: ConsultationsDashboardSections },
		},
	],
});

// Panel (system console) contribution: /platform/consultations is
// mounted by the platform plugin's physical route subtree; this plugin
// only declares the page descriptor. The dep edge orders it after the
// platform shell.
export const consultationsPanelPlugin = definePlugin({
	id: "consultations.panel",
	requiredDeps: [platformPanelPlugin.id],
	meta: {
		keywords: ["consultations", "ui"],
		name: "Consultations",
		description: "Consultation records and audio jobs",
		icon: ClipboardListIcon,
	},
	panel: {
		pages: [
			{
				id: "consultations.admin",
				path: "/platform/consultations",
				component: ConsultationsPlatformPage,
				// Cross-owner listing for the console — the service
				// re-checks the PlatformAdmin gate; Forbidden collapses
				// to the same empty table the old server fn returned.
				loader: () =>
					Effect.gen(function* () {
						const consultations = yield* Consultations;
						const patientsSvc = yield* Patients;
						// T-138 backfill: each admin console visit materializes a
						// batch of version-1 hashes for pre-versioning anamneses —
						// idempotent, self-draining, no runbook step.
						yield* consultations
							.adminBackfillVersions()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
						const [rows, owners, patientRows] = yield* Effect.all([
							consultations
								.adminList()
								.pipe(
									Effect.catchTag("Forbidden", () => Effect.succeed([] as AdminConsultationRow[])),
								),
							patientsSvc
								.adminOwners()
								.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as OwnerOption[]))),
							patientsSvc
								.adminList()
								.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as AdminPatientRow[]))),
						]);
						return {
							consultations: rows,
							owners,
							patients: patientRows.map((p) => ({
								id: p.id,
								name: p.name,
								ownerId: p.ownerId,
								ownerName: p.ownerName ?? p.ownerEmail ?? "",
							})),
						};
					}),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	consultationsTablesPlugin,
	consultationsServicesPlugin,
	consultationsRoutesPlugin,
	consultationsChromePlugin,
	consultationsPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"consultations.tables": true;
		"consultations.services": true;
		"consultations.routes": true;
		"consultations.chrome": true;
		"consultations.panel": true;
	}
}
