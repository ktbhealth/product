import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Relative import on purpose: drizzle-kit loads the composed schema
// through a CJS resolver that cannot follow `@ktb/*` package
// specifiers, and the generated packages/db/src/schema.gen.ts reaches
// plugin sources by relative path anyway — keep the FK target on the
// same module resolution.
import { groups } from "../../groups/src/schema.ts";

// FHIR R4 Patient + RNDS/BR Core extensions; codes and labels live in
// @ktb/patients/record. Everything beyond `name` is nullable so
// pre-existing name-only patients stay valid until the doctor completes
// the record. Plugin-owned table definition (P-061): aggregated into
// the drizzle schema by the generated packages/db/src/schema.gen.ts —
// consumers keep importing it from `@ktb/db/schema` (or
// `@ktb/patients/schema`).
//
// `tenantId` (P-053): NULL = personal row scoped by `ownerId`; a
// `groups.id` = tenant-owned row readable/operable by that tenant's
// members. `ownerId` stays the creator/owner attribution either way.
// The table stays `sqliteTable` (not `tenantTable`) on purpose: the
// repo helpers rely on joins/group-bys and system paths that
// `scopedRepo` cannot express — tenant fencing is applied through
// `tenantScopeCondition` + service authz instead. SET NULL keeps the
// record if the clinic group is deleted. The column is declared inline
// (`integer("tenant_id")`, same shape as `@ktb/tenant`'s
// `tenantIdColumn`) because @ktb/tenant depends on @ktb/db — importing
// it here would create a workspace cycle.
export const patients = sqliteTable(
	"patients",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		ownerId: text("owner_id").notNull(),
		tenantId: integer("tenant_id").references(() => groups.id, { onDelete: "set null" }),
		name: text().notNull(),
		active: integer({ mode: "boolean" }).notNull().default(true),
		socialName: text("social_name"),
		/** FHIR AdministrativeGender. */
		gender: text(),
		/** FHIR date: YYYY | YYYY-MM | YYYY-MM-DD. */
		birthDate: text("birth_date"),
		phone: text(),
		email: text(),
		/** BCP-47 tag. */
		preferredLanguage: text("preferred_language"),
		addressLine: text("address_line"),
		addressNumber: text("address_number"),
		addressComplement: text("address_complement"),
		district: text(),
		city: text(),
		state: text(),
		postalCode: text("postal_code"),
		/** ISO 3166-1 alpha-2. */
		country: text(),
		motherName: text("mother_name"),
		/** HL7 v3 MaritalStatus. */
		maritalStatus: text("marital_status"),
		/** RNDS BRRacaCor. */
		raceColor: text("race_color"),
		/** ISO 3166-1 alpha-2. */
		nationality: text(),
		emergencyContactName: text("emergency_contact_name"),
		emergencyContactRelationship: text("emergency_contact_relationship"),
		emergencyContactPhone: text("emergency_contact_phone"),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" }),
	},
	(table) => [index("patients_tenant_id_idx").on(table.tenantId)],
);

/**
 * State-issued identifiers of a patient — CPF, CNS, passport today —
 * one row per document instead of one column per kind, so a new
 * country's documents are new rows, not new columns. `type` is a key of
 * `PATIENT_DOCUMENT_TYPES` (@ktb/patients/record), which owns each
 * kind's country, validation and formatting; a patient holds at most
 * one document of each type.
 *
 * Like the rest of the record these are what the doctor registered,
 * and they are per-record: the same person under two doctors has two
 * sets of rows, so `number` is deliberately not unique across patients.
 */
export const patientDocuments = sqliteTable(
	"patient_documents",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		patientId: integer("patient_id")
			.notNull()
			.references(() => patients.id, { onDelete: "cascade" }),
		type: text().notNull(),
		/** Issuing country, ISO 3166-1 alpha-2 — NULL when the type is not
		 * tied to one country and the issuer was not recorded (passports). */
		country: text(),
		/** Normalized value — digits only for numeric identifiers. */
		number: text().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [uniqueIndex("patient_documents_patient_type_idx").on(table.patientId, table.type)],
);
