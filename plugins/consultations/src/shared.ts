import { Option } from "effect";
import type { Anamnesis } from "@ktb/anamnesis";
import { consultations } from "@ktb/db/schema";

export type ConsultationRow = typeof consultations.$inferSelect;

/**
 * Client-computed version entry for a ciphered write (T-145): the
 * canonical-JSON content hash of the plaintext anamnesis plus the
 * device ECDSA signature — the server cannot derive either under ZK,
 * so the wire carries them into `record_versions`.
 */
export interface SignedVersion {
	readonly contentHash?: string;
	readonly signature?: string | null;
}

export interface SaveConsultationInput {
	readonly transcript: string;
	/** Parsed document for plaintext tenants; the opaque `v1.` envelope
	 * (canonical JSON ciphertext) for ZK tenants — stored as-is. */
	readonly anamnesis: Anamnesis | string;
	readonly engine: string;
	readonly patientId?: number;
	/** Client-signed version — required when `anamnesis` is an envelope. */
	readonly version?: SignedVersion;
}

export interface AttachAnamnesisInput {
	readonly consultationId: number;
	readonly anamnesis: Anamnesis | string;
	readonly engine: string;
	/** Tri-state: undefined keeps the link, null clears it, id re-links. */
	readonly patientId?: number | null;
	readonly version?: SignedVersion;
}

export interface ConsultationSummary {
	readonly id: number;
	readonly engine: string | null;
	readonly createdAt: Date;
	readonly transcript: string;
	readonly source: string;
	readonly status: string;
	readonly consentAt: Date | null;
	readonly patientId: number | null;
	readonly patientName: string | null;
	/** Raw stored `anamnesis` column — plaintext JSON for non-ZK rows, a
	 * `v1.` envelope under ZK; clients decrypt before parsing. */
	readonly anamnesis: string | null;
	readonly hasAnamnesis: boolean;
	readonly chiefComplaint: string | null;
}

export type ConsultationDetail = Omit<ConsultationRow, "anamnesis" | "review"> & {
	readonly patientName: string | null;
	readonly anamnesis: Anamnesis | null;
	/** Raw stored `anamnesis` column — a `v1.` envelope under ZK. */
	readonly anamnesisRaw: string | null;
};

/** Stored JSON columns → typed domain objects, null on any drift. */
export const parseStored = <A>(
	json: string | null,
	decode: (u: unknown) => Option.Option<A>,
): A | null => {
	if (!json) return null;
	try {
		return Option.getOrNull(decode(JSON.parse(json)));
	} catch {
		return null;
	}
};

/** The stored `anamnesis` column for a write: parsed documents are
 * canonical-serialized plaintext; ZK payloads already ARE the stored
 * value (an opaque `v1.` envelope) and pass through untouched. */
export const serializeAnamnesis = (anamnesis: Anamnesis | string): string =>
	typeof anamnesis === "string" ? anamnesis : JSON.stringify(anamnesis);
