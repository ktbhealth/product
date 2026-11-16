import { describe, expect, it, vi } from "vitest";

import { makeKeyring, memoryStore } from "@ktb/crypto/keyring";
import { HeuristicExtractor, type Anamnesis } from "@ktb/anamnesis";

import { consultationCipher, CONSULTATION_CIPHERED_FIELDS } from "./cipher.ts";
import {
	CONSULTATION_ENTITY_TYPE,
	consultationDek,
	type ConsultationZkApi,
	decryptConsultation,
	decryptConsultations,
	encryptAnamnesis,
	encryptConsultationDraft,
	extractAnamnesisZk,
	isCipheredConsultation,
	isEnvelope,
	newConsultationDek,
	parseAnamnesis,
	signAnamnesis,
} from "./zk.ts";

const keyring = () => makeKeyring({ store: memoryStore() });

const api = (over: Partial<ConsultationZkApi> = {}): ConsultationZkApi => ({
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

/** A valid anamnesis document via the deterministic heuristic. */
const anamnesis = async (
	transcript = "Paciente com dor de cabeça há três dias e febre.",
): Promise<Anamnesis> => new HeuristicExtractor().extract(transcript);

describe("consultationCipher spec (T-145)", () => {
	it("classifies every clinical column and keeps operational metadata plaintext", () => {
		expect(consultationCipher.entity).toBe("consultation");
		expect([...consultationCipher.fields].sort()).toEqual(
			["anamnesis", "correctedTranscript", "review", "serverTranscript", "transcript"].sort(),
		);
		for (const field of ["id", "userId", "patientId", "tenantId", "status", "createdAt"]) {
			expect(consultationCipher.plaintext).toContain(field);
		}
		// No field may sit on both sides of the spec.
		for (const f of consultationCipher.fields) {
			expect(consultationCipher.plaintext).not.toContain(f);
		}
	});
});

describe("isEnvelope / isCipheredConsultation", () => {
	it("detects v1. envelopes on anamnesis or transcript", () => {
		expect(isEnvelope("v1.abc.def")).toBe(true);
		expect(isEnvelope("w1.abc.def")).toBe(false);
		expect(isEnvelope("text")).toBe(false);
		expect(isEnvelope(null)).toBe(false);
		expect(isCipheredConsultation({ anamnesis: "v1.x.y" })).toBe(true);
		expect(isCipheredConsultation({ transcript: "v1.x.y" })).toBe(true);
		expect(isCipheredConsultation({ anamnesis: "{}", transcript: "plain" })).toBe(false);
		expect(isCipheredConsultation({})).toBe(false);
	});
});

describe("parseAnamnesis", () => {
	it("decodes a stored canonical document and tolerates drift", async () => {
		const doc = await anamnesis();
		expect(parseAnamnesis(JSON.stringify(doc))?.queixa_principal.content).toBe(
			doc.queixa_principal.content,
		);
		expect(parseAnamnesis(null)).toBeNull();
		expect(parseAnamnesis("v1.not-json")).toBeNull();
		expect(parseAnamnesis('{"bogus":true}')).toBeNull();
	});
});

describe("encryptConsultationDraft / encryptAnamnesis", () => {
	it("envelopes transcript and the canonical anamnesis document", async () => {
		const k = keyring();
		const { dek } = await grantedDek(k);
		const doc = await anamnesis();
		const out = await encryptConsultationDraft(dek, {
			transcript: "dor há três dias",
			anamnesis: doc,
		});
		expect(out.transcript).toMatch(/^v1\./);
		expect(out.anamnesis).toMatch(/^v1\./);
		// The ciphertext decrypts back to the canonical JSON the
		// client-side version hash is computed over.
		expect(
			parseAnamnesis((await decryptWith(dek, out)).anamnesis as string | null)?.queixa_principal,
		).toEqual(doc.queixa_principal);
	});

	it("encrypts only the anamnesis column for the attach path", async () => {
		const k = keyring();
		const { dek } = await grantedDek(k);
		const doc = await anamnesis();
		const env = await encryptAnamnesis(dek, doc);
		expect(env).toMatch(/^v1\./);
		expect(env).not.toContain("queixa_principal");
	});
});

/** Roundtrip through decryptRow the way decryptConsultations does. */
const decryptWith = async (dek: CryptoKey, row: { transcript: string; anamnesis: string }) => {
	const { decryptRow } = await import("@ktb/crypto/cipher");
	return decryptRow(consultationCipher, dek, row);
};

describe("decryptConsultations", () => {
	it("returns a copy untouched when no row is ciphered", async () => {
		const k = keyring();
		const a = api();
		const rows = [
			{ id: 1, anamnesis: null, transcript: "t" },
			{ id: 2, anamnesis: null, transcript: "" },
		];
		const out = await decryptConsultations(k, a, rows);
		expect(out).toEqual(rows);
		expect(out).not.toBe(rows);
		expect(a.dekEnvelopes).not.toHaveBeenCalled();
	});

	it("decrypts rows whose envelope the device can unwrap", async () => {
		const k = keyring();
		const { dek, envelope } = await grantedDek(k);
		const doc = await anamnesis();
		const draft = await encryptConsultationDraft(dek, { transcript: "t", anamnesis: doc });
		const rows = [{ id: 7, anamnesis: draft.anamnesis, transcript: draft.transcript }];
		const dekEnvelopes = vi.fn(async () => ({ "7": envelope }));
		const out = await decryptConsultations(k, api({ dekEnvelopes }), rows);
		expect(dekEnvelopes).toHaveBeenCalledWith({
			entityType: CONSULTATION_ENTITY_TYPE,
			entityIds: [7],
			wrapPublicKey: (await k.deviceKeys()).wrapPublicKey,
		});
		expect(out[0]?.transcript).toBe("t");
		expect(parseAnamnesis(out[0]?.anamnesis)?.queixa_principal).toEqual(doc.queixa_principal);
		expect(isCipheredConsultation(out[0]!)).toBe(false);
	});

	it("decrypts the joined patientName via the patient DEK", async () => {
		const k = keyring();
		const { wrapPublicKey } = await k.deviceKeys();
		const { dek: consultDek, envelope: consultEnv } = await k.mintDek(wrapPublicKey);
		const { dek: patientDek, envelope: patientEnv } = await k.mintDek(wrapPublicKey);
		const { encrypt } = await import("@ktb/crypto/aead");
		const doc = await anamnesis();
		const draft = await encryptConsultationDraft(consultDek, { transcript: "t", anamnesis: doc });
		const rows = [
			{
				id: 7,
				patientId: 11,
				patientName: await encrypt(patientDek, "Maria Silva"),
				anamnesis: draft.anamnesis,
				transcript: draft.transcript,
			},
		];
		const dekEnvelopes: ConsultationZkApi["dekEnvelopes"] = vi.fn(
			async (input): Promise<Record<string, string>> =>
				input.entityType === "patient" ? { "11": patientEnv } : { "7": consultEnv },
		);
		const out = await decryptConsultations(k, api({ dekEnvelopes }), rows);
		expect(out[0]?.patientName).toBe("Maria Silva");
	});

	it("keeps rows locked when their grant is absent or unwrap fails", async () => {
		const k = keyring();
		const row = { id: 9, anamnesis: "v1.aa.bb", transcript: "v1.cc.dd" };
		const out = await decryptConsultations(k, api(), [row]);
		expect(out[0]).toBe(row);
		expect(isCipheredConsultation(out[0]!)).toBe(true);
		const bogus = api({ dekEnvelopes: vi.fn(async () => ({ "9": "w1.bogus.envelope" })) });
		expect((await decryptConsultations(k, bogus, [row]))[0]).toBe(row);
	});

	it("keeps patient names locked when the patient DEK unwrap fails", async () => {
		const k = keyring();
		const row = { id: 9, patientId: 5, patientName: "v1.aa.bb", transcript: "plain" };
		const bogus = api({ dekEnvelopes: vi.fn(async () => ({ "5": "w1.bogus.envelope" })) });
		const out = await decryptConsultations(k, bogus, [row]);
		expect(out[0]).toBe(row);
		expect(out[0]?.patientName).toBe("v1.aa.bb");
	});

	it("keeps the name enveloped when the patient envelope is absent", async () => {
		const k = keyring();
		const { wrapPublicKey } = await k.deviceKeys();
		const { dek: patientDek } = await k.mintDek(wrapPublicKey);
		const { encrypt } = await import("@ktb/crypto/aead");
		const row = {
			id: 3,
			patientId: 11,
			patientName: await encrypt(patientDek, "Maria"),
			anamnesis: null,
			transcript: "t",
		};
		// No envelope for patient 11 in the response → name stays opaque.
		const out = await decryptConsultations(k, api(), [row]);
		expect(out[0]?.patientName).toBe(row.patientName);
	});

	it("unwraps a shared patient DEK once across rows", async () => {
		const k = keyring();
		const { wrapPublicKey } = await k.deviceKeys();
		const { dek: patientDek, envelope: patientEnv } = await k.mintDek(wrapPublicKey);
		const { encrypt } = await import("@ktb/crypto/aead");
		const patientName = await encrypt(patientDek, "Maria Silva");
		const rows = [
			{ id: 1, patientId: 11, patientName, anamnesis: null, transcript: "a" },
			{ id: 2, patientId: 11, patientName, anamnesis: null, transcript: "b" },
		];
		const dekEnvelopes: ConsultationZkApi["dekEnvelopes"] = vi.fn(
			async (): Promise<Record<string, string>> => ({ "11": patientEnv }),
		);
		const unwrap = vi.spyOn(k, "unwrapKey");
		const out = await decryptConsultations(k, api({ dekEnvelopes }), rows);
		expect(unwrap).toHaveBeenCalledTimes(1);
		expect(out.map((r) => r.patientName)).toEqual(["Maria Silva", "Maria Silva"]);
	});
});

describe("decryptConsultation", () => {
	it("returns the decrypted row or null when locked", async () => {
		const k = keyring();
		const { dek, envelope } = await grantedDek(k);
		const doc = await anamnesis();
		const draft = await encryptConsultationDraft(dek, { transcript: "t", anamnesis: doc });
		const row = { id: 3, anamnesis: draft.anamnesis, transcript: draft.transcript };
		const decrypted = await decryptConsultation(
			k,
			api({ dekEnvelopes: vi.fn(async () => ({ "3": envelope })) }),
			row,
		);
		expect(decrypted?.transcript).toBe("t");
		await expect(decryptConsultation(k, api(), row)).resolves.toBeNull();
	});

	it("returns plaintext rows (still decrypting a ciphered patientName)", async () => {
		const k = keyring();
		const { wrapPublicKey } = await k.deviceKeys();
		const { dek: patientDek, envelope: patientEnv } = await k.mintDek(wrapPublicKey);
		const { encrypt } = await import("@ktb/crypto/aead");
		const row = {
			id: 4,
			patientId: 11,
			patientName: await encrypt(patientDek, "Ana"),
			anamnesis: null,
			transcript: "plain",
		};
		const out = await decryptConsultation(
			k,
			api({ dekEnvelopes: vi.fn(async () => ({ "11": patientEnv })) }),
			row,
		);
		expect(out?.patientName).toBe("Ana");
	});
});

describe("newConsultationDek / consultationDek", () => {
	it("grants every approved device plus the creator, skipping pending", async () => {
		const k = keyring();
		const { wrapPublicKey } = await k.deviceKeys();
		const other = await keyring().deviceKeys();
		const devices = vi.fn(async () => [
			{ wrapPublicKey, status: "approved" },
			{ wrapPublicKey: other.wrapPublicKey, status: "approved" },
			{ wrapPublicKey: "pending-pub", status: "pending" },
		]);
		const { dek, grants } = await newConsultationDek(k, api({ devices }));
		expect(grants.map((g) => g.readerPubkey).sort()).toEqual(
			[wrapPublicKey, other.wrapPublicKey].sort(),
		);
		expect(grants.every((g) => g.readerKind === "device")).toBe(true);
		expect(grants.every((g) => g.wrappedDek.startsWith("w1."))).toBe(true);
		expect(dek.type).toBe("secret");
	});

	it("unwraps the caller's envelope for an existing record or returns null", async () => {
		const k = keyring();
		const { envelope } = await grantedDek(k);
		const a = api({ dekEnvelopes: vi.fn(async () => ({ "5": envelope })) });
		await expect(consultationDek(k, a, 5)).resolves.not.toBeNull();
		await expect(consultationDek(k, api(), 5)).resolves.toBeNull();
	});
});

describe("signAnamnesis / extractAnamnesisZk", () => {
	it("signs the canonical content hash with the device key", async () => {
		const k = keyring();
		const doc = await anamnesis();
		const { contentHash } = await import("@ktb/crypto/digest");
		const { contentHash: hash, signature } = await signAnamnesis(k, doc);
		expect(hash).toBe(await contentHash(doc));
		expect(signature).toBeTypeOf("string");
		expect(signature.length).toBeGreaterThan(0);
	});

	it("extracts locally — the transcript never reaches a server", async () => {
		const res = await extractAnamnesisZk("Paciente com dor de cabeça e febre.");
		expect(res.engine).toBe("heuristic");
		expect(res.anamnesis.queixa_principal.content.length).toBeGreaterThan(0);
	});
});

describe("spec coverage sanity", () => {
	it("ciphered fields are exactly the five clinical columns", () => {
		expect(CONSULTATION_CIPHERED_FIELDS).toEqual([
			"transcript",
			"anamnesis",
			"review",
			"serverTranscript",
			"correctedTranscript",
		]);
	});
});
