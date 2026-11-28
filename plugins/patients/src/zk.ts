import type { KeyringService } from "@ktb/crypto/keyring";
import { isEnvelope, makeEntityZk } from "@ktb/crypto/zk";
import type { DekEnvelopesApi, DeviceInfo, EntityZkApi, GrantInput } from "@ktb/crypto/zk";

import { patientCipher } from "./cipher.ts";
import { TEXT_FIELDS, type PatientDraft, type TextField } from "./record.ts";

/**
 * Client-side patient cipher orchestration (PL-007 F3, T-144): under a
 * ZK tenant, PII fields are AES-256-GCM envelopes (`v1.<iv>.<ct>`) keyed
 * by a per-patient DEK that `entity_deks` holds wrapped to each
 * authorized device pubkey. The server stores and validates shape only —
 * wrapping, encryption and decryption all happen in the browser.
 *
 * The shared machinery lives in `@ktb/crypto/zk` (`makeEntityZk`) —
 * this module binds the patient cipher spec and keeps the patient-named
 * surface views/tests import. `PatientZkApi` is the view-facing server
 * surface (wired in ./apis.ts to the vault fns) — kept small so
 * views/tests can fake it.
 */
export const PATIENT_ENTITY_TYPE = patientCipher.entity;

export type { DekEnvelopesApi, DeviceInfo, GrantInput };
export { isEnvelope };

/** Same contract as the shared `EntityZkApi` — devices, batched
 * own-envelope lookup and grant writes, all bound-tenant scoped inside
 * the vault fns. */
export type PatientZkApi = EntityZkApi;

/** `{keyring, api}` bundle threaded through views under ZK. */
export interface PatientZk {
	readonly keyring: KeyringService;
	readonly api: PatientZkApi;
}

const patientZk = makeEntityZk({
	entityType: PATIENT_ENTITY_TYPE,
	cipher: patientCipher,
	fields: TEXT_FIELDS,
	// Patient drafts treat "" and non-strings as absent (null), never
	// ciphertext — the wire shape stays stable across edits.
	normalizeField: (value) => (typeof value === "string" && value !== "" ? value : null),
});

/** A row is ciphertext when its `name` column carries an envelope. */
export const isCipheredPatient = (p: { readonly name?: string | null }): boolean =>
	isEnvelope(p.name);

/**
 * Decrypt every ciphered row: one batched envelope lookup, one DEK
 * unwrap + `decryptRow` each. Rows without a grant — or with
 * undecryptable envelopes — come back unchanged so views can render a
 * locked state instead of dropping records.
 */
export const decryptPatients = <R extends { readonly id: number }>(
	keyring: KeyringService,
	api: DekEnvelopesApi,
	rows: readonly R[],
): Promise<R[]> =>
	patientZk.decryptRows(keyring, api, rows, {
		isCiphered: (row) => isCipheredPatient(row as { readonly name?: string | null }),
	});

/** Decrypt one row — detail/edit pages. null when locked or unreadable. */
export const decryptPatient = <R extends { readonly id: number }>(
	keyring: KeyringService,
	api: DekEnvelopesApi,
	row: R,
): Promise<R | null> =>
	patientZk.decryptRow(keyring, api, row, {
		isCiphered: (r) => isCipheredPatient(r as { readonly name?: string | null }),
	});

/**
 * Encrypt a validated plaintext draft into the wire shape: every
 * TEXT_FIELD becomes an envelope (or stays null). `active` and the
 * `ciphered` marker stay plaintext — the fn asserts envelope shape.
 */
export async function encryptPatientDraft(
	dek: CryptoKey,
	draft: PatientDraft,
): Promise<PatientDraft & { readonly ciphered: true }> {
	const encrypted = await patientZk.encryptFields(dek, draft);
	const out = {} as Record<TextField, string | null>;
	for (const key of TEXT_FIELDS) out[key] = encrypted[key] ?? null;
	return { ...out, active: draft.active, ciphered: true };
}

/**
 * Fresh per-patient DEK plus the grant list to persist: wrapped to
 * every APPROVED clinic device (pending devices gain access when
 * admins re-wrap — T-150) — the creating device's own envelope comes
 * from `mintDek`, the rest from `wrapKeyFor`.
 */
export const newPatientDek = (
	keyring: KeyringService,
	api: PatientZkApi,
): Promise<{ readonly dek: CryptoKey; readonly grants: GrantInput[] }> =>
	patientZk.newDek(keyring, api);

/** The caller's DEK for an existing patient — null when not a reader. */
export const patientDek = (
	keyring: KeyringService,
	api: PatientZkApi,
	patientId: number,
): Promise<CryptoKey | null> => patientZk.dekFor(keyring, api, patientId);
