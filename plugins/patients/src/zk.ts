import { decryptRow, encryptRow } from "@ktb/crypto/cipher";
import { AEAD_ENVELOPE_VERSION } from "@ktb/crypto/aead";
import type { KeyringService } from "@ktb/crypto/keyring";

import { patientCipher } from "./cipher.ts";
import type { Patient } from "./index.ts";
import { TEXT_FIELDS, type PatientDraft, type TextField } from "./record.ts";

/**
 * Client-side patient cipher orchestration (PL-007 F3, T-144): under a
 * ZK tenant, PII fields are AES-256-GCM envelopes (`v1.<iv>.<ct>`) keyed
 * by a per-patient DEK that `entity_deks` holds wrapped to each
 * authorized device pubkey. The server stores and validates shape only —
 * wrapping, encryption and decryption all happen in the browser.
 *
 * `PatientZkApi` is the view-facing server surface (wired in ./apis.ts
 * to the vault fns) — kept small so views/tests can fake it.
 */
export const PATIENT_ENTITY_TYPE = patientCipher.entity;

export interface DeviceInfo {
	readonly wrapPublicKey: string;
	readonly status: string;
}

export interface GrantInput {
	readonly readerKind: "device" | "patient";
	readonly readerPubkey: string;
	readonly readerId?: string | null;
	readonly wrappedDek: string;
}

export interface PatientZkApi {
	/** Approved + pending member devices of the bound tenant. */
	readonly devices: () => Promise<readonly DeviceInfo[]>;
	/** Caller's wrapped DEKs for a batch of records, keyed by id —
	 * records without a grant are absent. */
	readonly dekEnvelopes: (input: {
		readonly entityType: string;
		readonly entityIds: readonly (number | string)[];
		readonly wrapPublicKey: string;
	}) => Promise<Record<string, string>>;
	/** Store wrapped DEK envelopes for a record. */
	readonly grant: (input: {
		readonly entityType: string;
		readonly entityId: number | string;
		readonly grants: readonly GrantInput[];
	}) => Promise<{ readonly ok: boolean }>;
}

/** `{keyring, api}` bundle threaded through views under ZK. */
export interface PatientZk {
	readonly keyring: KeyringService;
	readonly api: PatientZkApi;
}

/** `v1.` AEAD envelope marker — how callers detect ciphertext values. */
export const isEnvelope = (value: unknown): value is string =>
	typeof value === "string" && value.startsWith(`${AEAD_ENVELOPE_VERSION}.`);

/** A row is ciphertext when its `name` column carries an envelope. */
export const isCipheredPatient = (p: { readonly name?: string | null }): boolean =>
	isEnvelope(p.name);

/**
 * Decrypt every ciphered row: one batched envelope lookup, one DEK
 * unwrap + `decryptRow` each. Rows without a grant — or with
 * undecryptable envelopes — come back unchanged so views can render a
 * locked state instead of dropping records.
 */
export async function decryptPatients<R extends { readonly id: number }>(
	keyring: KeyringService,
	api: PatientZkApi,
	rows: readonly R[],
): Promise<R[]> {
	const ciphered = rows.filter((r) => isCipheredPatient(r as { readonly name?: string | null }));
	if (ciphered.length === 0) return [...rows];
	const { wrapPublicKey } = await keyring.deviceKeys();
	const envelopes = await api.dekEnvelopes({
		entityType: PATIENT_ENTITY_TYPE,
		entityIds: ciphered.map((r) => r.id),
		wrapPublicKey,
	});
	const out: R[] = [];
	for (const row of rows) {
		const envelope = envelopes[String(row.id)];
		if (!isCipheredPatient(row as { readonly name?: string | null }) || envelope === undefined) {
			out.push(row);
			continue;
		}
		try {
			const dek = await keyring.unwrapKey(envelope);
			out.push({ ...row, ...(await decryptRow(patientCipher, dek, row)) });
		} catch {
			out.push(row);
		}
	}
	return out;
}

/** Decrypt one row — detail/edit pages. null when locked or unreadable. */
export async function decryptPatient<R extends { readonly id: number }>(
	keyring: KeyringService,
	api: PatientZkApi,
	row: R,
): Promise<R | null> {
	if (!isCipheredPatient(row as { readonly name?: string | null })) return row;
	const [decrypted] = await decryptPatients(keyring, api, [row]);
	return decrypted !== undefined && !isCipheredPatient(decrypted as { name?: string | null })
		? decrypted
		: null;
}

/**
 * Encrypt a validated plaintext draft into the wire shape: every
 * TEXT_FIELD becomes an envelope (or stays null). `active` and the
 * `ciphered` marker stay plaintext — the fn asserts envelope shape.
 */
export async function encryptPatientDraft(
	dek: CryptoKey,
	draft: PatientDraft,
): Promise<PatientDraft & { readonly ciphered: true }> {
	const row: Record<string, unknown> = {};
	for (const key of TEXT_FIELDS) {
		const value = draft[key];
		row[key] = typeof value === "string" && value !== "" ? value : null;
	}
	const encrypted = await encryptRow(patientCipher, dek, row);
	const out = {} as Record<TextField, string | null>;
	for (const key of TEXT_FIELDS) out[key] = (encrypted[key] as string | null) ?? null;
	return { ...out, active: draft.active, ciphered: true };
}

/**
 * Fresh per-patient DEK plus the grant list to persist: wrapped to
 * every APPROVED clinic device (pending devices gain access when
 * admins re-wrap — T-150) — the creating device's own envelope comes
 * from `mintDek`, the rest from `wrapKeyFor`.
 */
export async function newPatientDek(
	keyring: KeyringService,
	api: PatientZkApi,
): Promise<{ readonly dek: CryptoKey; readonly grants: GrantInput[] }> {
	const { wrapPublicKey } = await keyring.deviceKeys();
	const devices = await api.devices();
	const approved = devices.filter((d) => d.status === "approved");
	const readers = new Set<string>([wrapPublicKey, ...approved.map((d) => d.wrapPublicKey)]);
	const { dek, envelope } = await keyring.mintDek(wrapPublicKey);
	const grants: GrantInput[] = [];
	for (const pubkey of readers) {
		grants.push({
			readerKind: "device",
			readerPubkey: pubkey,
			wrappedDek: pubkey === wrapPublicKey ? envelope : await keyring.wrapKeyFor(dek, pubkey),
		});
	}
	return { dek, grants };
}

/** The caller's DEK for an existing patient — null when not a reader. */
export async function patientDek(
	keyring: KeyringService,
	api: PatientZkApi,
	patientId: number,
): Promise<CryptoKey | null> {
	const { wrapPublicKey } = await keyring.deviceKeys();
	const envelopes = await api.dekEnvelopes({
		entityType: PATIENT_ENTITY_TYPE,
		entityIds: [patientId],
		wrapPublicKey,
	});
	const envelope = envelopes[String(patientId)];
	return envelope === undefined ? null : keyring.unwrapKey(envelope);
}
