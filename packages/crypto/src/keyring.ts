import * as Context from "effect/Context";

import { generateDek } from "./aead.ts";
import { exportSignPublicKey, sign } from "./sign.ts";
import { exportWrapPublicKey, importWrapPublicKey, unwrapDek, wrapDek } from "./wrap.ts";

/**
 * Client vault (PL-007 F2, T-141): the browser-side key hierarchy.
 *
 * - **Device identity** — a non-extractable ECDH P-256 wrap pair plus a
 *   non-extractable ECDSA P-256 sign pair generated per browser and
 *   persisted as CryptoKey objects in IndexedDB (structured clone keeps
 *   them opaque — the raw key material never leaves `crypto.subtle`).
 * - **Key unwrap** — `w1.` envelopes (master key wrapped to this
 *   device's pubkey, per-record DEKs likewise) unwrap through the
 *   device private key and are cached for the session.
 * - **Device signing** — `signHash` produces the ECDSA signature that
 *   fills `record_versions.signature` for ZK tenants.
 */

/** The persisted device identity — CryptoKeys survive structured clone,
 * which is what lets IndexedDB hold them without ever exporting bytes. */
export interface DeviceIdentity {
	readonly wrap: CryptoKeyPair;
	readonly sign: CryptoKeyPair;
}

/** Storage seam — IndexedDB in the browser, memoryMap in tests/SSR. */
export interface DeviceStore {
	readonly load: () => Promise<DeviceIdentity | null>;
	readonly save: (identity: DeviceIdentity) => Promise<void>;
}

const IDB_NAME = "ktb-keyring";
const IDB_STORE = "device";
const IDB_KEY = "identity";

const request = <T>(req: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexeddb request failed"));
	});

/** IndexedDB-backed device store — browsers only; callers pick
 * `memoryStore` when `indexedDB` is unavailable. */
export const idbStore = (dbName = IDB_NAME): DeviceStore => ({
	async load() {
		const db = await openDb(dbName);
		try {
			const tx = db.transaction(IDB_STORE, "readonly");
			const row = await request(tx.objectStore(IDB_STORE).get(IDB_KEY));
			return (row as DeviceIdentity | undefined) ?? null;
		} finally {
			db.close();
		}
	},
	async save(identity) {
		const db = await openDb(dbName);
		try {
			const tx = db.transaction(IDB_STORE, "readwrite");
			await request(tx.objectStore(IDB_STORE).put(identity, IDB_KEY));
		} finally {
			db.close();
		}
	},
});

const openDb = (dbName: string): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		const req = indexedDB.open(dbName, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexeddb open failed"));
	});

/** Volatile store for tests, SSR and the crypto-stub vault. */
export const memoryStore = (): DeviceStore => {
	let saved: DeviceIdentity | null = null;
	return {
		load: async () => saved,
		save: async (identity) => {
			saved = identity;
		},
	};
};

/** Auto-select: IndexedDB when present (browser), memory otherwise. */
const defaultStore = (): DeviceStore =>
	typeof indexedDB === "undefined" ? memoryStore() : idbStore();

/** Generate the device identity — both PRIVATE keys non-extractable
 * (WebCrypto keeps public keys exportable regardless of the flag). */
const generateIdentity = async (): Promise<DeviceIdentity> => ({
	wrap: await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
		"deriveBits",
	]),
	sign: await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
		"verify",
	]),
});

/**
 * The keyring service shape (also the `Keyring` port's contract):
 * device identity management, session-cached `w1` unwrapping, DEK
 * minting/wrapping for grants, and device-side hash signing.
 */
export interface KeyringService {
	/**
	 * Ensure the device identity exists (generate+persist on first
	 * call) and return the publishable public keys, b64url raw P-256.
	 * `wrapPublicKey` is what clinic membership wraps keys TO;
	 * `signPublicKey` is what verifies client-signed versions.
	 */
	readonly deviceKeys: () => Promise<{
		readonly wrapPublicKey: string;
		readonly signPublicKey: string;
	}>;
	/**
	 * Unwrap a `w1.` envelope addressed to this device — the clinic
	 * master key and per-record DEKs share this path; results are
	 * cached per session so a record decrypts its DEK once.
	 */
	readonly unwrapKey: (envelope: string) => Promise<CryptoKey>;
	/** Mint a fresh DEK and wrap it for a recipient pubkey (record
	 * creation, `vault.grantAccess`). Returns `[dek, envelope]`. */
	readonly mintDek: (recipientPublicKey: string) => Promise<{
		readonly dek: CryptoKey;
		readonly envelope: string;
	}>;
	/** Wrap an existing DEK for another reader's pubkey (grants). */
	readonly wrapKeyFor: (dek: CryptoKey, recipientPublicKey: string) => Promise<string>;
	/** ECDSA over a content hash hex — device-bound version signing. */
	readonly signHash: (contentHashHex: string) => Promise<string>;
	/** Drop the session caches (identity stays persisted). */
	readonly clearSession: () => void;
}

/**
 * Build a keyring bound to `store` (default: IndexedDB when available,
 * in-memory otherwise). Identity creation is lazy + deduplicated — a
 * single keyring instance shares one device across all callers.
 */
export const makeKeyring = (options: { readonly store?: DeviceStore } = {}): KeyringService => {
	const store = options.store ?? defaultStore();
	let identityPromise: Promise<DeviceIdentity> | null = null;
	const cache = new Map<string, CryptoKey>();

	const identity = (): Promise<DeviceIdentity> => {
		identityPromise ??= (async () => {
			const stored = await store.load();
			if (stored !== null) return stored;
			const fresh = await generateIdentity();
			await store.save(fresh);
			return fresh;
		})();
		return identityPromise;
	};

	return {
		deviceKeys: async () => {
			const id = await identity();
			const [wrapPublicKey, signPublicKey] = await Promise.all([
				exportWrapPublicKey(id.wrap.publicKey),
				exportSignPublicKey(id.sign.publicKey),
			]);
			return { wrapPublicKey, signPublicKey };
		},
		unwrapKey: (envelope) => {
			const cached = cache.get(envelope);
			if (cached !== undefined) return Promise.resolve(cached);
			return identity()
				.then((id) => unwrapDek(envelope, id.wrap.privateKey))
				.then((dek) => {
					cache.set(envelope, dek);
					return dek;
				});
		},
		mintDek: async (recipientPublicKey) => {
			const dek = await generateDek();
			const envelope = await wrapDek(dek, await importWrapPublicKey(recipientPublicKey));
			return { dek, envelope };
		},
		wrapKeyFor: async (dek, recipientPublicKey) =>
			wrapDek(dek, await importWrapPublicKey(recipientPublicKey)),
		signHash: async (contentHashHex) => sign((await identity()).sign.privateKey, contentHashHex),
		clearSession: () => cache.clear(),
	};
};

/**
 * Keyring port (T-141): the client vault as an Effect service so panel
 * loaders and view code `yield*` it like any other port. The real impl
 * is `makeKeyring` (IndexedDB); `@ktb/crypto-stub` binds the memory
 * variant for non-ZK tenants and tests.
 */
export class Keyring extends Context.Service<Keyring, KeyringService>()("@ktb/crypto/Keyring") {}
