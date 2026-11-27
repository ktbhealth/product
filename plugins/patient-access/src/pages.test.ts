import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import type { Page } from "@ktb/kernel";

import { patientAccessPagesPlugin, PatientLinks } from "./index.ts";

const DOCTOR_BASE = "/portal/doctor/patient-access";
const SECRETARY_BASE = "/portal/secretary/patient-access";

const page = (id: string): Page => {
	const found = patientAccessPagesPlugin.pages?.find((p) => p.id === id);
	if (found === undefined) throw new Error(`no page ${id}`);
	return found as Page;
};

const DDL = `
INSERT INTO patients (id, owner_id, name, email, created_at) VALUES
  (1, 'doc', 'Ana', 'ana@ktb.test', 0), (2, 'doc', 'Leo', NULL, 0), (3, 'other', 'Rui', 'rui@ktb.test', 0);
`;
const db = makeDb(makeTestD1(DDL));

const links = [
	{ id: 2, email: "ana@ktb.test", relation: "self", status: "active", source: "invite" },
];
const denied = Effect.fail(new Forbidden({ path: "patient-access.read" }));
const linksLayer = (impl: unknown) =>
	Layer.succeed(PatientLinks, {
		list: impl,
		invite: vi.fn(),
		approve: vi.fn(),
		revoke: vi.fn(),
	} as never);

const run = (
	effect: Effect.Effect<unknown, unknown, unknown>,
	opts: { principal?: { userId: string } | null; layer?: Layer.Layer<never, never, never> } = {},
) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(opts.layer ?? Layer.empty),
			Effect.provideService(Db, db),
			Effect.provideService(Principal, opts.principal ?? null),
		) as Effect.Effect<unknown>,
	);

const DOCTOR = { userId: "doc" };

describe("patient-access.pages guard", () => {
	const g = page("patient-access.doctor.record").guard!;

	it("admits a shaped id path under the principal", async () => {
		await expect(run(g(`${DOCTOR_BASE}/1`), { principal: DOCTOR })).resolves.toBe(true);
	});

	it("rejects malformed subpaths without touching services", async () => {
		for (const path of [`${DOCTOR_BASE}/abc`, `${DOCTOR_BASE}/0`, `${DOCTOR_BASE}/1/extra`]) {
			await expect(run(g(path), { principal: DOCTOR })).resolves.toBe(false);
		}
	});

	it("rejects a shaped id path without a principal", async () => {
		await expect(run(g(`${DOCTOR_BASE}/1`), { principal: null })).resolves.toBe(false);
	});
});

describe("patient-access.pages loader", () => {
	const l = page("patient-access.doctor.record").loader!;
	const listing = linksLayer(() => Effect.succeed(links));

	it("resolves the patient and its portal links", async () => {
		await expect(
			run(l(`${DOCTOR_BASE}/1`), { principal: DOCTOR, layer: listing }),
		).resolves.toEqual({
			view: "detail",
			patient: { id: 1, name: "Ana", email: "ana@ktb.test" },
			links,
		});
	});

	it("collapses a missing principal and invalid shapes to missing", async () => {
		await expect(run(l(`${DOCTOR_BASE}/1`), { principal: null, layer: listing })).resolves.toEqual({
			view: "missing",
		});
		for (const path of [`${DOCTOR_BASE}/abc`, `${DOCTOR_BASE}/0`, `${DOCTOR_BASE}/1/extra`]) {
			await expect(run(l(path), { principal: DOCTOR, layer: listing })).resolves.toEqual({
				view: "missing",
			});
		}
	});

	it("collapses a forbidden list to missing", async () => {
		await expect(
			run(l(`${DOCTOR_BASE}/1`), {
				principal: DOCTOR,
				layer: linksLayer(() => denied),
			}),
		).resolves.toEqual({ view: "missing" });
	});

	it("collapses a patient that is not the principal's to missing", async () => {
		await expect(
			run(l(`${DOCTOR_BASE}/3`), { principal: DOCTOR, layer: listing }),
		).resolves.toEqual({ view: "missing" });
	});

	it("serves the secretary instance under the same loader", async () => {
		const secretary = page("patient-access.secretary.record").loader!;
		await expect(
			run(secretary(`${SECRETARY_BASE}/1`), { principal: DOCTOR, layer: listing }),
		).resolves.toMatchObject({ view: "detail", patient: { id: 1 } });
	});
});
