import { defineCipher } from "@ktb/crypto/cipher";

/**
 * Consultation cipher spec (PL-007 F3, T-145): every clinical-content
 * column — the browser transcript, the saved anamnesis document, the
 * retained `review` column and the server-side ASR/LLM transcripts —
 * is ciphertext at rest for ZK tenants. Plaintext BY DESIGN: ids,
 * owner/tenant attribution, engine/source/status metadata, consent and
 * audio bookkeeping, the integrity columns and timestamps — authz,
 * scoping, the jobs feed and the version chain all run on them.
 *
 * Audio note: `audioKey` is an R2 object reference, not content — the
 * blob it names is client-encrypted under ZK (T-147), the key itself
 * stays operational metadata.
 */
export const CONSULTATION_CIPHERED_FIELDS = [
	"transcript",
	"anamnesis",
	"review",
	"serverTranscript",
	"correctedTranscript",
] as const;

export const consultationCipher = defineCipher({
	entity: "consultation",
	fields: CONSULTATION_CIPHERED_FIELDS,
	plaintext: [
		"id",
		"userId",
		"patientId",
		"tenantId",
		"engine",
		"source",
		"status",
		"botId",
		"consentAt",
		"audioKey",
		"audioStatus",
		"audioContentType",
		"audioSize",
		"audioError",
		"enhancementEngine",
		"anamnesisHash",
		"anamnesisVersion",
		"blobHash",
		"createdAt",
	],
});
