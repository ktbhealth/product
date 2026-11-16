import { describe, expect, it, vi } from "vitest";

import type { Anamnesis, AnamnesisSection } from "@ktb/anamnesis/types";
import { encrypt } from "@ktb/crypto/aead";
import { makeKeyring, memoryStore } from "@ktb/crypto/keyring";

const mocks = vi.hoisted(() => ({
	portalDekEnvelopesFn: vi.fn(),
	portalRegisterDeviceFn: vi.fn(),
}));
vi.mock("./fns.ts", () => mocks);

import {
	decryptPortalConsultation,
	decryptPortalProfiles,
	decryptPortalSummaries,
	portalZkApi,
	registerPortalDevice,
	type PortalZkApi,
} from "./zk.ts";
import type { PortalConsultation } from "./index.ts";

const keyring = () => makeKeyring({ store: memoryStore() });

const section = (content: string): AnamnesisSection => ({
	content,
	confidence: "alta",
	evidence: [],
});

const anamnesis = (overrides: Partial<Anamnesis> = {}): Anamnesis => ({
	queixa_principal: section("Dor de cabeça"),
	hda: section("Início súbito"),
	antecedentes: section(""),
	alergias: section(""),
	medicamentos_em_uso: section(""),
	exame_fisico: section(""),
	hipoteses: section(""),
	conduta: section("Retorno"),
	historico: section(""),
	...overrides,
});

const api = (envelopes: Record<string, string>): PortalZkApi => ({
	dekEnvelopes: vi.fn(async () => envelopes),
	registerDevice: vi.fn(async () => ({ ok: true })),
});

/** A record DEK minted by the portal device itself — wrapped to its
 * own pubkey the way a clinic device would wrap it for this device. */
const granted = async (k: ReturnType<typeof keyring>) => {
	const { wrapPublicKey } = await k.deviceKeys();
	return k.mintDek(wrapPublicKey);
};

describe("portalZkApi", () => {
	it("binds the envelope read + device registration fns", async () => {
		mocks.portalDekEnvelopesFn.mockResolvedValue({ "10": "w1.x" });
		mocks.portalRegisterDeviceFn.mockResolvedValue({ ok: true });
		await expect(
			portalZkApi.dekEnvelopes({
				entityType: "consultation",
				entityIds: [10],
				wrapPublicKey: "dev",
			}),
		).resolves.toEqual({ "10": "w1.x" });
		expect(mocks.portalDekEnvelopesFn).toHaveBeenCalledWith({
			data: { entityType: "consultation", entityIds: [10], wrapPublicKey: "dev" },
		});
		await expect(
			portalZkApi.registerDevice({ wrapPublicKey: "w", signPublicKey: "s" }),
		).resolves.toEqual({ ok: true });
		expect(mocks.portalRegisterDeviceFn).toHaveBeenCalledWith({
			data: { wrapPublicKey: "w", signPublicKey: "s" },
		});
	});
});

describe("registerPortalDevice", () => {
	it("publishes the device pubkeys and ignores failures", async () => {
		mocks.portalRegisterDeviceFn.mockResolvedValue({ ok: true });
		const k = keyring();
		await expect(registerPortalDevice(k)).resolves.toBeUndefined();
		const { wrapPublicKey, signPublicKey } = await k.deviceKeys();
		expect(mocks.portalRegisterDeviceFn).toHaveBeenCalledWith({
			data: { wrapPublicKey, signPublicKey },
		});
		mocks.portalRegisterDeviceFn.mockRejectedValue(new Error("down"));
		await expect(registerPortalDevice(k)).resolves.toBeUndefined();
	});
});

const consultation = (over: Partial<PortalConsultation> = {}): PortalConsultation => ({
	id: 10,
	createdAt: new Date(0),
	patientId: 1,
	patientName: "Ana",
	doctorName: "Dra. Bia",
	sections: [],
	anamnesis: null,
	...over,
});

describe("decryptPortalConsultation", () => {
	it("returns plaintext rows untouched", async () => {
		const row = consultation();
		expect(await decryptPortalConsultation(keyring(), api({}), row)).toBe(row);
	});

	it("decrypts the record and the patient name, deriving sections", async () => {
		const k = keyring();
		const rec = await granted(k);
		const patient = await granted(k);
		const row = consultation({
			anamnesis: await encrypt(rec.dek, JSON.stringify(anamnesis())),
			patientName: await encrypt(patient.dek, "Ana Cripta"),
		});
		const a = api({ "10": rec.envelope, "1": patient.envelope });
		const out = await decryptPortalConsultation(k, a, row);
		expect(out.anamnesis).toBeNull();
		expect(out.patientName).toBe("Ana Cripta");
		expect(out.sections.map((s) => s.key)).toContain("queixa_principal");
		expect(a.dekEnvelopes).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "consultation", entityIds: [10] }),
		);
		expect(a.dekEnvelopes).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "patient", entityIds: [1] }),
		);
	});

	it("keeps the row ciphered when its grant is missing — locked state", async () => {
		const k = keyring();
		const rec = await granted(k);
		const row = consultation({ anamnesis: await encrypt(rec.dek, "{}") });
		const out = await decryptPortalConsultation(k, api({}), row);
		expect(out.anamnesis).toMatch(/^v1\./);
	});

	it("keeps the row ciphered when the envelope will not unwrap", async () => {
		const k = keyring();
		const row = consultation({ anamnesis: "v1.aGk.b2k" });
		const out = await decryptPortalConsultation(k, api({ "10": "w1.bogus" }), row);
		expect(out.anamnesis).toBe("v1.aGk.b2k");
	});

	it("renders empty sections when the decrypted payload is not a record", async () => {
		const k = keyring();
		const rec = await granted(k);
		const row = consultation({ anamnesis: await encrypt(rec.dek, "not json") });
		const out = await decryptPortalConsultation(k, api({ "10": rec.envelope }), row);
		expect(out.sections).toEqual([]);
		expect(out.anamnesis).toBeNull();
	});
});

describe("decryptPortalSummaries", () => {
	it("returns the list untouched when nothing is ciphered", async () => {
		const rows = [{ id: 1, createdAt: new Date(0), chiefComplaint: "x", anamnesis: null }];
		expect(await decryptPortalSummaries(keyring(), api({}), rows)).toEqual(rows);
	});

	it("fills the chief complaint of decryptable rows and keeps locked ones", async () => {
		const k = keyring();
		const rec = await granted(k);
		const bad = await granted(k);
		const rows = [
			{
				id: 10,
				createdAt: new Date(0),
				chiefComplaint: null,
				anamnesis: await encrypt(rec.dek, JSON.stringify(anamnesis())),
			},
			{
				id: 11,
				createdAt: new Date(0),
				chiefComplaint: null,
				anamnesis: await encrypt(bad.dek, "v1.garbage"),
			},
			{
				id: 12,
				createdAt: new Date(0),
				chiefComplaint: null,
				anamnesis: await encrypt(bad.dek, "not json"),
			},
		];
		const out = await decryptPortalSummaries(
			k,
			api({ "10": rec.envelope, "12": bad.envelope }),
			rows,
		);
		expect(out[0]).toMatchObject({ chiefComplaint: "Dor de cabeça", anamnesis: null });
		expect(out[1]!.anamnesis).toMatch(/^v1\./); // no grant → locked
		expect(out[2]).toMatchObject({ chiefComplaint: null, anamnesis: null });
	});
});

describe("decryptPortalProfiles", () => {
	it("returns rows untouched when no name is ciphered", async () => {
		const rows = [{ patientId: 1, name: "Ana" }];
		expect(await decryptPortalProfiles(keyring(), api({}), rows)).toEqual(rows);
	});

	it("decrypts names under the patient DEK, one fetch per patient", async () => {
		const k = keyring();
		const p = await granted(k);
		const rows = [
			{ patientId: 1, name: await encrypt(p.dek, "Ana") },
			{ patientId: 1, name: await encrypt(p.dek, "Ana Again") },
			{ patientId: 2, name: "Leo" },
		];
		const a = api({ "1": p.envelope });
		const out = await decryptPortalProfiles(k, a, rows);
		expect(out.map((r) => r.name)).toEqual(["Ana", "Ana Again", "Leo"]);
	});

	it("keeps names locked on missing, undecryptable or wrong-key envelopes", async () => {
		const k = keyring();
		const p = await granted(k);
		const other = await granted(keyring());
		const rows = [
			{ patientId: 1, name: await encrypt(p.dek, "Ana") }, // no grant
			{ patientId: 2, name: await encrypt(p.dek, "Eva") }, // bad envelope
			{ patientId: 3, name: await encrypt(other.dek, "Sia") }, // right wrap, wrong DEK
		];
		const out = await decryptPortalProfiles(k, api({ "2": "w1.bogus", "3": p.envelope }), rows);
		expect(out.map((r) => r.name)).toEqual(rows.map((r) => r.name));
	});
});
