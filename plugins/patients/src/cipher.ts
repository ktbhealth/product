import { defineCipher } from "@ktb/crypto/cipher";

import { TEXT_FIELDS } from "./record.ts";

/**
 * Patient cipher spec (PL-007 F3, T-144): every PII field — all
 * TEXT_FIELDS, including the identifier fields whose values persist as
 * `patient_documents.number` — is ciphertext at rest for ZK tenants.
 * Plaintext BY DESIGN: ids, owner/tenant attribution, the `active`
 * flag and timestamps — authz, scoping and bookkeeping run on them.
 *
 * The spec classifies keys for BOTH directions of the row codec:
 * - write: the wire draft is TEXT_FIELDS + `active` (envelopes replace
 *   values before the fn call);
 * - read: the flattened `Patient` read model is every `patients`
 *   column plus one key per document kind — all covered.
 */
export const patientCipher = defineCipher({
	entity: "patient",
	fields: TEXT_FIELDS,
	plaintext: [
		"id",
		"ownerId",
		"tenantId",
		"active",
		"synthetic",
		"createdAt",
		"updatedAt",
		// Read-model joins (listPatients flattens owner display fields
		// onto the row) — plaintext metadata, never persisted by clients.
		"ownerEmail",
		"ownerName",
	],
});
