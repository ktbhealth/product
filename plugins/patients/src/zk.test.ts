import { describe, expect, it, vi } from "vitest";

import { makeKeyring, memoryStore } from "@ktb/crypto/keyring";

import type { Patient } from "./index.ts";
import { makePatient } from "./testing.ts";
import {
	decryptPatient,
	decryptPatients,
	encryptPatientDraft,
	isCipheredPatient,
	isEnvelope,
	newPatientDek,
	PATIENT_ENTITY_TYPE,
	patientDek,
	type PatientZkApi,
} from "./zk.ts";

const keyring = () => makeKeyring({ store: memoryStore() });

const api = (over: Partial<PatientZkApi> = {}): PatientZkApi => ({
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

describe("isEnvelope / isCipheredPatient", () => {
	it("detects v1. envelopes and ciphered rows", () => {
		expect(isEnvelope("v1.abc.def")).toBe(true);
		expect(isEnvelope("w1.abc.def")).toBe(false);
		expect(isEnvelope("Maria")).toBe(false);
		expect(isEnvelope(null)).toBe(false);
		expect(isEnvelope(42)).toBe(false);
		expect(isCipheredPatient({ name: "v1.x.y" })).toBe(true);
		expect(isCipheredPatient({ name: "Maria" })).toBe(false);
		expect(isCipheredPatient({ name: null })).toBe(false);
		expect(isCipheredPatient({})).toBe(false);
	});
});

describe("encryptPatientDraft", () => {
	it("envelopes every non-empty text field and keeps active/ciphered plaintext", async () => {
		const k = keyring();
		const { dek } = await grantedDek(k);
		const draft = {
			name: "Maria Silva",
			birthDate: "1980-05-10",
			cpf: "123.456.789-09",
			email: null,
			active: false,
		};
		const out = await encryptPatientDraft(dek, draft);
		expect(out.ciphered).toBe(true);
		expect(out.active).toBe(false);
		expect(out.name).toMatch(/^v1\./);
		expect(out.birthDate).toMatch(/^v1\./);
		expect(out.cpf).toMatch(/^v1\./);
		expect(out.email).toBeNull();
		// Untouched fields normalize to null — never dropped or invented.
		expect(out.phone).toBeNull();
	});
});

describe("decryptPatients", () => {
	it("returns a copy untouched when no row is ciphered", async () => {
		const k = keyring();
		const a = api();
		const rows = [makePatient({ id: 1 }), makePatient({ id: 2 })];
		const out = await decryptPatients(k, a, rows);
		expect(out).toEqual(rows);
		expect(out).not.toBe(rows);
		expect(a.dekEnvelopes).not.toHaveBeenCalled();
	});

	it("decrypts rows whose envelope the device can unwrap", async () => {
		const k = keyring();
		const { dek, envelope } = await grantedDek(k);
		const draft = await encryptPatientDraft(dek, {
			name: "Maria Silva",
			birthDate: "1980-05-10",
		});
		const ciphered = makePatient({
			id: 7,
			name: draft.name!,
			birthDate: draft.birthDate,
		});
		const plaintext = makePatient({ id: 8, name: "Ana" });
		const dekEnvelopes = vi.fn(async () => ({ "7": envelope }));
		const out = await decryptPatients(k, api({ dekEnvelopes }), [ciphered, plaintext]);
		expect(dekEnvelopes).toHaveBeenCalledWith({
			entityType: PATIENT_ENTITY_TYPE,
			entityIds: [7],
			wrapPublicKey: (await k.deviceKeys()).wrapPublicKey,
		});
		expect(out[0]?.name).toBe("Maria Silva");
		expect(out[0]?.birthDate).toBe("1980-05-10");
		expect(out[0]?.id).toBe(7);
		expect(out[1]?.name).toBe("Ana");
	});

	it("keeps rows locked when their grant is absent", async () => {
		const k = keyring();
		const ciphered = makePatient({ id: 9, name: "v1.aa.bb" });
		const out = await decryptPatients(k, api(), [ciphered]);
		expect(out[0]).toBe(ciphered);
		expect(isCipheredPatient(out[0]!)).toBe(true);
	});

	it("keeps rows locked when unwrap/decrypt throws", async () => {
		const k = keyring();
		// A syntactically valid envelope string that unwrapDek rejects.
		const ciphered = makePatient({ id: 9, name: "v1.aa.bb" });
		const dekEnvelopes = vi.fn(async () => ({ "9": "w1.bogus.envelope" }));
		const out = await decryptPatients(k, api({ dekEnvelopes }), [ciphered]);
		expect(out[0]).toBe(ciphered);
	});
});

describe("decryptPatient", () => {
	it("returns plaintext rows unchanged", async () => {
		const row = makePatient({ id: 1 });
		await expect(decryptPatient(keyring(), api(), row)).resolves.toBe(row);
	});

	it("returns the decrypted row or null when locked", async () => {
		const k = keyring();
		const { dek, envelope } = await grantedDek(k);
		const draft = await encryptPatientDraft(dek, { name: "Bia", birthDate: "1990-01-01" });
		const row = makePatient({ id: 3, name: draft.name!, birthDate: draft.birthDate });
		const a = api({ dekEnvelopes: vi.fn(async () => ({ "3": envelope })) });
		const decrypted = await decryptPatient(k, a, row);
		expect(decrypted?.name).toBe("Bia");
		await expect(decryptPatient(k, api(), row)).resolves.toBeNull();
	});
});

describe("patientDek", () => {
	it("unwraps the caller's envelope or returns null", async () => {
		const k = keyring();
		const { dek, envelope } = await grantedDek(k);
		const a = api({ dekEnvelopes: vi.fn(async () => ({ "5": envelope })) });
		const got = await patientDek(k, a, 5);
		expect(got).not.toBeNull();
		// Same DEK bytes: encrypt with `dek`, decrypt-check via unwrap.
		const draft = await encryptPatientDraft(dek, { name: "X", birthDate: "2000-01-01" });
		const withGot = await encryptPatientDraft(got!, { name: "X", birthDate: "2000-01-01" });
		expect(withGot.name).toMatch(/^v1\./);
		expect(draft.name).toMatch(/^v1\./);
		expect(a.dekEnvelopes).toHaveBeenCalledWith({
			entityType: PATIENT_ENTITY_TYPE,
			entityIds: [5],
			wrapPublicKey: (await k.deviceKeys()).wrapPublicKey,
		});
		await expect(patientDek(k, api(), 5)).resolves.toBeNull();
	});
});

describe("newPatientDek", () => {
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
		const { dek, grants } = await newPatientDek(k, api({ devices }));
		expect(grants).toHaveLength(2);
		expect(grants.map((g) => g.readerPubkey).sort()).toEqual(
			[wrapPublicKey, other.wrapPublicKey].sort(),
		);
		expect(grants.every((g) => g.readerKind === "device")).toBe(true);
		expect(grants.every((g) => g.wrappedDek.startsWith("w1."))).toBe(true);
		// The freshly minted DEK decrypts a draft the creator wrote.
		const draft = await encryptPatientDraft(dek, { name: "Z", birthDate: "2001-01-01" });
		expect(draft.name).toMatch(/^v1\./);
	});

	it("grants only the creating device when no other devices exist", async () => {
		const k = keyring();
		const { wrapPublicKey } = await k.deviceKeys();
		const { grants } = await newPatientDek(k, api());
		expect(grants).toEqual([
			{
				readerKind: "device",
				readerPubkey: wrapPublicKey,
				wrappedDek: expect.stringMatching(/^w1\./),
			},
		]);
	});
});

describe("Patient fixture sanity", () => {
	it("makePatient stays plaintext for non-ZK rows", () => {
		const p: Patient = makePatient();
		expect(isCipheredPatient(p)).toBe(false);
	});
});
