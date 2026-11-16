import { describe, expect, it, vi } from "vitest";

import { exportDek } from "@ktb/crypto/aead";
import { makeKeyring, memoryStore } from "@ktb/crypto/keyring";

const mocks = vi.hoisted(() => ({
	portalReadersFn: vi.fn(),
	vaultDekEnvelopesFn: vi.fn(),
	vaultGrantAccessFn: vi.fn(),
}));
vi.mock("./fns.ts", () => ({ portalReadersFn: mocks.portalReadersFn }));
vi.mock("@ktb/vault/fns", () => ({
	vaultDekEnvelopesFn: mocks.vaultDekEnvelopesFn,
	vaultGrantAccessFn: mocks.vaultGrantAccessFn,
}));

import { grantPortalAccess, patientAccessZkApi, type PatientAccessZkApi } from "./zk.ts";

const keyring = () => makeKeyring({ store: memoryStore() });

const api = (
	envelopes: Record<string, string>,
	grantResult = { ok: true },
): PatientAccessZkApi => ({
	portalReaders: vi.fn(async () => null),
	dekEnvelopes: vi.fn(async () => envelopes),
	grant: vi.fn(async () => grantResult),
});

describe("patientAccessZkApi", () => {
	it("binds the readers plan and the vault envelope/grant fns", async () => {
		mocks.portalReadersFn.mockResolvedValue({ readers: [], cipheredConsultationIds: [] });
		mocks.vaultDekEnvelopesFn.mockResolvedValue({ "1": "w1.x" });
		mocks.vaultGrantAccessFn.mockResolvedValue({ ok: true });
		await expect(patientAccessZkApi.portalReaders(7)).resolves.toEqual({
			readers: [],
			cipheredConsultationIds: [],
		});
		expect(mocks.portalReadersFn).toHaveBeenCalledWith({ data: 7 });
		await expect(
			patientAccessZkApi.dekEnvelopes({
				entityType: "patient",
				entityIds: [7],
				wrapPublicKey: "dev",
			}),
		).resolves.toEqual({ "1": "w1.x" });
		await expect(
			patientAccessZkApi.grant({
				entityType: "patient",
				entityId: 7,
				grants: [],
			}),
		).resolves.toEqual({ ok: true });
		expect(mocks.vaultGrantAccessFn).toHaveBeenCalledWith({
			data: { entityType: "patient", entityId: 7, grants: [] },
		});
	});
});

describe("grantPortalAccess", () => {
	it("does nothing when no portal device is registered", async () => {
		const a = api({});
		await expect(
			grantPortalAccess(keyring(), a, {
				patientId: 1,
				consultationIds: [10],
				readers: [],
			}),
		).resolves.toBe(0);
		expect(a.dekEnvelopes).not.toHaveBeenCalled();
		expect(a.grant).not.toHaveBeenCalled();
	});

	it("re-wraps the record DEKs to every portal reader pubkey", async () => {
		const clinic = keyring(); // the doctor's approved device
		const portal = keyring(); // a registered portal device
		const { wrapPublicKey: portalPub } = await portal.deviceKeys();
		const clinicPub = (await clinic.deviceKeys()).wrapPublicKey;
		const patientDek = await clinic.mintDek(clinicPub);
		const consultDek = await clinic.mintDek(clinicPub);
		const a = api({ "1": patientDek.envelope, "10": consultDek.envelope });
		const granted = await grantPortalAccess(clinic, a, {
			patientId: 1,
			consultationIds: [10, 11],
			readers: [{ readerId: "ana", wrapPublicKey: portalPub }],
		});
		expect(granted).toBe(2);
		// Both entities granted with readerKind "patient" envelopes the
		// portal device can unwrap back to the record DEK.
		const calls = (a.grant as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.map((c) => c[0])).toEqual([
			{ entityType: "patient", entityId: 1, grants: expect.any(Array) },
			{ entityType: "consultation", entityId: 10, grants: expect.any(Array) },
		]);
		const [patientGrant] = calls[0]![0].grants;
		expect(patientGrant.readerKind).toBe("patient");
		expect(patientGrant.readerPubkey).toBe(portalPub);
		expect(patientGrant.wrappedDek).toMatch(/^w1\./);
		const unwrapped = await portal.unwrapKey(patientGrant.wrappedDek);
		expect(new Uint8Array(await exportDek(unwrapped))).toEqual(
			new Uint8Array(await exportDek(patientDek.dek)),
		);
		// Consultation 11 had no envelope → skipped.
		expect(a.dekEnvelopes).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "consultation", entityIds: [10, 11] }),
		);
	});

	it("skips records this device cannot unwrap and grants it cannot write", async () => {
		const clinic = keyring();
		const portal = keyring();
		const { wrapPublicKey: portalPub } = await portal.deviceKeys();
		const consult = await clinic.mintDek((await clinic.deviceKeys()).wrapPublicKey);
		const a = api({ "1": "w1.bogus", "10": consult.envelope }, { ok: false });
		const granted = await grantPortalAccess(clinic, a, {
			patientId: 1,
			consultationIds: [10],
			readers: [{ readerId: "ana", wrapPublicKey: portalPub }],
		});
		expect(granted).toBe(0);
		// The patient grant never got past the unwrap; the consultation
		// grant was attempted but the write failed.
		expect(a.grant).toHaveBeenCalledTimes(1);
	});
});
