import type { ConsultationDetailApi, NewConsultationApi } from "./views/index.ts";
import { invitePatientFn, patientLinksFn, portalReadersFn } from "@ktb/patient-access/fns";
import { createPatientFn, listPatientsFn } from "@ktb/patients/fns";
import { vaultDekEnvelopesFn, vaultDevicesFn, vaultGrantAccessFn } from "@ktb/vault/fns";
import type { ConsultationZkApi } from "./zk.ts";
import {
	approveAnamnesisFn,
	attachAnamnesisFn,
	deferConsultationFn,
	extractAnamnesisFn,
	getConsultationFn,
	getLiveConsultationFn,
	nextPendingReviewFn,
	recordConsentFn,
	reviewTranscriptFn,
	saveConsultationFn,
	verifyConsultationIntegrityFn,
} from "./fns.ts";

/**
 * View-facing API adapters for the consultations route modules: the
 * views speak small interfaces; these bind them to this plugin's server
 * fns (patient fns come from the patients plugin, portal access from the
 * patient-access plugin — same runtime registry). Kept in one module so
 * the wiring is testable without a router.
 */
export const consultationDetailApi: ConsultationDetailApi = {
	getConsultation: (input: { data: number }) => getConsultationFn(input),
	verifyIntegrity: (input: { data: number }) => verifyConsultationIntegrityFn(input),
	reviewTranscript: (input: { data: number }) => reviewTranscriptFn(input),
	approveAnamnesis: (input: { data: number }) => approveAnamnesisFn(input),
	deferConsultation: (input) => deferConsultationFn({ data: input.data }),
	nextPendingReview: (input: { data: number }) => nextPendingReviewFn(input),
};

export const newConsultationApi: NewConsultationApi = {
	getLiveConsultation: (input: { data: number }) => getLiveConsultationFn(input),
	extractAnamnesis: (input: { data: { transcript: string; patientId?: number } }) =>
		extractAnamnesisFn(input),
	attachAnamnesis: (input: { data: unknown }) => attachAnamnesisFn(input as never),
	saveConsultation: (input: { data: unknown }) => saveConsultationFn(input as never),
	recordConsent: (input: { data: number }) => recordConsentFn(input),
	createPatient: (input: { data: { name: string; birthDate: string } }) => createPatientFn(input),
	getConsultation: (input: { data: number }) => getConsultationFn(input),
	patientAccess: async (input: { data: number }) => {
		const record = await patientLinksFn(input);
		if (!record) return null;
		return {
			email: record.patient.email,
			// An invite still waiting to be claimed counts: the patient was
			// already told how to get in.
			hasAccess: record.links.some((l) => l.status === "active" || l.status === "invited"),
		};
	},
	// The access email goes to the patient themself — guardians are
	// invited from the patient's portal-access page.
	invitePatient: async (input: { data: { patientId: number; email: string } }) => {
		const res = await invitePatientFn({ data: { ...input.data, relation: "self" } });
		return res.ok ? { ok: true as const, emailed: res.emailed } : res;
	},
	// T-148: save wraps the record DEK to the patient's portal devices.
	portalReaders: (input: { data: number }) => portalReadersFn(input),
};

/**
 * ZK surface for the doctor views (T-145): device listing, own DEK
 * envelopes and grant writes — all bound-tenant scoped inside the
 * vault fns. Identical shape to `patientsZkApi`; only ever receives
 * pubkeys/`w1.` envelopes.
 */
export const consultationsZkApi: ConsultationZkApi = {
	devices: () => vaultDevicesFn(),
	dekEnvelopes: (input) => vaultDekEnvelopesFn({ data: input }),
	grant: async (input) => vaultGrantAccessFn({ data: input }),
};

/** Loader data for /consultations/new — the patient picker list. */
export const newConsultationLoader = () => listPatientsFn();

/** `?patientId=` preselects the patient ("New consultation" from the record page). */
export const validateNewConsultationSearch = (search: Record<string, unknown>) => {
	const id = Number(search.patientId);
	return Number.isInteger(id) && id > 0 ? { patientId: id } : {};
};
