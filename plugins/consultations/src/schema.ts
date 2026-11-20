import { index, integer, sqliteTable, text } from "@ktb/db/table";

import { groups } from "@ktb/groups/schema";
import { patients } from "@ktb/patients/schema";

// `tenantId` (P-053): NULL = personal row scoped by `userId`; a
// `groups.id` = tenant-owned row readable/operable by that tenant's
// members. `userId` stays the creator/owner attribution either way.
// Same `sqliteTable` (not `tenantTable`) rationale as the patients
// table — see @ktb/patients/schema. SET NULL keeps the record if the
// clinic group is deleted. The column is declared inline
// (`integer("tenant_id")`, same shape as `@ktb/tenant`'s
// `tenantIdColumn`) because @ktb/tenant depends on @ktb/db — importing
// it here would create a workspace cycle.
//
// Plugin-owned table definition (P-061): aggregated into the drizzle
// schema by the generated packages/db/src/schema.gen.ts — consumers
// keep importing it from `@ktb/db/schema` (or
// `@ktb/consultations/schema`).
export const consultations = sqliteTable(
	"consultations",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		userId: text("user_id"),
		patientId: integer("patient_id").references(() => patients.id),
		tenantId: integer("tenant_id").references(() => groups.id, { onDelete: "set null" }),
		/** Browser-side transcript; the stored audio lives in R2 (audioKey). */
		transcript: text().notNull(),
		/** Serialized Anamnesis (structured, reviewed/editable). */
		anamnesis: text(),
		/** Retained legacy column: second-opinion review was removed. */
		review: text(),
		/** Which AnamnesisExtractor produced the draft. */
		engine: text(),
		/** Transcription source: browser | bot | dictation | upload. */
		source: text().notNull().default("browser"),
		/** live (still transcribing) | done */
		status: text().notNull().default("done"),
		/** Provider-side bot id (MeetingBotTranscriber source). */
		botId: text("bot_id"),
		/** When the doctor declared patient consent (LGPD trail). */
		consentAt: integer("consent_at", { mode: "timestamp" }),
		/** R2 object key for the stored session audio (P-015). */
		audioKey: text("audio_key"),
		/**
		 * Audio pipeline state: none | stored | queued | processing | done | failed.
		 * "done" means the server transcript finished; LLM cleanup is tracked
		 * separately via correctedTranscript/enhancementEngine.
		 */
		audioStatus: text("audio_status").notNull().default("none"),
		audioContentType: text("audio_content_type"),
		audioSize: integer("audio_size"),
		/** Last pipeline failure reason — surfaced to the doctor, never the audio. */
		audioError: text("audio_error"),
		/** whisper-large-v3-turbo output — the raw ASR evidence. */
		serverTranscript: text("server_transcript"),
		/** LLM-cleaned PT-BR transcript — machine-corrected, NOT physician-approved. */
		correctedTranscript: text("corrected_transcript"),
		/** Which engine produced correctedTranscript (e.g. "anthropic", "workers-ai:..."). */
		enhancementEngine: text("enhancement_engine"),
		/**
		 * Integrity columns (PL-007 F1, T-138): `anamnesisHash` is the
		 * SHA-256 content hash of the canonical anamnesis document and
		 * `anamnesisVersion` the matching `record_versions` row — NULL on
		 * rows that predate versioning (the backfill materializes them as
		 * version 1). `blobHash` is SHA-256 over the stored `anamnesis`
		 * bytes — a corruption check that stays meaningful once the column
		 * holds AEAD ciphertext for ZK tenants.
		 */
		anamnesisHash: text("anamnesis_hash"),
		anamnesisVersion: integer("anamnesis_version"),
		blobHash: text("blob_hash"),
		/**
		 * Synthetic flag (P-098 WS-F): eval-generated consultations
		 * (`eval_instance_item` corpus rows) exercise the REAL
		 * transcription/anamnesis pipeline, so they persist as ordinary
		 * consultations marked synthetic — same contract as
		 * patients.synthetic/doctors.synthetic. UI surfaces may filter
		 * or badge them; analytics must exclude them.
		 */
		synthetic: integer({ mode: "boolean" }).notNull().default(false),
		/**
		 * Provenance back-pointer to the eval corpus item
		 * (eval_instance_item.id) — SOFT integer reference, no FK:
		 * cross-plugin refs stay migration-decoupled, and deleting the
		 * corpus item must not cascade-delete consultation history.
		 * NULL on every human-created row.
		 */
		evalItemId: integer("eval_item_id"),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [index("consultations_tenant_id_idx").on(table.tenantId)],
);
