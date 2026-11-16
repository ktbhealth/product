import { decryptText } from "@ktb/crypto/aead";
import type { KeyringService } from "@ktb/crypto/keyring";
import { decryptConsultations } from "@ktb/consultations/zk";
import { isEnvelope, PATIENT_ENTITY_TYPE } from "@ktb/patients/zk";

import { portalDekEnvelopesFn, portalRegisterDeviceFn } from "./fns.ts";
import { parseAnamnesis, portalSections, written } from "./sections.ts";
import type { PortalConsultation, PortalConsultationSummary } from "./index.ts";

/**
 * Client-side portal decryption (PL-007 F3, T-148): a ZK tenant's
 * portal rows arrive as `v1.` envelopes keyed by per-record DEKs that
 * `entity_deks` holds wrapped (`w1.` envelopes) to the portal user's
 * registered device pubkeys (`portal_keys`). The browser unwraps the
 * DEK with its non-extractable device key and decrypts the record —
 * the same `decryptConsultations` pipeline the doctor side uses.
 *
 * The surface is read-only: portal users fetch their own envelopes and
 * publish device keys; grants are always WRITTEN by a clinic device
 * (`vault.grantAccess` needs tenant membership, which a portal user
 * never holds).
 */

export { isEnvelope };

/** The portal's ZK server surface — own-envelope reads + device
 * registration. Structurally compatible with `PatientZkApi`'s
 * `dekEnvelopes`, which is all the shared decrypt helpers consume. */
export interface PortalZkApi {
	readonly dekEnvelopes: (input: {
		readonly entityType: string;
		readonly entityIds: readonly (number | string)[];
		readonly wrapPublicKey: string;
	}) => Promise<Record<string, string>>;
	readonly registerDevice: (input: {
		readonly wrapPublicKey: string;
		readonly signPublicKey: string;
	}) => Promise<{ readonly ok: boolean }>;
}

/** View-facing binding for the portal fns — the wire narrows
 * `entityType` to the two entity kinds the portal reads. */
export const portalZkApi: PortalZkApi = {
	dekEnvelopes: (input) =>
		portalDekEnvelopesFn({
			data: { ...input, entityType: input.entityType as "patient" | "consultation" },
		}),
	registerDevice: async (input) => {
		const res = await portalRegisterDeviceFn({ data: input });
		return { ok: res.ok };
	},
};

/**
 * Publish this device's pubkeys — called once per portal visit so an
 * approved clinic device can wrap DEKs to them. Fire-and-forget: a
 * failed registration only means grants cannot reach this device yet.
 */
export const registerPortalDevice = async (keyring: KeyringService): Promise<void> => {
	try {
		const keys = await keyring.deviceKeys();
		await portalZkApi.registerDevice(keys);
	} catch {
		// Registration is best-effort — the read path below never
		// depends on it having succeeded this session.
	}
};

/**
 * A portal consultation row → the decrypted view model: unwrap the
 * record DEK, decrypt the anamnesis envelope and the joined patient
 * name, then derive the same section list the server builds for
 * plaintext rows. A device without a grant gets the row back
 * unchanged (still ciphered) — the view renders the locked state,
 * never a crash.
 */
export async function decryptPortalConsultation(
	keyring: KeyringService,
	api: PortalZkApi,
	consultation: PortalConsultation,
): Promise<PortalConsultation> {
	if (!isEnvelope(consultation.anamnesis) && !isEnvelope(consultation.patientName)) {
		return consultation;
	}
	const [row] = await decryptConsultations(keyring, api, [consultation]);
	/* v8 ignore next -- decryptConsultations preserves the row count */
	if (row === undefined) return consultation;
	// Still ciphered → locked state (the patient name may already have
	// decrypted — keep whatever the row decrypted to).
	if (isEnvelope(row.anamnesis)) return row;
	const parsed = parseAnamnesis(row.anamnesis);
	return { ...row, sections: parsed === null ? [] : portalSections(parsed), anamnesis: null };
}

/**
 * Portal list rows: decrypt each ciphered `anamnesis` and fill the
 * chief complaint the server cannot read. Locked rows keep their
 * envelope and a null complaint — the list renders the untitled label.
 */
export async function decryptPortalSummaries(
	keyring: KeyringService,
	api: PortalZkApi,
	rows: readonly PortalConsultationSummary[],
): Promise<PortalConsultationSummary[]> {
	if (!rows.some((r) => isEnvelope(r.anamnesis))) return [...rows];
	const decrypted = await decryptConsultations(keyring, api, rows);
	return decrypted.map((row) => {
		if (isEnvelope(row.anamnesis)) return row;
		const parsed = parseAnamnesis(row.anamnesis);
		return {
			...row,
			anamnesis: null,
			chiefComplaint: parsed === null ? null : written(parsed.queixa_principal.content),
		};
	});
}

/**
 * Patient-record names on portal data (profiles, the open record):
 * `patients.name` is an envelope under the patient DEK — the same DEK
 * the grant pass wraps to the portal device for `entityType "patient"`.
 * Rows without a grant keep their envelope; the caller renders the
 * locked label for it.
 */
export async function decryptPortalProfiles<
	R extends {
		readonly patientId: number;
		readonly name: string;
	},
>(keyring: KeyringService, api: PortalZkApi, rows: readonly R[]): Promise<R[]> {
	const ciphered = rows.filter((r) => isEnvelope(r.name));
	if (ciphered.length === 0) return [...rows];
	const { wrapPublicKey } = await keyring.deviceKeys();
	const envelopes = await api.dekEnvelopes({
		entityType: PATIENT_ENTITY_TYPE,
		entityIds: [...new Set(ciphered.map((r) => r.patientId))],
		wrapPublicKey,
	});
	const deks = new Map<number, CryptoKey | null>();
	const dekFor = async (patientId: number): Promise<CryptoKey | null> => {
		if (deks.has(patientId)) return deks.get(patientId)!;
		const envelope = envelopes[String(patientId)];
		let dek: CryptoKey | null = null;
		if (envelope !== undefined) {
			try {
				dek = await keyring.unwrapKey(envelope);
			} catch {
				// Undecryptable envelope → treated as no grant.
			}
		}
		deks.set(patientId, dek);
		return dek;
	};
	const out: R[] = [];
	for (const row of rows) {
		if (!isEnvelope(row.name)) {
			out.push(row);
			continue;
		}
		const dek = await dekFor(row.patientId);
		if (dek === null) {
			out.push(row);
			continue;
		}
		try {
			out.push({ ...row, name: await decryptText(dek, row.name) });
		} catch {
			out.push(row);
		}
	}
	return out;
}
