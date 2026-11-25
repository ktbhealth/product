import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	patientLinksFn: vi.fn(),
	invitePatientFn: vi.fn(),
	portalReadersFn: vi.fn(),
	getConsultationFn: vi.fn(),
	createPatientFn: vi.fn(),
	listPatientsFn: vi.fn(),
	vaultDevicesFn: vi.fn(),
	vaultDekEnvelopesFn: vi.fn(),
	vaultGrantAccessFn: vi.fn(),
}));

vi.mock("@ktb/patient-access/fns", () => ({
	patientLinksFn: mocks.patientLinksFn,
	invitePatientFn: mocks.invitePatientFn,
	portalReadersFn: mocks.portalReadersFn,
}));
vi.mock("@ktb/patients/fns", () => ({
	createPatientFn: mocks.createPatientFn,
	listPatientsFn: mocks.listPatientsFn,
}));
vi.mock("@ktb/vault/fns", () => ({
	vaultDevicesFn: mocks.vaultDevicesFn,
	vaultDekEnvelopesFn: mocks.vaultDekEnvelopesFn,
	vaultGrantAccessFn: mocks.vaultGrantAccessFn,
}));
vi.mock("./fns.ts", () => ({
	approveAnamnesisFn: vi.fn(),
	attachAnamnesisFn: vi.fn(),
	deferConsultationFn: vi.fn(),
	extractAnamnesisFn: vi.fn(),
	getConsultationFn: mocks.getConsultationFn,
	getLiveConsultationFn: vi.fn(),
	nextPendingReviewFn: vi.fn(),
	recordConsentFn: vi.fn(),
	reviewTranscriptFn: vi.fn(),
	saveConsultationFn: vi.fn(),
	verifyConsultationIntegrityFn: vi.fn(),
}));

import {
	consultationDetailApi,
	consultationsZkApi,
	newConsultationApi,
	newConsultationLoader,
	validateNewConsultationSearch,
} from "./apis.ts";

const patient = { id: 1, name: "Maria", email: "maria@ktb.test" };
const link = (status: string) => ({ id: 7, email: "maria@ktb.test", status });

beforeEach(() => vi.clearAllMocks());

describe("getConsultation delegation", () => {
	it("newConsultationApi delegates getConsultation to the server fn", async () => {
		mocks.getConsultationFn.mockResolvedValue({ id: 3 });
		await expect(newConsultationApi.getConsultation!({ data: 3 })).resolves.toEqual({ id: 3 });
		expect(mocks.getConsultationFn).toHaveBeenCalledWith({ data: 3 });
	});

	it("consultationDetailApi delegates getConsultation to the server fn", async () => {
		mocks.getConsultationFn.mockResolvedValue({ id: 5 });
		await expect(consultationDetailApi.getConsultation!({ data: 5 })).resolves.toEqual({ id: 5 });
		expect(mocks.getConsultationFn).toHaveBeenCalledWith({ data: 5 });
	});
});

describe("newConsultationApi.patientAccess", () => {
	const standing = () => newConsultationApi.patientAccess!({ data: 1 });

	it("reports the record's email and no access for a patient with no links", async () => {
		mocks.patientLinksFn.mockResolvedValue({ patient, links: [] });
		await expect(standing()).resolves.toEqual({ email: "maria@ktb.test", hasAccess: false });
		expect(mocks.patientLinksFn).toHaveBeenCalledWith({ data: 1 });
	});

	it.each(["active", "invited"])("counts an %s link as access", async (status) => {
		mocks.patientLinksFn.mockResolvedValue({ patient, links: [link("pending"), link(status)] });
		await expect(standing()).resolves.toMatchObject({ hasAccess: true });
	});

	it("does not count a CPF match still awaiting the doctor's approval", async () => {
		mocks.patientLinksFn.mockResolvedValue({
			patient: { ...patient, email: null },
			links: [link("pending")],
		});
		await expect(standing()).resolves.toEqual({ email: null, hasAccess: false });
	});

	it("is null for a patient the acting doctor may not see", async () => {
		mocks.patientLinksFn.mockResolvedValue(null);
		await expect(standing()).resolves.toBeNull();
	});
});

describe("newConsultationApi.invitePatient", () => {
	const invite = () =>
		newConsultationApi.invitePatient!({ data: { patientId: 1, email: "maria@ktb.test" } });

	it("invites the patient themself and reports whether the email went out", async () => {
		mocks.invitePatientFn.mockResolvedValue({ ok: true, link: link("invited"), emailed: true });
		await expect(invite()).resolves.toEqual({ ok: true, emailed: true });
		expect(mocks.invitePatientFn).toHaveBeenCalledWith({
			data: { patientId: 1, email: "maria@ktb.test", relation: "self" },
		});
		mocks.invitePatientFn.mockResolvedValue({ ok: true, link: link("invited"), emailed: false });
		await expect(invite()).resolves.toEqual({ ok: true, emailed: false });
	});

	it("passes a refusal through", async () => {
		mocks.invitePatientFn.mockResolvedValue({ ok: false, error: "invalid_email" });
		await expect(invite()).resolves.toEqual({ ok: false, error: "invalid_email" });
	});
});

describe("validateNewConsultationSearch", () => {
	it("keeps a positive integer patientId and drops anything else", () => {
		expect(validateNewConsultationSearch({ patientId: "4" })).toEqual({ patientId: 4 });
		expect(validateNewConsultationSearch({ patientId: "x" })).toEqual({});
		expect(validateNewConsultationSearch({ patientId: 0 })).toEqual({});
		expect(validateNewConsultationSearch({})).toEqual({});
	});
});

describe("api delegates forward to the server fns", () => {
	it("binds every view method to its fn", async () => {
		const fns = await import("./fns.ts");
		const patients = await import("@ktb/patients/fns");
		await consultationDetailApi.getConsultation({ data: 1 });
		expect(fns.getConsultationFn).toHaveBeenCalledWith({ data: 1 });
		await consultationDetailApi.verifyIntegrity!({ data: 2 });
		expect(fns.verifyConsultationIntegrityFn).toHaveBeenCalledWith({ data: 2 });
		await newConsultationApi.getLiveConsultation({ data: 3 });
		expect(fns.getLiveConsultationFn).toHaveBeenCalledWith({ data: 3 });
		await newConsultationApi.extractAnamnesis({ data: { transcript: "t" } });
		expect(fns.extractAnamnesisFn).toHaveBeenCalledWith({ data: { transcript: "t" } });
		await newConsultationApi.attachAnamnesis({
			data: { consultationId: 1, anamnesis: "v1.x", engine: "e" },
		});
		expect(fns.attachAnamnesisFn).toHaveBeenCalledWith({
			data: { consultationId: 1, anamnesis: "v1.x", engine: "e" },
		});
		await newConsultationApi.saveConsultation({ data: { patientId: 1 } });
		expect(fns.saveConsultationFn).toHaveBeenCalledWith({ data: { patientId: 1 } });
		await newConsultationApi.recordConsent({ data: 4 });
		expect(fns.recordConsentFn).toHaveBeenCalledWith({ data: 4 });
		await newConsultationApi.createPatient({ data: { name: "n", birthDate: "2000-01-01" } });
		expect(patients.createPatientFn).toHaveBeenCalledWith({
			data: { name: "n", birthDate: "2000-01-01" },
		});
		await newConsultationApi.getConsultation!({ data: 5 });
		expect(fns.getConsultationFn).toHaveBeenCalledWith({ data: 5 });
		await newConsultationApi.portalReaders!({ data: 6 });
		expect(mocks.portalReadersFn).toHaveBeenCalledWith({ data: 6 });
		await consultationDetailApi.reviewTranscript!({ data: 7 });
		expect(fns.reviewTranscriptFn).toHaveBeenCalledWith({ data: 7 });
		await consultationDetailApi.approveAnamnesis!({ data: 8 });
		expect(fns.approveAnamnesisFn).toHaveBeenCalledWith({ data: 8 });
		const until = new Date("2030-01-15T00:00:00Z");
		await consultationDetailApi.deferConsultation!({ data: { id: 9, until } });
		expect(fns.deferConsultationFn).toHaveBeenCalledWith({ data: { id: 9, until } });
		await consultationDetailApi.nextPendingReview!({ data: 10 });
		expect(fns.nextPendingReviewFn).toHaveBeenCalledWith({ data: 10 });
	});
});

describe("consultationsZkApi", () => {
	it("binds the vault device/envelope/grant fns", async () => {
		mocks.vaultDevicesFn.mockResolvedValue([{ id: "dev-1" }]);
		mocks.vaultDekEnvelopesFn.mockResolvedValue({ "10": "w1.x" });
		mocks.vaultGrantAccessFn.mockResolvedValue({ ok: true });
		await expect(consultationsZkApi.devices()).resolves.toEqual([{ id: "dev-1" }]);
		expect(mocks.vaultDevicesFn).toHaveBeenCalledWith();
		await expect(
			consultationsZkApi.dekEnvelopes({
				entityType: "consultation",
				entityIds: [10],
				wrapPublicKey: "dev",
			}),
		).resolves.toEqual({ "10": "w1.x" });
		expect(mocks.vaultDekEnvelopesFn).toHaveBeenCalledWith({
			data: {
				entityType: "consultation",
				entityIds: [10],
				wrapPublicKey: "dev",
			},
		});
		await expect(
			consultationsZkApi.grant({
				entityType: "consultation",
				entityId: 10,
				grants: [{ readerKind: "patient", readerPubkey: "p", wrappedDek: "w1.y" }],
			}),
		).resolves.toEqual({ ok: true });
		expect(mocks.vaultGrantAccessFn).toHaveBeenCalledWith({
			data: {
				entityType: "consultation",
				entityId: 10,
				grants: [{ readerKind: "patient", readerPubkey: "p", wrappedDek: "w1.y" }],
			},
		});
	});
});

describe("newConsultationLoader", () => {
	it("lists the patients for the picker", async () => {
		mocks.listPatientsFn.mockResolvedValue([{ id: 1, name: "Maria" }]);
		await expect(newConsultationLoader()).resolves.toEqual([{ id: 1, name: "Maria" }]);
		expect(mocks.listPatientsFn).toHaveBeenCalledWith();
	});
});
