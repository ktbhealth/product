import { AEAD_ENVELOPE_VERSION } from "./aead.ts";
import { decryptRow, encryptRow, type CipherRow, type CipherSpec } from "./cipher.ts";
import { CryptoFormatError } from "./encoding.ts";
import type { KeyringService } from "./keyring.ts";

/**
 * Entity ZK kit (PL-007 F3): the client-side orchestration every
 * ciphered entity plugin shares. Under a ZK tenant, record fields are
 * AES-256-GCM envelopes (`v1.<iv>.<ct>`) keyed by a per-record DEK that
 * `entity_deks` holds wrapped (`w1.` envelopes) to each authorized
 * device pubkey. The server stores and validates shape only — wrapping,
 * encryption and decryption all happen in the browser.
 *
 * `makeEntityZk({ entityType, cipher, fields })` binds one entity's
 * cipher spec to the shared api surface (`EntityZkApi` — devices,
 * batched own-envelope reads, grant writes; `entityType` travels on
 * every call so one vault fn set serves every entity) and returns the
 * kit: field encryption, batch decryption, DEK mint/unwrap helpers.
 * Plugins keep only their entity declaration plus genuinely
 * entity-specific orchestration (joined-row decrypts, draft shaping).
 *
 * Wire formats and crypto semantics are the plugin twins' — this kit
 * is a pure extraction, not a redesign.
 */

/** An approved/pending member device as the vault `devices` fn lists it. */
export interface DeviceInfo {
	readonly wrapPublicKey: string;
	readonly status: string;
}

/** One wrapped-DEK grant row persisted through `vault.grantAccess`. */
export interface GrantInput {
	readonly readerKind: "device" | "patient";
	readonly readerPubkey: string;
	readonly readerId?: string | null;
	readonly wrappedDek: string;
}

/**
 * The view-facing server surface every entity plugin wires to the same
 * vault fns — kept small so views/tests can fake it.
 */
export interface EntityZkApi {
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

/**
 * The minimal surface the decrypt paths need — they never list devices
 * or write grants, so readers that can only FETCH their own envelopes
 * (the patient portal) reuse them through this narrower shape.
 */
export type DekEnvelopesApi = Pick<EntityZkApi, "dekEnvelopes">;

/** `{keyring, api}` bundle threaded through views under ZK. */
export interface EntityZkContext {
	readonly keyring: KeyringService;
	readonly api: EntityZkApi;
}

/** `v1.` AEAD envelope marker — how callers detect ciphertext values. */
export const isEnvelope = (value: unknown): value is string =>
	typeof value === "string" && value.startsWith(`${AEAD_ENVELOPE_VERSION}.`);

/** Per-entity kit configuration. */
export interface EntityZkConfig<F extends string = string> {
	/**
	 * ZK entity discriminator sent on `dekEnvelopes`/`grant` calls —
	 * must equal `cipher.entity` (the spec's own entity name is the
	 * same key material; a drift would silently split the DEK space).
	 */
	readonly entityType: string;
	/** The entity's cipher spec — row codec + field classification. */
	readonly cipher: CipherSpec<F>;
	/**
	 * The client-writable ciphered fields — the columns a draft/patch
	 * may carry. Must be a subset of `cipher.fields`; read-side columns
	 * the server or other writers own (e.g. ASR transcripts) stay out.
	 */
	readonly fields: readonly F[];
	/**
	 * Optional per-field draft normalization applied before encryption
	 * (default: pass the value through — `encryptRow` already maps
	 * null/undefined to null and canonicalizes non-strings). Patients
	 * uses it to treat "" and non-strings as absent (null) rather than
	 * ciphertext; entities whose empty string is content omit it.
	 */
	readonly normalizeField?: (value: unknown) => unknown;
}

/** Row predicate + optional cipher-row projection for `decryptRows`. */
export interface EntityZkDecryptOptions<R> {
	/** Whether a row carries this entity's ciphertext. */
	readonly isCiphered: (row: R) => boolean;
	/**
	 * Project a view row down to the keys the cipher spec declares
	 * before `decryptRow` (which fails closed on undeclared keys).
	 * Default: the row itself — read models whose every key is
	 * spec-declared decrypt directly.
	 */
	readonly specRow?: (row: R) => CipherRow;
}

/** The bound per-entity kit `makeEntityZk` returns. */
export interface EntityZkKit<F extends string = string> {
	readonly entityType: string;
	readonly cipher: CipherSpec<F>;
	readonly fields: readonly F[];

	/**
	 * Encrypt a draft into wire shape: every configured `fields` key
	 * becomes an envelope (or null) via `encryptRow`. Keys absent from
	 * `values` still emit null — the wire shape is stable.
	 */
	readonly encryptFields: (
		dek: CryptoKey,
		values: { readonly [K in F]?: unknown },
	) => Promise<Record<F, string | null>>;

	/**
	 * Decrypt every ciphered row of this entity: one batched envelope
	 * lookup, one DEK unwrap + `decryptRow` each. Rows without a grant —
	 * or with undecryptable envelopes — come back unchanged so views can
	 * render a locked state instead of dropping records.
	 */
	readonly decryptRows: <R extends { readonly id: number | string }>(
		keyring: KeyringService,
		api: DekEnvelopesApi,
		rows: readonly R[],
		options: EntityZkDecryptOptions<R>,
	) => Promise<R[]>;

	/** Decrypt one row — detail/edit pages. null when locked or unreadable. */
	readonly decryptRow: <R extends { readonly id: number | string }>(
		keyring: KeyringService,
		api: DekEnvelopesApi,
		row: R,
		options: EntityZkDecryptOptions<R>,
	) => Promise<R | null>;

	/**
	 * Fresh per-record DEK plus the grant list to persist: wrapped to
	 * every APPROVED clinic device (pending devices gain access when
	 * admins re-wrap) — the creating device's own envelope comes from
	 * `mintDek`, the rest from `wrapKeyFor`. The array is mutable so
	 * callers can append further readers (e.g. portal devices) before
	 * the grant write.
	 */
	readonly newDek: (
		keyring: KeyringService,
		api: EntityZkApi,
	) => Promise<{ readonly dek: CryptoKey; readonly grants: GrantInput[] }>;

	/** The caller's DEK for an existing record — null when not a reader. */
	readonly dekFor: (
		keyring: KeyringService,
		api: EntityZkApi,
		entityId: number | string,
	) => Promise<CryptoKey | null>;
}

/**
 * Bind an entity's cipher spec to the shared ZK orchestration. Validates
 * the declaration at module scope — a bad spec must fail at import
 * time, not mid-request (same contract as `defineCipher`).
 */
export const makeEntityZk = <F extends string>(config: EntityZkConfig<F>): EntityZkKit<F> => {
	if (typeof config.entityType !== "string" || config.entityType.trim() === "") {
		throw new CryptoFormatError("entity zk entityType must be a non-empty string");
	}
	if (config.entityType !== config.cipher.entity) {
		throw new CryptoFormatError(
			`entity zk: entityType "${config.entityType}" must equal cipher.entity "${config.cipher.entity}"`,
		);
	}
	for (const field of config.fields) {
		if (!config.cipher.fields.includes(field)) {
			throw new CryptoFormatError(
				`entity zk ${config.entityType}: field "${field}" is not a ciphered field of the spec`,
			);
		}
	}
	const normalize = config.normalizeField ?? ((value: unknown) => value);

	const kit: EntityZkKit<F> = {
		entityType: config.entityType,
		cipher: config.cipher,
		fields: config.fields,

		encryptFields: async (dek, values) => {
			const row: CipherRow = {};
			for (const key of config.fields) row[key] = normalize(values[key]);
			const encrypted = await encryptRow(config.cipher, dek, row);
			const out = {} as Record<F, string | null>;
			for (const key of config.fields) {
				out[key] = (encrypted[key] as string | null | undefined) ?? null;
			}
			return out;
		},

		decryptRows: async <R extends { readonly id: number | string }>(
			keyring: KeyringService,
			api: DekEnvelopesApi,
			rows: readonly R[],
			options: EntityZkDecryptOptions<R>,
		) => {
			const ciphered = rows.filter((row) => options.isCiphered(row));
			if (ciphered.length === 0) return [...rows];
			const { wrapPublicKey } = await keyring.deviceKeys();
			const envelopes = await api.dekEnvelopes({
				entityType: config.entityType,
				entityIds: ciphered.map((row) => row.id),
				wrapPublicKey,
			});
			const out: R[] = [];
			for (const row of rows) {
				const envelope = envelopes[String(row.id)];
				if (!options.isCiphered(row) || envelope === undefined) {
					out.push(row);
					continue;
				}
				try {
					const dek = await keyring.unwrapKey(envelope);
					const specRow =
						options.specRow === undefined ? (row as unknown as CipherRow) : options.specRow(row);
					out.push({ ...row, ...(await decryptRow(config.cipher, dek, specRow)) });
				} catch {
					out.push(row);
				}
			}
			return out;
		},

		decryptRow: async (keyring, api, row, options) => {
			if (!options.isCiphered(row)) return row;
			const [decrypted] = await kit.decryptRows(keyring, api, [row], options);
			return decrypted !== undefined && !options.isCiphered(decrypted) ? decrypted : null;
		},

		newDek: async (keyring, api) => {
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
		},

		dekFor: async (keyring, api, entityId) => {
			const { wrapPublicKey } = await keyring.deviceKeys();
			const envelopes = await api.dekEnvelopes({
				entityType: config.entityType,
				entityIds: [entityId],
				wrapPublicKey,
			});
			const envelope = envelopes[String(entityId)];
			return envelope === undefined ? null : keyring.unwrapKey(envelope);
		},
	};
	return kit;
};
