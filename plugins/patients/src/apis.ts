import { vaultDekEnvelopesFn, vaultDevicesFn, vaultGrantAccessFn } from "@ktb/vault/fns";

import type { PatientDeleteApi, PatientFormApi } from "./views/index.ts";
import type { PatientZkApi } from "./zk.ts";
import {
	createPatientFn,
	deletePatientFn,
	patientDeletionImpactFn,
	updatePatientFn,
} from "./fns.ts";

/**
 * View-facing API adapters for the patients route modules (P-033): the
 * views speak small interfaces; these bind them to this plugin's server
 * fns. Kept in one module so the wiring is testable without a router.
 */
export const newPatientApi: PatientFormApi = {
	save: (draft) => createPatientFn({ data: draft }),
};

export const editPatientApi = (id: number): PatientFormApi => ({
	save: (draft) => updatePatientFn({ data: { ...draft, id } }),
});

/** Patient deletion (impact preview + cascade) wired to the server fns. */
export const patientDeleteApi: PatientDeleteApi = {
	impact: (id) => patientDeletionImpactFn({ data: id }),
	remove: (id) => deletePatientFn({ data: id }),
};

/**
 * ZK surface for the doctor views (T-144): device listing, own DEK
 * envelopes and grant writes — all bound-tenant scoped inside the
 * vault fns. Only ever receives pubkeys/`w1.` envelopes.
 */
export const patientsZkApi: PatientZkApi = {
	devices: () => vaultDevicesFn(),
	dekEnvelopes: (input) => vaultDekEnvelopesFn({ data: input }),
	grant: async (input) => vaultGrantAccessFn({ data: input }),
};
