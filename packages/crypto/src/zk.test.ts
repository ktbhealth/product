import { describe, expect, it, vi } from "vitest";

import { decryptText, encrypt } from "./aead.ts";
import { decryptRow } from "./cipher.ts";
import { defineCipher } from "./cipher.ts";
import { CryptoFormatError } from "./encoding.ts";
import { makeKeyring, memoryStore } from "./keyring.ts";
import { isEnvelope, makeEntityZk, type EntityZkApi } from "./zk.ts";

const keyring = () => makeKeyring({ store: memoryStore() });

const widgetCipher = defineCipher({
	entity: "widget",
	fields: ["secret", "meta"],
	plaintext: ["id", "ownerId"],
});

const kit = (over: Partial<Parameters<typeof makeEntityZk>[0]> = {}) =>
	makeEntityZk({
		entityType: "widget",
		cipher: widgetCipher,
		fields: ["secret", "meta"],
		...over,
	});

const api = (over: Partial<EntityZkApi> = {}): EntityZkApi => ({
	devices: vi.fn(async () => []),
	dekEnvelopes: vi.fn(async () => ({})),
	grant: vi.fn(async () => ({ ok: true })),
	...over,
});

/** Mint a real DEK wrapped to `k`'s device pubkey — the envelope the
 * server-side `entity_deks` table would hand back. */
const grantedDek = async (k: ReturnType<typeof keyring>) => {
	const { wrapPublicKey } = await k.deviceKeys();
	return k.mintDek(wrapPublicKey);
};

const isCiphered = (row: { readonly secret?: unknown }): boolean => isEnvelope(row.secret);

describe("isEnvelope", () => {
	it("detects v1. envelopes only", () => {
		expect(isEnvelope("v1.abc.def")).toBe(true);
		expect(isEnvelope("w1.abc.def")).toBe(false);
		expect(isEnvelope("plain")).toBe(false);
		expect(isEnvelope(null)).toBe(false);
		expect(isEnvelope(42)).toBe(false);
	});
});

describe("makeEntityZk validation", () => {
	it("rejects empty, non-string and mismatched entityType", () => {
		expect(() => kit({ entityType: "" })).toThrow(CryptoFormatError);
		expect(() => kit({ entityType: "   " })).toThrow(CryptoFormatError);
		expect(() => kit({ entityType: 42 as never })).toThrow(CryptoFormatError);
		expect(() => kit({ entityType: "gadget" })).toThrow(CryptoFormatError);
	});

	it("rejects fields outside the cipher spec", () => {
		expect(() => kit({ fields: ["secret", "bogus" as never] })).toThrow(CryptoFormatError);
	});
});

describe("encryptFields", () => {
	it("envelopes every configured field and nulls the absent ones", async () => {
		const k = keyring();
		const { dek } = await grantedDek(k);
		const out = await kit().encryptFields(dek, { secret: "s3cr3t" });
		expect(out.secret).toMatch(/^v1\./);
		expect(out.meta).toBeNull();
		// Roundtrip through the spec codec.
		const plain = await decryptRow(widgetCipher, dek, {
			id: 1,
			secret: out.secret,
			meta: out.meta,
		});
		expect(plain.secret).toBe("s3cr3t");
		expect(plain.meta).toBeNull();
	});

	it("passes non-string values through canonical JSON by default", async () => {
		const k = keyring();
		const { dek } = await grantedDek(k);
		const out = await kit().encryptFields(dek, { meta: { nested: [1, 2] } });
		expect(out.meta).toMatch(/^v1\./);
		const plain = await decryptRow(widgetCipher, dek, { id: 1, meta: out.meta });
		expect(plain.meta).toBe('{"nested":[1,2]}');
	});

	it('honors a custom normalizeField ("" and non-strings → null)', async () => {
		const k = keyring();
		const { dek } = await grantedDek(k);
		const strict = kit({
			normalizeField: (value) => (typeof value === "string" && value !== "" ? value : null),
		});
		const out = await strict.encryptFields(dek, { secret: "", meta: 42 });
		expect(out.secret).toBeNull();
		expect(out.meta).toBeNull();
		// Without the normalizer "" encrypts and 42 canonicalizes.
		const lax = await kit().encryptFields(dek, { secret: "", meta: 42 });
		expect(lax.secret).toMatch(/^v1\./);
		expect(lax.meta).toMatch(/^v1\./);
	});
});

describe("decryptRows", () => {
	it("returns a copy untouched when no row is ciphered", async () => {
		const k = keyring();
		const a = api();
		const rows = [
			{ id: 1, secret: "plain", ownerId: "u" },
			{ id: 2, secret: null, ownerId: "u" },
		];
		const out = await kit().decryptRows(k, a, rows, { isCiphered });
		expect(out).toEqual(rows);
		expect(out).not.toBe(rows);
		expect(a.dekEnvelopes).not.toHaveBeenCalled();
	});

	it("decrypts rows whose envelope the device can unwrap", async () => {
		const k = keyring();
		const { dek, envelope } = await grantedDek(k);
		const encrypted = await kit().encryptFields(dek, { secret: "s3cr3t" });
		const rows = [
			{ id: 7, secret: encrypted.secret, ownerId: "u" },
			{ id: "row-b", secret: "plain", ownerId: "u" },
		];
		const dekEnvelopes = vi.fn(async () => ({ "7": envelope }));
		const out = await kit().decryptRows(k, api({ dekEnvelopes }), rows, { isCiphered });
		expect(dekEnvelopes).toHaveBeenCalledWith({
			entityType: "widget",
			entityIds: [7],
			wrapPublicKey: (await k.deviceKeys()).wrapPublicKey,
		});
		expect(out[0]?.secret).toBe("s3cr3t");
		expect(out[0]?.id).toBe(7);
		expect(out[1]).toBe(rows[1]);
	});

	it("keeps rows locked when their grant is absent or unwrap fails", async () => {
		const k = keyring();
		const locked = { id: 9, secret: "v1.aa.bb", ownerId: "u" };
		const out = await kit().decryptRows(k, api(), [locked], { isCiphered });
		expect(out[0]).toBe(locked);
		const bogus = api({ dekEnvelopes: vi.fn(async () => ({ "9": "w1.bogus.envelope" })) });
		expect((await kit().decryptRows(k, bogus, [locked], { isCiphered }))[0]).toBe(locked);
	});

	it("uses specRow to project undeclared keys away before decryptRow", async () => {
		const k = keyring();
		const { dek, envelope } = await grantedDek(k);
		const encrypted = await kit().encryptFields(dek, { secret: "s3cr3t" });
		// `extra` is not spec-declared — decryptRow would throw without
		// the projection, and the catch keeps the row unchanged.
		const row = { id: 3, secret: encrypted.secret, extra: "join-field" };
		const specRow = (r: typeof row) => ({ id: r.id, secret: r.secret });
		const out = await kit().decryptRows(
			k,
			api({ dekEnvelopes: async () => ({ "3": envelope }) }),
			[row],
			{
				isCiphered,
				specRow,
			},
		);
		expect(out[0]?.secret).toBe("s3cr3t");
		expect(out[0]?.extra).toBe("join-field");
		// Same row without specRow stays locked (undeclared key throws).
		const locked = await kit().decryptRows(
			k,
			api({ dekEnvelopes: async () => ({ "3": envelope }) }),
			[row],
			{ isCiphered },
		);
		expect(locked[0]).toBe(row);
	});
});

describe("decryptRow", () => {
	it("returns plaintext rows unchanged", async () => {
		const row = { id: 1, secret: "plain", ownerId: "u" };
		await expect(kit().decryptRow(keyring(), api(), row, { isCiphered })).resolves.toBe(row);
	});

	it("returns the decrypted row or null when locked", async () => {
		const k = keyring();
		const { dek, envelope } = await grantedDek(k);
		const encrypted = await kit().encryptFields(dek, { secret: "s3cr3t" });
		const row = { id: 3, secret: encrypted.secret, ownerId: "u" };
		const a = api({ dekEnvelopes: vi.fn(async () => ({ "3": envelope })) });
		const decrypted = await kit().decryptRow(k, a, row, { isCiphered });
		expect(decrypted?.secret).toBe("s3cr3t");
		await expect(kit().decryptRow(k, api(), row, { isCiphered })).resolves.toBeNull();
	});
});

describe("newDek", () => {
	it("grants every approved device plus the creator, skipping pending", async () => {
		const k = keyring();
		const { wrapPublicKey } = await k.deviceKeys();
		const other = await keyring().deviceKeys();
		const devices = vi.fn(async () => [
			{ wrapPublicKey, status: "approved" },
			{ wrapPublicKey: other.wrapPublicKey, status: "approved" },
			{ wrapPublicKey: "pending-pub", status: "pending" },
			// A duplicate approved entry — the reader set dedupes.
			{ wrapPublicKey: other.wrapPublicKey, status: "approved" },
		]);
		const { dek, grants } = await kit().newDek(k, api({ devices }));
		expect(grants).toHaveLength(2);
		expect(grants.map((g) => g.readerPubkey).sort()).toEqual(
			[wrapPublicKey, other.wrapPublicKey].sort(),
		);
		expect(grants.every((g) => g.readerKind === "device")).toBe(true);
		expect(grants.every((g) => g.wrappedDek.startsWith("w1."))).toBe(true);
		// The minted DEK is the one the creator's envelope unwraps to —
		// prove key equality functionally (CryptoKey objects differ).
		const own = grants.find((g) => g.readerPubkey === wrapPublicKey);
		const unwrapped = await k.unwrapKey(own!.wrappedDek);
		const ct = await encrypt(dek, "proof");
		expect(await decryptText(unwrapped, ct)).toBe("proof");
	});

	it("grants only the creating device when no other devices exist", async () => {
		const k = keyring();
		const { wrapPublicKey } = await k.deviceKeys();
		const { grants } = await kit().newDek(k, api());
		expect(grants).toEqual([
			{
				readerKind: "device",
				readerPubkey: wrapPublicKey,
				wrappedDek: expect.stringMatching(/^w1\./),
			},
		]);
	});
});

describe("dekFor", () => {
	it("unwraps the caller's envelope or returns null", async () => {
		const k = keyring();
		const { dek, envelope } = await grantedDek(k);
		const a = api({ dekEnvelopes: vi.fn(async () => ({ "5": envelope })) });
		const got = await kit().dekFor(k, a, 5);
		expect(got).not.toBeNull();
		// Same DEK bytes: encrypt with `dek`, decrypt-check via `got`.
		const encrypted = await kit().encryptFields(dek, { secret: "s3cr3t" });
		const plain = await decryptRow(widgetCipher, got!, {
			id: 5,
			secret: encrypted.secret,
		});
		expect(plain.secret).toBe("s3cr3t");
		expect(a.dekEnvelopes).toHaveBeenCalledWith({
			entityType: "widget",
			entityIds: [5],
			wrapPublicKey: (await k.deviceKeys()).wrapPublicKey,
		});
		await expect(kit().dekFor(k, api(), 5)).resolves.toBeNull();
	});
});
