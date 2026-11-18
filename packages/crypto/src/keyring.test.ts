import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	Keyring,
	makeKeyring,
	memorySecretStore,
	memoryStore,
	type DeviceIdentity,
	type SealedSecret,
} from "./keyring.ts";
import { importSignPublicKey, verify } from "./sign.ts";
import { exportWrapPublicKey, generateWrapKeyPair, unwrapDek } from "./wrap.ts";

describe("makeKeyring (memory store)", () => {
	it("generates and persists a device identity, reusing it across calls", async () => {
		const saved: DeviceIdentity[] = [];
		const store = {
			load: async () => null,
			save: async (id: DeviceIdentity) => {
				saved.push(id);
			},
		};
		const keyring = makeKeyring({ store });
		const a = await keyring.deviceKeys();
		const b = await keyring.deviceKeys();
		expect(saved).toHaveLength(1);
		expect(a).toEqual(b);
		expect(a.wrapPublicKey).toBeTruthy();
		expect(a.signPublicKey).toBeTruthy();
		// Non-extractable privates, exportable publics.
		expect(saved[0]!.wrap.privateKey.extractable).toBe(false);
		expect(saved[0]!.sign.privateKey.extractable).toBe(false);
		expect(saved[0]!.wrap.publicKey.extractable).toBe(true);
	});

	it("loads a persisted identity instead of regenerating", async () => {
		const store = memoryStore();
		const first = makeKeyring({ store });
		const keys = await first.deviceKeys();
		// A second keyring over the same store sees the same device.
		const second = makeKeyring({ store });
		expect(await second.deviceKeys()).toEqual(keys);
	});

	it("unwraps w1 envelopes addressed to the device and caches them", async () => {
		const keyring = makeKeyring({ store: memoryStore() });
		const { wrapPublicKey } = await keyring.deviceKeys();
		const { dek, envelope } = await keyring.mintDek(wrapPublicKey);
		const unwrapped = await keyring.unwrapKey(envelope);
		expect(unwrapped).not.toBe(dek); // a new CryptoKey object…
		// …over the same material (verify by decrypting a fresh wrap).
		const bob = await generateWrapKeyPair();
		const bobPub = await exportWrapPublicKey(bob.publicKey);
		const rewrapped = await keyring.wrapKeyFor(unwrapped, bobPub);
		const bobDek = await unwrapDek(rewrapped, bob.privateKey);
		// Round-trip: bob's copy of the DEK encrypts identically.
		expect(bobDek.usages).toEqual(dek.usages);
		// Session cache: same envelope resolves the same CryptoKey.
		expect(await keyring.unwrapKey(envelope)).toBe(unwrapped);
	});

	it("clears the session cache without touching the device", async () => {
		const keyring = makeKeyring({ store: memoryStore() });
		const { wrapPublicKey } = await keyring.deviceKeys();
		const { envelope } = await keyring.mintDek(wrapPublicKey);
		const first = await keyring.unwrapKey(envelope);
		keyring.clearSession();
		const second = await keyring.unwrapKey(envelope);
		expect(second).not.toBe(first);
		// The device identity itself persists.
		expect((await keyring.deviceKeys()).wrapPublicKey).toBe(wrapPublicKey);
	});

	it("signs hashes with the device sign key", async () => {
		const keyring = makeKeyring({ store: memoryStore() });
		const { signPublicKey } = await keyring.deviceKeys();
		const signature = await keyring.signHash("ab".repeat(32));
		// Import the published pubkey — the signature verifies.
		expect(await verify(await importSignPublicKey(signPublicKey), "ab".repeat(32), signature)).toBe(
			true,
		);
	});

	it("seals and reads back device secrets (T-146)", async () => {
		const secrets = memorySecretStore();
		const keyring = makeKeyring({ store: memoryStore(), secrets });
		await keyring.putSecret("clinic.byok", "sk-test-key");
		expect(await keyring.getSecret("clinic.byok")).toBe("sk-test-key");
		// The stored row is ciphertext — the plaintext is nowhere in it.
		const stored = await secrets.load("clinic.byok");
		expect(stored).not.toBeNull();
		expect(JSON.stringify(stored)).not.toContain("sk-test-key");
		expect(stored!.dek.startsWith("w1.")).toBe(true);
		expect(stored!.ct.startsWith("v1.")).toBe(true);
	});

	it("returns null for missing, replaced and undecryptable secrets", async () => {
		const secrets = memorySecretStore();
		const keyring = makeKeyring({ store: memoryStore(), secrets });
		expect(await keyring.getSecret("absent")).toBeNull();
		await keyring.putSecret("key", "first");
		await keyring.putSecret("key", "second");
		expect(await keyring.getSecret("key")).toBe("second");
		// A row this device cannot open behaves as absent.
		const corrupt: SealedSecret = { dek: "w1.bogus.envelope", ct: "v1.bogus.envelope" };
		await secrets.save("corrupt", corrupt);
		expect(await keyring.getSecret("corrupt")).toBeNull();
	});

	it("deletes device secrets", async () => {
		const keyring = makeKeyring({ store: memoryStore(), secrets: memorySecretStore() });
		await keyring.putSecret("key", "value");
		await keyring.deleteSecret("key");
		expect(await keyring.getSecret("key")).toBeNull();
	});

	it("shares secrets across keyring instances over the same store", async () => {
		const store = memoryStore();
		const secrets = memorySecretStore();
		const first = makeKeyring({ store, secrets });
		await first.putSecret("key", "shared");
		// Same device identity + same secret rows → a second instance reads it.
		const second = makeKeyring({ store, secrets });
		expect(await second.getSecret("key")).toBe("shared");
	});

	it("fails to unwrap envelopes not addressed to this device", async () => {
		const keyring = makeKeyring({ store: memoryStore() });
		const other = await generateWrapKeyPair();
		const otherPub = await exportWrapPublicKey(other.publicKey);
		const { envelope } = await keyring.mintDek(otherPub);
		// The KEK derives against the wrong private key → AES-GCM auth fails.
		await expect(keyring.unwrapKey(envelope)).rejects.toThrow(/operation failed/i);
	});
});

describe("Keyring port", () => {
	it("has a stable service tag", () => {
		expect(Keyring.key).toBe("@ktb/crypto/Keyring");
	});

	it("resolves as a Context service", async () => {
		const keyring = makeKeyring({ store: memoryStore() });
		const runtime = ManagedRuntime.make((await import("effect/Layer")).succeed(Keyring, keyring));
		const keys = await runtime.runPromise(
			Effect.flatMap(Keyring, (k) => Effect.promise(() => k.deviceKeys())),
		);
		expect(keys.wrapPublicKey).toBeTruthy();
		await runtime.dispose();
	});
});

describe("idbStore", () => {
	it("is exercised only in browser envs — default falls back to memory", async () => {
		// vitest node env has no indexedDB: the default store selection
		// picks memoryStore and the keyring still works.
		const keyring = makeKeyring();
		expect((await keyring.deviceKeys()).wrapPublicKey).toBeTruthy();
		await keyring.putSecret("k", "v");
		expect(await keyring.getSecret("k")).toBe("v");
	});

	/** Minimal fake IndexedDB: one object store, microtask-fired request
	 * callbacks (handlers are always assigned synchronously before the
	 * promise executor settles, so microtasks order correctly). `stats`
	 * records close/createObjectStore/open/transaction calls so tests can
	 * assert the store lifecycle, not just the row data. */
	const fakeIndexedDB = (rows = new Map<string, unknown>(), failAt?: string) => {
		const stats = {
			closes: 0,
			created: [] as (string | undefined)[],
			opens: [] as { name?: unknown; version?: unknown }[],
			txns: [] as { store: string; mode: string }[],
		};
		const makeReq = <T>(get: () => { result: T; error: Error | null; fail?: boolean }) => {
			const r: Record<string, unknown> = { result: undefined, error: null };
			queueMicrotask(() => {
				const { result, error, fail } = get();
				r.result = result;
				r.error = error;
				((fail ? r.onerror : r.onsuccess) as (() => void) | undefined)?.call(r);
			});
			return r;
		};
		const db = {
			transaction: (store: string, mode: string) => {
				stats.txns.push({ store, mode });
				return {
					objectStore: () => ({
						get: (key: string) =>
							makeReq(() =>
								failAt === `get:${mode}`
									? // error stays null — the request() helper must
										// synthesize its fallback Error.
										{ result: undefined, error: null, fail: true }
									: { result: rows.get(key), error: null },
							),
						put: (value: unknown, key: string) =>
							makeReq(() =>
								failAt === "put"
									? { result: undefined, error: new Error("quota"), fail: true }
									: { result: (rows.set(key, value), undefined), error: null },
							),
						delete: (key: string) =>
							makeReq(() =>
								failAt === "delete"
									? { result: undefined, error: new Error("blocked"), fail: true }
									: { result: (rows.delete(key), undefined), error: null },
							),
					}),
				};
			},
			createObjectStore: (name?: string) => {
				stats.created.push(name);
				return {};
			},
			close: () => {
				stats.closes++;
			},
		};
		return {
			stats,
			open: (name?: unknown, version?: unknown) => {
				stats.opens.push({ name, version });
				const r: Record<string, unknown> = { result: db, error: null };
				queueMicrotask(() => {
					if (failAt === "open" || failAt === "open-null") {
						// "open-null" leaves error unset — the openDb helper must
						// synthesize its own fallback Error.
						r.error = failAt === "open" ? new Error("blocked") : null;
						(r.onerror as (() => void) | null)?.();
						return;
					}
					(r.onupgradeneeded as (() => void) | null)?.();
					(r.onsuccess as (() => void) | null)?.();
				});
				return r;
			},
		};
	};

	const withFakeIdb = async <T>(idb: unknown, run: () => Promise<T>) => {
		const global = globalThis as { indexedDB?: unknown };
		const previous = global.indexedDB;
		global.indexedDB = idb;
		try {
			return await run();
		} finally {
			if (previous === undefined) delete global.indexedDB;
			else global.indexedDB = previous;
		}
	};

	it("loads a persisted identity and saves over it", async () => {
		const rows = new Map<string, unknown>();
		const idb = fakeIndexedDB(rows);
		await withFakeIdb(idb, async () => {
			const { idbStore } = await import("./keyring.ts");
			const store = idbStore();
			expect(await store.load()).toBeNull();
			const identity = { wrap: {}, sign: {} } as unknown as DeviceIdentity;
			await store.save(identity);
			expect(await store.load()).toBe(identity);
		});
		// Lifecycle: every op opens the named DB, creates "device" on
		// upgrade, and closes the handle — load+save+load = 3 opens/closes.
		expect(idb.stats.opens.map((o) => o.name)).toEqual([
			"ktb-keyring",
			"ktb-keyring",
			"ktb-keyring",
		]);
		expect(idb.stats.opens[0]!.version).toBe(1);
		expect(idb.stats.created).toContain("device");
		expect(idb.stats.closes).toBe(3);
		expect(idb.stats.txns.map((t) => t.mode)).toEqual(["readonly", "readwrite", "readonly"]);
	});

	it("propagates request and open failures", async () => {
		await withFakeIdb(fakeIndexedDB(new Map(), "open"), async () => {
			const { idbStore } = await import("./keyring.ts");
			await expect(idbStore().load()).rejects.toThrow("blocked");
		});
		await withFakeIdb(fakeIndexedDB(new Map(), "open-null"), async () => {
			const { idbStore } = await import("./keyring.ts");
			await expect(idbStore().load()).rejects.toThrow("indexeddb open failed");
		});
		await withFakeIdb(fakeIndexedDB(new Map(), "put"), async () => {
			const { idbStore } = await import("./keyring.ts");
			await expect(
				idbStore().save({ wrap: {}, sign: {} } as unknown as DeviceIdentity),
			).rejects.toThrow("quota");
		});
		await withFakeIdb(fakeIndexedDB(new Map(), "get:readonly"), async () => {
			const { idbStore } = await import("./keyring.ts");
			await expect(idbStore().load()).rejects.toThrow("indexeddb request failed");
		});
	});

	it("seals, loads and removes device secrets in IndexedDB (T-146)", async () => {
		const rows = new Map<string, unknown>();
		const idb = fakeIndexedDB(rows);
		await withFakeIdb(idb, async () => {
			const { idbSecretStore } = await import("./keyring.ts");
			const store = idbSecretStore("test-secrets");
			expect(await store.load("dev")).toBeNull();
			const secret = { kind: "x" } as unknown as Parameters<typeof store.save>[1];
			await store.save("dev", secret);
			expect(await store.load("dev")).toBe(secret);
			await store.remove("dev");
			expect(await store.load("dev")).toBeNull();
		});
		// 5 ops → 5 opens/closes on the secrets DB; load/save/remove each
		// close their handle in `finally`.
		expect(idb.stats.opens.map((o) => o.name)).toEqual([
			"test-secrets",
			"test-secrets",
			"test-secrets",
			"test-secrets",
			"test-secrets",
		]);
		expect(idb.stats.created).toContain("secrets");
		expect(idb.stats.closes).toBe(5);
		expect(idb.stats.txns.map((t) => t.mode)).toEqual([
			"readonly",
			"readwrite",
			"readonly",
			"readwrite",
			"readonly",
		]);
	});

	it("propagates secrets-store open failures", async () => {
		await withFakeIdb(fakeIndexedDB(new Map(), "open"), async () => {
			const { idbSecretStore } = await import("./keyring.ts");
			await expect(idbSecretStore("t").load("k")).rejects.toThrow("blocked");
		});
		await withFakeIdb(fakeIndexedDB(new Map(), "open-null"), async () => {
			const { idbSecretStore } = await import("./keyring.ts");
			await expect(idbSecretStore("t").load("k")).rejects.toThrow("indexeddb open failed");
		});
	});

	it("propagates secrets-store request failures", async () => {
		await withFakeIdb(fakeIndexedDB(new Map(), "delete"), async () => {
			const { idbSecretStore } = await import("./keyring.ts");
			await expect(idbSecretStore("t").remove("k")).rejects.toThrow("blocked");
		});
		await withFakeIdb(fakeIndexedDB(new Map(), "put"), async () => {
			const { idbSecretStore } = await import("./keyring.ts");
			await expect(idbSecretStore("t").save("k", { kind: "x" } as never)).rejects.toThrow("quota");
		});
		await withFakeIdb(fakeIndexedDB(new Map(), "get:readonly"), async () => {
			const { idbSecretStore } = await import("./keyring.ts");
			await expect(idbSecretStore("t").load("k")).rejects.toThrow("indexeddb request failed");
		});
	});

	it("picks idbStore when indexedDB is defined", async () => {
		const rows = new Map<string, unknown>();
		const idb = fakeIndexedDB(rows);
		await withFakeIdb(idb, async () => {
			const keyring = makeKeyring();
			const keys = await keyring.deviceKeys();
			expect(keys.wrapPublicKey).toBeTruthy();
			expect(rows.has("identity")).toBe(true);
			// The secrets store defaults to IndexedDB too — a sealed secret
			// must land in the fake's rows, not a side memory map.
			await keyring.putSecret("sec", "v");
			expect(rows.has("sec")).toBe(true);
		});
		// The default secrets store is the named IndexedDB, not memory.
		expect(idb.stats.opens.map((o) => o.name)).toContain("ktb-secrets");
		expect(idb.stats.created).toContain("secrets");
	});
});
