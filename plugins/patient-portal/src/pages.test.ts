import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const mocks = vi.hoisted(() => ({
	getPatientContext: vi.fn(),
}));

vi.mock("@ktb/server-fns", async (importOriginal) => ({
	...(await importOriginal<typeof import("@ktb/server-fns")>()),
	...mocks,
}));

import { Forbidden } from "@ktb/authz";
import type { Page } from "@ktb/kernel";

import { PatientPortal, patientPortalPagesPlugin } from "./index.ts";

const page = (id: string): Page => {
	const found = patientPortalPagesPlugin.pages?.find((p) => p.id === id);
	if (found === undefined) throw new Error(`no page ${id}`);
	return found;
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

const user = { id: "ana", email: "ana@ktb.test", name: "Ana" };
const me = { patientId: 1, name: "Ana", relation: "self" };
const kid = { patientId: 2, name: "Leo", relation: "guardian" };
const profile = { patientId: 1, relation: "self", name: "Ana", doctorName: "Dra. Bia" };
const listed = [{ id: 10, createdAt: new Date(0), chiefComplaint: "Dor de cabeça" }];
const consultation = {
	id: 10,
	createdAt: new Date(0),
	patientId: 1,
	patientName: "Ana",
	doctorName: "Dra. Bia",
	sections: [{ key: "conduta", content: "Retorno em 15 dias" }],
};

const portalLayer = (impl: Record<string, unknown> = {}) =>
	Layer.succeed(PatientPortal, {
		profile: () => Effect.succeed(profile),
		consultations: () => Effect.succeed(listed),
		consultation: () => Effect.succeed(consultation),
		awaitingInvites: () => Effect.succeed(0),
		...impl,
	} as never);

const denied = Effect.fail(new Forbidden({ path: "portal.read" }));

const run = (
	effect: Effect.Effect<unknown, unknown, unknown>,
	layer: Layer.Layer<never, never, never> = Layer.empty,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<unknown>);

describe("patient-portal.home loader", () => {
	const l = loader("patient-portal.home");
	const path = "/portal/patient";

	it("claims invites first, then loads the open record with its consultations", async () => {
		mocks.getPatientContext.mockResolvedValue({ user, profiles: [me, kid], active: me });
		await expect(run(l(path), portalLayer())).resolves.toEqual({
			view: "home",
			user: { name: "Ana", email: "ana@ktb.test" },
			awaitingInvites: 0,
			profiles: [me, kid],
			profile,
			consultations: listed,
		});
		expect(mocks.getPatientContext).toHaveBeenCalledWith(undefined, { syncLinks: true });
	});

	it("is missing when the request lost its session", async () => {
		mocks.getPatientContext.mockResolvedValue(null);
		await expect(run(l(path), portalLayer())).resolves.toEqual({ view: "missing" });
	});

	it("opens nothing while a profile choice is pending", async () => {
		mocks.getPatientContext.mockResolvedValue({ user, profiles: [me, kid], active: null });
		await expect(run(l(path), portalLayer())).resolves.toEqual({
			view: "home",
			user: { name: "Ana", email: "ana@ktb.test" },
			awaitingInvites: 0,
			profiles: [me, kid],
			profile: null,
			consultations: [],
		});
	});

	it("shows an empty portal when the link was revoked mid-request", async () => {
		mocks.getPatientContext.mockResolvedValue({ user, profiles: [me], active: me });
		await expect(
			run(
				l(path),
				portalLayer({
					profile: () => denied,
					consultations: () => denied,
					awaitingInvites: () => denied,
				}),
			),
		).resolves.toEqual({
			view: "home",
			user: { name: "Ana", email: "ana@ktb.test" },
			awaitingInvites: 0,
			profiles: [],
			profile: null,
			consultations: [],
		});
	});
});

describe("patient-portal.consultation guard", () => {
	const g = guard("patient-portal.consultation");
	const prefix = "/portal/patient/consultations";

	it("admits a consultation the caller may see", async () => {
		await expect(run(g(`${prefix}/10`), portalLayer())).resolves.toBe(true);
	});

	it("rejects malformed subpaths before reading services", async () => {
		for (const path of [`${prefix}/abc`, `${prefix}/0`, `${prefix}/5/x`, `${prefix}/5/6`, prefix]) {
			await expect(run(g(path), portalLayer())).resolves.toBe(false);
		}
	});

	it("rejects a consultation the caller holds no active link to", async () => {
		await expect(run(g(`${prefix}/30`), portalLayer({ consultation: () => denied }))).resolves.toBe(
			false,
		);
	});
});

describe("patient-portal.consultation loader", () => {
	const l = loader("patient-portal.consultation");
	const prefix = "/portal/patient/consultations";

	it("resolves the detail view for a visible consultation", async () => {
		await expect(run(l(`${prefix}/10`), portalLayer())).resolves.toEqual({
			view: "detail",
			consultation,
		});
	});

	it("collapses malformed paths and invisible consultations to missing", async () => {
		for (const path of [`${prefix}/abc`, `${prefix}/0`, `${prefix}/5/x`]) {
			await expect(run(l(path), portalLayer())).resolves.toEqual({ view: "missing" });
		}
		await expect(
			run(l(`${prefix}/30`), portalLayer({ consultation: () => denied })),
		).resolves.toEqual({ view: "missing" });
	});
});
