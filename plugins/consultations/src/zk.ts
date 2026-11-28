import { Option } from "effect";

import { decryptText } from "@ktb/crypto/aead";
import { decryptRow } from "@ktb/crypto/cipher";
import { contentHash } from "@ktb/crypto/digest";
import type { KeyringService } from "@ktb/crypto/keyring";
import { isEnvelope, makeEntityZk } from "@ktb/crypto/zk";
import type { GrantInput } from "@ktb/crypto/zk";
import type { Anamnesis, AnamnesisExtractor } from "@ktb/anamnesis";
import { HeuristicExtractor } from "@ktb/anamnesis";
import { decodeAnamnesisOption } from "@ktb/anamnesis/schema";
import { type DekEnvelopesApi, type PatientZkApi, PATIENT_ENTITY_TYPE } from "@ktb/patients/zk";

import { consultationCipher } from "./cipher.ts";

/**
 * Client-side consultation cipher orchestration (PL-007 F3, T-145):
 * under a ZK tenant the clinical columns are AES-256-GCM envelopes
 * keyed by a per-consultation DEK that `entity_deks` holds wrapped to
 * each authorized device pubkey — same construction as the patients
 * plugin (T-144). The server stores and validates shape only; all
 * wrapping, encryption, decryption and version signing happen in the
 * browser.
 *
 * The shared machinery lives in `@ktb/crypto/zk` (`makeEntityZk`). The
 * ZK api surface is deliberately identical to `PatientZkApi` —
 * `entityType` travels on every call — so both plugins wire the same
 * vault server fns. `decryptConsultations` stays entity-specific: it
 * additionally unwraps the joined `patientName` envelopes under the
 * PATIENT entity DEK — a second entity type the single-entity kit
 * intentionally does not absorb.
 */
export const CONSULTATION_ENTITY_TYPE = consultationCipher.entity;

export type { GrantInput };

/** Same contract as `PatientZkApi` — devices, batched own-envelope
 * lookup and grant writes, all bound-tenant scoped inside vault fns. */
export type ConsultationZkApi = PatientZkApi;

/** `{keyring, api}` bundle threaded through views under ZK. */
export interface ConsultationZk {
	readonly keyring: KeyringService;
	readonly api: ConsultationZkApi;
	/** Clinic-configured BYOK extractor (T-146) — absent when the device
	 * holds no provider key; the seam then stays on the heuristic. */
	readonly extractor?: AnamnesisExtractor;
}

export { isEnvelope };

/**
 * A consultation row is ciphertext when its `anamnesis` column carries
 * an envelope (saved records) — `transcript` alone marks a
 * record-less ciphered row. Either makes the row's clinical content
 * opaque to the server.
 */
export const isCipheredConsultation = (c: {
	readonly anamnesis?: string | null;
	readonly transcript?: string | null;
}): boolean => isEnvelope(c.anamnesis) || isEnvelope(c.transcript);

/** Serialized anamnesis JSON → typed document, null on any drift —
 * the plaintext decode after `decryptRow` hands back the stored
 * canonical string. */
export const parseAnamnesis = (json: string | null | undefined): Anamnesis | null => {
	if (json === null || json === undefined) return null;
	try {
		return Option.getOrNull(decodeAnamnesisOption(JSON.parse(json)));
	} catch {
		return null;
	}
};

/** Columns the cipher spec classifies — join fields (patientName,
 * ownerName/Email) are decrypted separately (patient entity DEK) or
 * stay plaintext. */
const specKeys = (row: Record<string, unknown>): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const key of [...consultationCipher.fields, ...consultationCipher.plaintext]) {
		if (key in row) out[key] = row[key];
	}
	return out;
};

/**
 * The client-writable ciphered columns: `transcript` and the serialized
 * anamnesis on save/attach. The other spec fields (`review`,
 * `serverTranscript`, `correctedTranscript`) are server-written and
 * never client-encrypted.
 */
const consultationZk = makeEntityZk({
	entityType: CONSULTATION_ENTITY_TYPE,
	cipher: consultationCipher,
	fields: ["transcript", "anamnesis"],
});

/**
 * Decrypt every ciphered row: one batched envelope lookup for the
 * consultation DEKs, another for the patient DEKs covering the joined
 * `patientName` envelopes (different entity — same keyring). Rows
 * without a grant — or with undecryptable envelopes — come back
 * unchanged so views can render a locked state instead of dropping
 * records.
 */
export async function decryptConsultations<R extends { readonly id: number }>(
	keyring: KeyringService,
	api: DekEnvelopesApi,
	rows: readonly R[],
): Promise<R[]> {
	const ciphered = rows.filter((r) =>
		isCipheredConsultation(
			r as { readonly anamnesis?: string | null; readonly transcript?: string | null },
		),
	);
	const named = rows.filter(
		(r): r is R & { readonly patientId: number; readonly patientName: string } =>
			isEnvelope((r as { readonly patientName?: unknown }).patientName) &&
			typeof (r as { readonly patientId?: unknown }).patientId === "number",
	);
	if (ciphered.length === 0 && named.length === 0) return [...rows];
	const { wrapPublicKey } = await keyring.deviceKeys();
	const [consultEnvelopes, patientEnvelopes] = await Promise.all([
		ciphered.length === 0
			? Promise.resolve<Record<string, string>>({})
			: api.dekEnvelopes({
					entityType: CONSULTATION_ENTITY_TYPE,
					entityIds: ciphered.map((r) => r.id),
					wrapPublicKey,
				}),
		named.length === 0
			? Promise.resolve<Record<string, string>>({})
			: api.dekEnvelopes({
					entityType: PATIENT_ENTITY_TYPE,
					entityIds: [...new Set(named.map((r) => r.patientId))],
					wrapPublicKey,
				}),
	]);
	const patientDeks = new Map<number, CryptoKey>();
	const patientDek = async (patientId: number): Promise<CryptoKey | null> => {
		if (patientDeks.has(patientId)) return patientDeks.get(patientId)!;
		const envelope = patientEnvelopes[String(patientId)];
		if (envelope === undefined) return null;
		try {
			const dek = await keyring.unwrapKey(envelope);
			patientDeks.set(patientId, dek);
			return dek;
		} catch {
			return null;
		}
	};
	const out: R[] = [];
	for (const row of rows) {
		let next = row;
		if (
			isCipheredConsultation(
				next as { readonly anamnesis?: string | null; readonly transcript?: string | null },
			)
		) {
			const envelope = consultEnvelopes[String(next.id)];
			if (envelope !== undefined) {
				try {
					const dek = await keyring.unwrapKey(envelope);
					next = {
						...next,
						...(await decryptRow(
							consultationCipher,
							dek,
							specKeys(next as unknown as Record<string, unknown>),
						)),
					};
				} catch {
					// Undecryptable row stays ciphered → locked rendering.
				}
			}
		}
		if (
			isEnvelope((next as { readonly patientName?: unknown }).patientName) &&
			typeof (next as { readonly patientId?: unknown }).patientId === "number"
		) {
			const namedRow = next as unknown as { patientId: number; patientName: string };
			const dek = await patientDek(namedRow.patientId);
			if (dek !== null) {
				try {
					next = { ...next, patientName: await decryptText(dek, namedRow.patientName) };
				} catch {
					// Locked name stays an envelope → opaque rendering.
				}
			}
		}
		out.push(next);
	}
	return out;
}

/** Decrypt one row — detail pages. null when locked or unreadable. */
export async function decryptConsultation<R extends { readonly id: number }>(
	keyring: KeyringService,
	api: DekEnvelopesApi,
	row: R,
): Promise<R | null> {
	if (!isCipheredConsultation(row as { readonly anamnesis?: string | null })) {
		// decryptConsultations yields one out-row per input — [0] is
		// always defined; the ?? is for the noUncheckedIndexedAccess type.
		/* v8 ignore next 2 */
		return (await decryptConsultations(keyring, api, [row]))[0] ?? null;
	}
	const [decrypted] = await decryptConsultations(keyring, api, [row]);
	return decrypted !== undefined &&
		!isCipheredConsultation(decrypted as { anamnesis?: string | null })
		? decrypted
		: null;
}

/**
 * Encrypt the clinical fields of a save/attach payload: `transcript`
 * and the serialized anamnesis become envelopes under the record DEK.
 * The anamnesis arrives as a parsed document — canonical JSON on the
 * wire, which is exactly the payload `signAnamnesis` hashes.
 */
export async function encryptConsultationDraft(
	dek: CryptoKey,
	draft: { readonly transcript: string; readonly anamnesis: Anamnesis },
): Promise<{ readonly transcript: string; readonly anamnesis: string }> {
	const encrypted = await consultationZk.encryptFields(dek, {
		transcript: draft.transcript,
		anamnesis: draft.anamnesis,
	});
	return {
		transcript: encrypted.transcript as string,
		anamnesis: encrypted.anamnesis as string,
	};
}

/** Encrypt only the anamnesis column — the attach/update path, which
 * never rewrites the stored transcript. */
export async function encryptAnamnesis(dek: CryptoKey, anamnesis: Anamnesis): Promise<string> {
	return (await consultationZk.encryptFields(dek, { anamnesis })).anamnesis as string;
}

/**
 * Fresh per-consultation DEK plus the grant list to persist: wrapped
 * to every APPROVED clinic device (the creating device's own envelope
 * comes from `mintDek`, the rest from `wrapKeyFor`) — same topology
 * as newPatientDek (T-144).
 */
export const newConsultationDek = (
	keyring: KeyringService,
	api: ConsultationZkApi,
): Promise<{ readonly dek: CryptoKey; readonly grants: GrantInput[] }> =>
	consultationZk.newDek(keyring, api);

/** The caller's DEK for an existing consultation — null when not a reader. */
export const consultationDek = (
	keyring: KeyringService,
	api: ConsultationZkApi,
	consultationId: number,
): Promise<CryptoKey | null> => consultationZk.dekFor(keyring, api, consultationId);

/**
 * Client-signed version entry (T-145): the canonical-JSON content hash
 * of the anamnesis document plus this device's ECDSA signature — what
 * `record_versions.content_hash`/`signature` persist for ZK tenants.
 */
export async function signAnamnesis(
	keyring: KeyringService,
	anamnesis: Anamnesis,
): Promise<{ readonly contentHash: string; readonly signature: string }> {
	const hash = await contentHash(anamnesis);
	return { contentHash: hash, signature: await keyring.signHash(hash) };
}

/**
 * Client-side extraction for ZK tenants (T-145/T-146): the transcript
 * never leaves the device as plaintext for KTB — when the clinic
 * configured BYOK, `extractor` posts it to the clinic's own provider
 * directly; the deterministic heuristic is the zero-config fallback.
 * A failing BYOK call degrades to the heuristic with the same
 * `!fallback` engine marker the server pipeline uses.
 */
export async function extractAnamnesisZk(
	transcript: string,
	extractor?: AnamnesisExtractor,
): Promise<{ readonly anamnesis: Anamnesis; readonly engine: string }> {
	if (extractor !== undefined) {
		try {
			return { anamnesis: await extractor.extract(transcript), engine: extractor.name };
		} catch {
			const engine = new HeuristicExtractor();
			return {
				anamnesis: await engine.extract(transcript),
				engine: `${extractor.name}!fallback`,
			};
		}
	}
	const engine = new HeuristicExtractor();
	return { anamnesis: await engine.extract(transcript), engine: engine.name };
}
