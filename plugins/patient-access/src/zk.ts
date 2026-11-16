import type { KeyringService } from "@ktb/crypto/keyring";
import { PATIENT_ENTITY_TYPE, type GrantInput } from "@ktb/patients/zk";
import { vaultDekEnvelopesFn, vaultGrantAccessFn } from "@ktb/vault/fns";

import { portalReadersFn, type PortalReader } from "./fns.ts";

/**
 * Clinic-side portal grant pass (PL-007 F3, T-148): a consultation DEK
 * can only reach a portal device through someone who already holds it —
 * the server never sees key material, so an approved CLINIC device
 * unwraps its own envelopes and re-wraps each DEK to the registered
 * `portal_keys` pubkeys of users with an active link, persisting them
 * through the generic `vault.grantAccess` path (`readerKind "patient"`).
 *
 * The pass runs from the portal-access page — the surface where the
 * doctor already manages links — and is idempotent: re-granting the
 * same (record, reader) replaces the envelope row.
 */

// `consultationCipher.entity` duplicated on purpose: @ktb/consultations
// already depends on this plugin (apis.ts), so importing its constant
// here would cycle the package graph. Same namespacing as
// record_versions/entity_deks.
const CONSULTATION_ENTITY_TYPE = "consultation";

export type { PortalReader };

/** What the pass needs from the wire: the grant plan, own-envelope
 * reads and grant writes — all bound-tenant scoped inside the fns. */
export interface PatientAccessZkApi {
	readonly portalReaders: (patientId: number) => Promise<{
		readonly readers: readonly PortalReader[];
		readonly cipheredConsultationIds: readonly number[];
	} | null>;
	readonly dekEnvelopes: (input: {
		readonly entityType: string;
		readonly entityIds: readonly (number | string)[];
		readonly wrapPublicKey: string;
	}) => Promise<Record<string, string>>;
	readonly grant: (input: {
		readonly entityType: string;
		readonly entityId: number | string;
		readonly grants: readonly GrantInput[];
	}) => Promise<{ readonly ok: boolean }>;
}

/** Binding for the vault + patient-access fns — identical in shape to
 * the consultations/patients ZK api surfaces. */
export const patientAccessZkApi: PatientAccessZkApi = {
	portalReaders: (patientId) => portalReadersFn({ data: patientId }),
	dekEnvelopes: (input) => vaultDekEnvelopesFn({ data: input }),
	grant: async (input) => vaultGrantAccessFn({ data: input }),
};

/**
 * Wrap every record DEK this device can unwrap — the patient record
 * itself plus each ciphered consultation — to every reader's pubkey
 * and persist the envelopes. Returns how many entities were (re)granted.
 * Records this device cannot read are skipped: a locked record stays
 * locked for everyone, and the pass never fails the page that ran it.
 */
export async function grantPortalAccess(
	keyring: KeyringService,
	api: PatientAccessZkApi,
	input: {
		readonly patientId: number;
		readonly consultationIds: readonly number[];
		readonly readers: readonly PortalReader[];
	},
): Promise<number> {
	if (input.readers.length === 0) return 0;
	const { wrapPublicKey } = await keyring.deviceKeys();
	const [patientEnvelopes, consultationEnvelopes] = await Promise.all([
		api.dekEnvelopes({
			entityType: PATIENT_ENTITY_TYPE,
			entityIds: [input.patientId],
			wrapPublicKey,
		}),
		api.dekEnvelopes({
			entityType: CONSULTATION_ENTITY_TYPE,
			entityIds: input.consultationIds,
			wrapPublicKey,
		}),
	]);
	const wrapForAll = (dek: CryptoKey): Promise<GrantInput[]> =>
		Promise.all(
			input.readers.map(async (reader) => ({
				readerKind: "patient" as const,
				readerPubkey: reader.wrapPublicKey,
				readerId: reader.readerId,
				wrappedDek: await keyring.wrapKeyFor(dek, reader.wrapPublicKey),
			})),
		);
	const grant = async (entityType: string, entityId: number, envelope: string) => {
		const dek = await keyring.unwrapKey(envelope);
		const res = await api.grant({
			entityType,
			entityId,
			grants: await wrapForAll(dek),
		});
		return res.ok;
	};
	let granted = 0;
	const patientEnvelope = patientEnvelopes[String(input.patientId)];
	if (patientEnvelope !== undefined) {
		try {
			if (await grant(PATIENT_ENTITY_TYPE, input.patientId, patientEnvelope)) granted += 1;
		} catch {
			// Undecryptable envelope — this device cannot help, skip.
		}
	}
	for (const consultationId of input.consultationIds) {
		const envelope = consultationEnvelopes[String(consultationId)];
		if (envelope === undefined) continue;
		try {
			if (await grant(CONSULTATION_ENTITY_TYPE, consultationId, envelope)) granted += 1;
		} catch {
			// Undecryptable envelope — this device cannot help, skip.
		}
	}
	return granted;
}
