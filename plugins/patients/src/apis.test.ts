import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createPatientFn: vi.fn(async (arg: unknown) => ({ tag: "create", arg })),
	updatePatientFn: vi.fn(async (arg: unknown) => ({ tag: "update", arg })),
	deletePatientFn: vi.fn(async (arg: unknown) => ({ tag: "delete", arg })),
	patientDeletionImpactFn: vi.fn(async (arg: unknown) => ({ tag: "impact", arg })),
	vaultDevicesFn: vi.fn(async () => [{ wrapPublicKey: "pub", status: "approved" }]),
	vaultDekEnvelopesFn: vi.fn(async (arg: unknown) => ({ tag: "envelopes", arg })),
	vaultGrantAccessFn: vi.fn(async (arg: unknown) => ({ ok: true, tag: "grant", arg })),
}));

vi.mock("./fns.ts", () => ({
	createPatientFn: mocks.createPatientFn,
	updatePatientFn: mocks.updatePatientFn,
	deletePatientFn: mocks.deletePatientFn,
	patientDeletionImpactFn: mocks.patientDeletionImpactFn,
}));
vi.mock("@ktb/vault/fns", () => ({
	vaultDevicesFn: mocks.vaultDevicesFn,
	vaultDekEnvelopesFn: mocks.vaultDekEnvelopesFn,
	vaultGrantAccessFn: mocks.vaultGrantAccessFn,
}));

import { editPatientApi, newPatientApi, patientDeleteApi, patientsZkApi } from "./apis.ts";

describe("view api adapters", () => {
	it("newPatientApi.save posts the draft to createPatientFn", async () => {
		await expect(newPatientApi.save({ name: "Ana" })).resolves.toEqual({
			tag: "create",
			arg: { data: { name: "Ana" } },
		});
	});

	it("editPatientApi.save posts the draft + id to updatePatientFn", async () => {
		await expect(editPatientApi(7).save({ name: "Ana" })).resolves.toEqual({
			tag: "update",
			arg: { data: { name: "Ana", id: 7 } },
		});
	});

	it("patientDeleteApi wires impact + remove", async () => {
		await expect(patientDeleteApi.impact(3)).resolves.toEqual({ tag: "impact", arg: { data: 3 } });
		await expect(patientDeleteApi.remove(3)).resolves.toEqual({ tag: "delete", arg: { data: 3 } });
	});
});

describe("patientsZkApi", () => {
	it("lists vault devices", async () => {
		await expect(patientsZkApi.devices()).resolves.toEqual([
			{ wrapPublicKey: "pub", status: "approved" },
		]);
	});

	it("forwards the envelope batch to vaultDekEnvelopesFn", async () => {
		const input = { entityType: "patient", entityIds: [1, 2], wrapPublicKey: "pub" };
		await patientsZkApi.dekEnvelopes(input);
		expect(mocks.vaultDekEnvelopesFn).toHaveBeenCalledWith({ data: input });
	});

	it("forwards grants to vaultGrantAccessFn", async () => {
		const input = {
			entityType: "patient",
			entityId: 1,
			grants: [{ readerKind: "device" as const, readerPubkey: "p", wrappedDek: "w1.x" }],
		};
		await patientsZkApi.grant(input);
		expect(mocks.vaultGrantAccessFn).toHaveBeenCalledWith({ data: input });
	});
});
