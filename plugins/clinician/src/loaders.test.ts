import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Query } from "@effect-server-utils/cqrs";

import { Forbidden, Principal } from "@ktb/authz";
import { Audit } from "@ktb/audit";
import { Consultations } from "@ktb/consultations";
import type { Page } from "@ktb/kernel";
import { Patients } from "@ktb/patients";
import { PatientRecordConsultationsQueries } from "@ktb/patients/api";

import { clinicianPagesPlugin } from "./index.ts";

const PATIENTS_PREFIX = "/portal/doctor/patients";
const CONSULTATIONS_PREFIX = "/portal/doctor/consultations";

const page = (id: string): Page => {
	const found = clinicianPagesPlugin.pages?.find((p) => p.id === id);
	if (found === undefined) throw new Error(`no page ${id}`);
	return found as Page;
};

const guard = (id: string): ((path: string) => Effect.Effect<boolean, unknown, unknown>) => {
	const found = page(id).guard;
	if (found === undefined) throw new Error(`page ${id} has no guard`);
	return found;
};

const loader = (id: string): ((path: string) => Effect.Effect<unknown, unknown, unknown>) => {
	const found = page(id).loader;
	if (found === undefined) throw new Error(`page ${id} has no loader`);
	return found as (path: string) => Effect.Effect<unknown, unknown, unknown>;
};

const forbidden = () => Effect.fail(new Forbidden({ path: "test" }));

const patientsLayer = (impl: Record<string, unknown> = {}) =>
	Layer.succeed(Patients, {
		list: () => Effect.succeed([]),
		get: () => Effect.succeed(null),
		...impl,
	} as never);

const consultationsLayer = (impl: Record<string, unknown> = {}) =>
	Layer.succeed(Consultations, {
		list: () => Effect.succeed([]),
		get: () => Effect.succeed(null),
		history: () => Effect.succeed(null),
		...impl,
	} as never);

/** Stub Audit port for the activity page — absent layer means the
 * audit plugin is disabled (serviceOption → None). */
const auditLayer = (impl: Record<string, unknown> = {}) =>
	Layer.succeed(Audit, {
		activityAccess: () => Effect.succeed(false),
		activityList: () => Effect.succeed({ entries: [], total: 0, limit: 200, offset: 0 }),
		...impl,
	} as never) as unknown as Layer.Layer<never, never, never>;

const recordConsultationsLayer = (rows: readonly unknown[] = []) =>
	Query.handlersOf(PatientRecordConsultationsQueries, {
		"patients.recordConsultations": () => Effect.succeed([...rows] as never),
	});

const run = (
	effect: Effect.Effect<unknown, unknown, unknown>,
	opts: {
		principal?: { userId: string } | null;
		layer?: Layer.Layer<never, never, never>;
	} = {},
) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(opts.layer ?? Layer.empty),
			Effect.provideService(Principal, opts.principal ?? null),
		) as Effect.Effect<unknown>,
	);

const DOCTOR = { userId: "u1" };

describe("clinician.pages list loaders", () => {
	it("patients loader returns [] without a principal", async () => {
		await expect(
			run(loader("clinician.doctor.patients")("/portal/doctor/patients"), {
				principal: null,
				layer: patientsLayer(),
			}),
		).resolves.toEqual([]);
	});

	it("patients loader lists the principal's patients", async () => {
		const rows = [{ id: 1, name: "Ana" }];
		await expect(
			run(loader("clinician.doctor.patients")("/portal/doctor/patients"), {
				principal: DOCTOR,
				layer: patientsLayer({ list: () => Effect.succeed(rows) }),
			}),
		).resolves.toEqual(rows);
	});

	it("patients loader collapses Forbidden to an empty list", async () => {
		await expect(
			run(loader("clinician.doctor.patients")("/portal/doctor/patients"), {
				principal: DOCTOR,
				layer: patientsLayer({ list: forbidden }),
			}),
		).resolves.toEqual([]);
	});

	it("consultations loader returns [] without a principal", async () => {
		await expect(
			run(loader("clinician.doctor.consultations")("/portal/doctor/consultations"), {
				principal: null,
				layer: consultationsLayer(),
			}),
		).resolves.toEqual([]);
	});

	it("consultations loader lists the principal's consultations", async () => {
		const rows = [{ id: 2 }];
		await expect(
			run(loader("clinician.doctor.consultations")("/portal/doctor/consultations"), {
				principal: DOCTOR,
				layer: consultationsLayer({ list: () => Effect.succeed(rows) }),
			}),
		).resolves.toEqual(rows);
	});

	it("consultations loader collapses Forbidden to an empty list", async () => {
		await expect(
			run(loader("clinician.doctor.consultations")("/portal/doctor/consultations"), {
				principal: DOCTOR,
				layer: consultationsLayer({ list: forbidden }),
			}),
		).resolves.toEqual([]);
	});

	it("the secretary instance mounts the same shared loaders", async () => {
		const rows = [{ id: 1, name: "Ana" }];
		await expect(
			run(loader("clinician.secretary.patients")("/portal/secretary/patients"), {
				principal: DOCTOR,
				layer: patientsLayer({ list: () => Effect.succeed(rows) }),
			}),
		).resolves.toEqual(rows);
	});
});

describe("clinician.patients.record guard", () => {
	const g = guard("clinician.doctor.patients.record");
	const patient = { id: 5, name: "Ana" };
	const withPatient = patientsLayer({ get: () => Effect.succeed(patient) });

	it("admits the /new subpath without touching services", async () => {
		await expect(run(g(`${PATIENTS_PREFIX}/new`))).resolves.toBe(true);
	});

	it("rejects malformed subpaths before reading services", async () => {
		for (const path of [
			`${PATIENTS_PREFIX}/new/edit`,
			`${PATIENTS_PREFIX}/abc`,
			`${PATIENTS_PREFIX}/0`,
			`${PATIENTS_PREFIX}/5/foo`,
			`${PATIENTS_PREFIX}/5/edit/extra`,
		]) {
			await expect(run(g(path), { principal: DOCTOR, layer: Layer.empty })).resolves.toBe(false);
		}
	});

	it("rejects a shaped id path without a principal", async () => {
		await expect(
			run(g(`${PATIENTS_PREFIX}/5`), { principal: null, layer: withPatient }),
		).resolves.toBe(false);
	});

	it("admits existing patients on detail and edit subpaths", async () => {
		for (const path of [`${PATIENTS_PREFIX}/5`, `${PATIENTS_PREFIX}/5/edit`]) {
			await expect(run(g(path), { principal: DOCTOR, layer: withPatient })).resolves.toBe(true);
		}
	});

	it("rejects missing or forbidden patients", async () => {
		await expect(
			run(g(`${PATIENTS_PREFIX}/5`), {
				principal: DOCTOR,
				layer: patientsLayer(),
			}),
		).resolves.toBe(false);
		await expect(
			run(g(`${PATIENTS_PREFIX}/5`), {
				principal: DOCTOR,
				layer: patientsLayer({ get: forbidden }),
			}),
		).resolves.toBe(false);
	});
});

describe("clinician.patients.record loader", () => {
	const l = loader("clinician.doctor.patients.record");
	const patient = { id: 5, name: "Ana" };
	const withPatient = patientsLayer({ get: () => Effect.succeed(patient) });

	it("resolves the /new subpath to the new-patient view", async () => {
		await expect(run(l(`${PATIENTS_PREFIX}/new`))).resolves.toEqual({ view: "new" });
	});

	it("collapses invalid shapes and a missing principal to missing", async () => {
		await expect(
			run(l(`${PATIENTS_PREFIX}/5`), { principal: null, layer: withPatient }),
		).resolves.toEqual({ view: "missing" });
		for (const path of [
			`${PATIENTS_PREFIX}/new/edit`,
			`${PATIENTS_PREFIX}/abc`,
			`${PATIENTS_PREFIX}/0`,
			`${PATIENTS_PREFIX}/5/foo`,
			`${PATIENTS_PREFIX}/5/edit/extra`,
		]) {
			await expect(run(l(path), { principal: DOCTOR, layer: Layer.empty })).resolves.toEqual({
				view: "missing",
			});
		}
	});

	it("collapses missing or forbidden patients to missing", async () => {
		await expect(
			run(l(`${PATIENTS_PREFIX}/5`), { principal: DOCTOR, layer: patientsLayer() }),
		).resolves.toEqual({ view: "missing" });
		await expect(
			run(l(`${PATIENTS_PREFIX}/5`), {
				principal: DOCTOR,
				layer: patientsLayer({ get: forbidden }),
			}),
		).resolves.toEqual({ view: "missing" });
	});

	it("resolves the edit subpath without dispatching record consultations", async () => {
		await expect(
			run(l(`${PATIENTS_PREFIX}/5/edit`), { principal: DOCTOR, layer: withPatient }),
		).resolves.toEqual({ view: "edit", patient });
	});

	it("resolves the detail subpath with the record consultations", async () => {
		const consultations = [{ id: 9, patientId: 5 }];
		await expect(
			run(l(`${PATIENTS_PREFIX}/5`), {
				principal: DOCTOR,
				layer: Layer.mergeAll(withPatient, recordConsultationsLayer(consultations)),
			}),
		).resolves.toEqual({ view: "detail", patient, consultations });
	});
});

describe("clinician.consultations.record guard", () => {
	const g = guard("clinician.doctor.consultations.record");
	const consultation = { id: 5, patientId: null };
	const withConsultation = consultationsLayer({ get: () => Effect.succeed(consultation) });

	it("admits the /new subpath without touching services", async () => {
		await expect(run(g(`${CONSULTATIONS_PREFIX}/new`))).resolves.toBe(true);
	});

	it("rejects malformed subpaths before reading services", async () => {
		for (const path of [
			`${CONSULTATIONS_PREFIX}/new/x`,
			`${CONSULTATIONS_PREFIX}/5/x`,
			`${CONSULTATIONS_PREFIX}/abc`,
			`${CONSULTATIONS_PREFIX}/0`,
		]) {
			await expect(run(g(path), { principal: DOCTOR, layer: Layer.empty })).resolves.toBe(false);
		}
	});

	it("rejects a shaped id path without a principal", async () => {
		await expect(
			run(g(`${CONSULTATIONS_PREFIX}/5`), { principal: null, layer: withConsultation }),
		).resolves.toBe(false);
	});

	it("admits an existing consultation", async () => {
		await expect(
			run(g(`${CONSULTATIONS_PREFIX}/5`), { principal: DOCTOR, layer: withConsultation }),
		).resolves.toBe(true);
	});

	it("admits the /record subpath of an existing consultation only", async () => {
		await expect(
			run(g(`${CONSULTATIONS_PREFIX}/5/record`), { principal: DOCTOR, layer: withConsultation }),
		).resolves.toBe(true);
		await expect(
			run(g(`${CONSULTATIONS_PREFIX}/5/record/x`), { principal: DOCTOR, layer: Layer.empty }),
		).resolves.toBe(false);
		await expect(
			run(g(`${CONSULTATIONS_PREFIX}/5/record`), {
				principal: DOCTOR,
				layer: consultationsLayer(),
			}),
		).resolves.toBe(false);
	});

	it("rejects missing or forbidden consultations", async () => {
		await expect(
			run(g(`${CONSULTATIONS_PREFIX}/5`), { principal: DOCTOR, layer: consultationsLayer() }),
		).resolves.toBe(false);
		await expect(
			run(g(`${CONSULTATIONS_PREFIX}/5`), {
				principal: DOCTOR,
				layer: consultationsLayer({ get: forbidden }),
			}),
		).resolves.toBe(false);
	});
});

describe("clinician.consultations.record loader", () => {
	const l = loader("clinician.doctor.consultations.record");
	const consultation = { id: 5, patientId: null };
	const withConsultation = consultationsLayer({ get: () => Effect.succeed(consultation) });

	it("collapses a missing principal to missing", async () => {
		await expect(run(l(`${CONSULTATIONS_PREFIX}/5`), { principal: null })).resolves.toEqual({
			view: "missing",
		});
	});

	it("resolves the /new subpath with the principal's patients", async () => {
		const patients = [{ id: 1, name: "Ana" }];
		await expect(
			run(l(`${CONSULTATIONS_PREFIX}/new`), {
				principal: DOCTOR,
				layer: patientsLayer({ list: () => Effect.succeed(patients) }),
			}),
		).resolves.toEqual({ view: "new", patients });
	});

	it("collapses a forbidden patient list to an empty picker", async () => {
		await expect(
			run(l(`${CONSULTATIONS_PREFIX}/new`), {
				principal: DOCTOR,
				layer: patientsLayer({ list: forbidden }),
			}),
		).resolves.toEqual({ view: "new", patients: [] });
	});

	it("collapses invalid shapes to missing", async () => {
		for (const path of [
			`${CONSULTATIONS_PREFIX}/new/x`,
			`${CONSULTATIONS_PREFIX}/5/x`,
			`${CONSULTATIONS_PREFIX}/5/record/x`,
			`${CONSULTATIONS_PREFIX}/abc`,
			`${CONSULTATIONS_PREFIX}/0`,
		]) {
			await expect(run(l(path), { principal: DOCTOR, layer: Layer.empty })).resolves.toEqual({
				view: "missing",
			});
		}
	});

	it("collapses missing or forbidden consultations to missing", async () => {
		await expect(
			run(l(`${CONSULTATIONS_PREFIX}/5`), { principal: DOCTOR, layer: consultationsLayer() }),
		).resolves.toEqual({ view: "missing" });
		await expect(
			run(l(`${CONSULTATIONS_PREFIX}/5`), {
				principal: DOCTOR,
				layer: consultationsLayer({ get: forbidden }),
			}),
		).resolves.toEqual({ view: "missing" });
	});

	it("resolves the detail view with history for a linked patient", async () => {
		const c = { id: 5, patientId: 7 };
		const history = { entries: [{ id: 4 }] };
		await expect(
			run(l(`${CONSULTATIONS_PREFIX}/5`), {
				principal: DOCTOR,
				layer: consultationsLayer({
					get: () => Effect.succeed(c),
					history: () => Effect.succeed(history),
				}),
			}),
		).resolves.toEqual({ view: "detail", c, history });
	});

	it("resolves the detail view without history for an unlinked consultation", async () => {
		await expect(
			run(l(`${CONSULTATIONS_PREFIX}/5`), {
				principal: DOCTOR,
				layer: withConsultation,
			}),
		).resolves.toEqual({ view: "detail", c: consultation, history: null });
	});

	it("opens the recording flow on an agenda shell via /record (T-257)", async () => {
		const shell = { id: 5, patientId: 7, status: "live", source: "agenda", anamnesis: null };
		const patients = [{ id: 7, name: "Ana" }];
		await expect(
			run(l(`${CONSULTATIONS_PREFIX}/5/record`), {
				principal: DOCTOR,
				layer: Layer.mergeAll(
					consultationsLayer({ get: () => Effect.succeed(shell) }),
					patientsLayer({ list: () => Effect.succeed(patients) }),
				),
			}),
		).resolves.toEqual({
			view: "new",
			patients,
			resume: { consultationId: 5, patientId: 7 },
		});
		// A forbidden patient list still opens the flow, with an empty picker.
		await expect(
			run(l(`${CONSULTATIONS_PREFIX}/5/record`), {
				principal: DOCTOR,
				layer: Layer.mergeAll(
					consultationsLayer({ get: () => Effect.succeed(shell) }),
					patientsLayer({ list: forbidden }),
				),
			}),
		).resolves.toMatchObject({ view: "new", patients: [] });
	});

	it("/record falls back to the detail once the record is no longer a fresh shell", async () => {
		for (const c of [
			{ id: 5, patientId: null, status: "done", source: "agenda", anamnesis: null },
			{ id: 5, patientId: null, status: "live", source: "bot", anamnesis: null },
			{ id: 5, patientId: null, status: "live", source: "agenda", anamnesis: { qp: {} } },
		]) {
			await expect(
				run(l(`${CONSULTATIONS_PREFIX}/5/record`), {
					principal: DOCTOR,
					layer: consultationsLayer({ get: () => Effect.succeed(c) }),
				}),
			).resolves.toEqual({ view: "detail", c, history: null });
		}
	});
});

describe("clinician.activity guard", () => {
	const g = guard("clinician.doctor.activity");
	const ACTIVITY_PATH = "/portal/doctor/activity";

	it("denies when the Audit service is absent", async () => {
		await expect(run(g(ACTIVITY_PATH), { principal: DOCTOR, layer: Layer.empty })).resolves.toBe(
			false,
		);
	});

	it("delegates to Audit.activityAccess", async () => {
		for (const allowed of [true, false]) {
			await expect(
				run(g(ACTIVITY_PATH), {
					principal: DOCTOR,
					layer: auditLayer({ activityAccess: () => Effect.succeed(allowed) }),
				}),
			).resolves.toBe(allowed);
		}
	});
});

describe("clinician.activity loader", () => {
	const l = loader("clinician.doctor.activity");
	const ACTIVITY_PATH = "/portal/doctor/activity";
	const EMPTY = { entries: [], total: 0, limit: 200, offset: 0 };

	it("returns an empty page when the Audit service is absent", async () => {
		await expect(run(l(ACTIVITY_PATH), { principal: DOCTOR, layer: Layer.empty })).resolves.toEqual(
			EMPTY,
		);
	});

	it("returns the tenant feed", async () => {
		const result = { entries: [{ id: 1, action: "a.b" }], total: 1, limit: 200 };
		await expect(
			run(l(ACTIVITY_PATH), {
				principal: DOCTOR,
				layer: auditLayer({ activityList: () => Effect.succeed(result) }),
			}),
		).resolves.toEqual(result);
	});

	it("collapses Forbidden to an empty page", async () => {
		await expect(
			run(l(ACTIVITY_PATH), {
				principal: DOCTOR,
				layer: auditLayer({ activityList: forbidden }),
			}),
		).resolves.toEqual(EMPTY);
	});
});
