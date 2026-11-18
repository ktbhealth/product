import { beforeEach, describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	getTenantSelector: vi.fn(),
	runAs: vi.fn(),
}));

// Same fake as the sibling plugin fns tests: handlers run as plain
// async fns; `runAs` executes the Effect for real so the
// serviceOption/Forbidden branches are exercised.
vi.mock("@tanstack/react-start", () => reactStartMock());
vi.mock("@ktb/server-fns", () => ({
	getSessionUser: mocks.getSessionUser,
	getTenantSelector: mocks.getTenantSelector,
	runAs: mocks.runAs,
}));

import { Forbidden } from "@ktb/authz";

import {
	Audit,
	type AuditFacets,
	type AuditListQuery,
	type AuditListResult,
	type AuditVerifyResult,
} from "./index.ts";
import {
	auditActivityFacetsFn,
	auditActivityListFn,
	auditAdminFacetsFn,
	auditAdminListFn,
	auditVerifyFn,
} from "./fns.ts";

const VERIFIED: AuditVerifyResult = { status: "verified", entries: 4, brokenAt: null };

/** Layer providing a stub Audit service; members default to `die` so
 * a fn reaching an unwired method fails loudly. */
const auditLayer = (over: Partial<Audit["Service"]> = {}) =>
	Layer.succeed(Audit, {
		record: () => Effect.void,
		adminList: () => Effect.die("unused"),
		adminVerify: () => Effect.die("unused"),
		adminFacets: () => Effect.die("unused"),
		activityAccess: () => Effect.succeed(false),
		activityList: () => Effect.die("unused"),
		activityFacets: () => Effect.die("unused"),
		patientList: () => Effect.die("unused"),
		patientFacets: () => Effect.die("unused"),
		...over,
	} as never);

describe("auditVerifyFn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSessionUser.mockResolvedValue({ id: "u1", email: "admin@x.com" });
		mocks.runAs.mockImplementation(
			async (_user: unknown, effect: Effect.Effect<AuditVerifyResult | null, unknown, Audit>) =>
				// `serviceOption` tolerates the absent service at runtime;
				// the cast only satisfies runPromise's R=never signature.
				Effect.runPromise(
					effect as Effect.Effect<AuditVerifyResult | null>,
				) as Promise<AuditVerifyResult | null>,
		);
	});

	it("returns null without running anything for anonymous callers", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(auditVerifyFn()).resolves.toBeNull();
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("returns null when the Audit service is absent", async () => {
		await expect(auditVerifyFn()).resolves.toBeNull();
		expect(mocks.runAs).toHaveBeenCalledTimes(1);
	});

	it("returns the verify result through the bound service", async () => {
		const adminVerify = vi.fn(() => Effect.succeed(VERIFIED));
		mocks.runAs.mockImplementationOnce(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<AuditVerifyResult | null, unknown, Audit>,
					auditLayer({ adminVerify }),
				),
			),
		);
		await expect(auditVerifyFn()).resolves.toEqual(VERIFIED);
		expect(adminVerify).toHaveBeenCalledTimes(1);
	});

	it("collapses Forbidden denials to null", async () => {
		mocks.runAs.mockImplementationOnce(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<AuditVerifyResult | null, unknown, Audit>,
					auditLayer({ adminVerify: () => Effect.fail(new Forbidden({ path: "audit.admin" })) }),
				),
			),
		);
		await expect(auditVerifyFn()).resolves.toBeNull();
	});
});

// ---------- filtered/paginated listings ----------

const LIST_EMPTY = { entries: [], total: 0, limit: 200, offset: 0 };
const FACETS_EMPTY: AuditFacets = { actionGroups: [], actors: [], targetTypes: [] };
const PAGE: AuditListResult = {
	entries: [],
	total: 3,
	limit: 50,
	offset: 50,
};
const FACETS: AuditFacets = {
	actionGroups: ["users"],
	actors: ["admin@x.com", null],
	targetTypes: ["user"],
};

/** runAs that executes the Effect against the given Audit layer. */
const runWith = <A, E>(layer: Layer.Layer<Audit>) =>
	mocks.runAs.mockImplementation(
		async (_u: unknown, effect: unknown) =>
			Effect.runPromise(Effect.provide(effect as Effect.Effect<A, E, Audit>, layer)) as Promise<A>,
	);

describe("auditAdminListFn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSessionUser.mockResolvedValue({ id: "u1", email: "admin@x.com" });
	});

	it("returns an empty page for anonymous callers", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(auditAdminListFn({ data: { limit: 50 } })).resolves.toEqual({
			entries: [],
			total: 0,
			limit: 50,
			offset: 0,
		});
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("passes the decoded query through to adminList", async () => {
		const adminList = vi.fn(() => Effect.succeed(PAGE));
		runWith(auditLayer({ adminList: adminList as never }));
		const query: AuditListQuery = {
			limit: 50,
			offset: 50,
			actionGroup: "users",
			actor: null,
			targetType: "user",
			q: "suspend",
			since: 1,
			until: 2,
		};
		await expect(auditAdminListFn({ data: query })).resolves.toEqual(PAGE);
		expect(adminList).toHaveBeenCalledWith(query);
	});

	it("rejects malformed wire input", async () => {
		await expect(auditAdminListFn({ data: { limit: "fifty" } })).rejects.toThrow();
	});

	it("tolerates an absent data payload", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(auditAdminListFn({ data: undefined })).resolves.toEqual(LIST_EMPTY);
		await expect(auditActivityListFn({ data: undefined })).resolves.toEqual(LIST_EMPTY);
	});

	it("collapses Forbidden and a missing Audit service to an empty page", async () => {
		mocks.runAs.mockImplementation(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<AuditListResult, unknown, Audit>,
					auditLayer({
						adminList: () => Effect.fail(new Forbidden({ path: "platform.admin" })),
					}),
				),
			),
		);
		await expect(auditAdminListFn({ data: {} })).resolves.toEqual(LIST_EMPTY);
		// No Audit service at all — serviceOption resolves None.
		mocks.runAs.mockImplementationOnce(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(effect as Effect.Effect<AuditListResult>),
		);
		await expect(auditAdminListFn({ data: {} })).resolves.toEqual(LIST_EMPTY);
	});
});

describe("auditActivityListFn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSessionUser.mockResolvedValue({ id: "u1", email: "staff@x.com" });
		mocks.getTenantSelector.mockResolvedValue({ raw: '{"slug":"clinic-a"}' });
	});

	it("returns an empty page for anonymous callers", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(auditActivityListFn({ data: {} })).resolves.toEqual(LIST_EMPTY);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("forwards the tenant selector and the query to activityList", async () => {
		const activityList = vi.fn(() => Effect.succeed(PAGE));
		runWith(auditLayer({ activityList: activityList as never }));
		await expect(auditActivityListFn({ data: { offset: 50, q: "x" } })).resolves.toEqual(PAGE);
		expect(activityList).toHaveBeenCalledWith({ offset: 50, q: "x" });
		expect(mocks.getTenantSelector).toHaveBeenCalledTimes(1);
		expect(mocks.runAs).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
			raw: '{"slug":"clinic-a"}',
		});
	});

	it("collapses Forbidden and a missing Audit service to an empty page", async () => {
		mocks.runAs.mockImplementation(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<AuditListResult, unknown, Audit>,
					auditLayer({
						activityList: () => Effect.fail(new Forbidden({ path: "rbac.audit.read" })),
					}),
				),
			),
		);
		await expect(auditActivityListFn({ data: {} })).resolves.toEqual(LIST_EMPTY);
		mocks.runAs.mockImplementationOnce(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(effect as Effect.Effect<AuditListResult>),
		);
		await expect(auditActivityListFn({ data: {} })).resolves.toEqual(LIST_EMPTY);
	});
});

describe("audit facets fns", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSessionUser.mockResolvedValue({ id: "u1", email: "admin@x.com" });
		mocks.getTenantSelector.mockResolvedValue(null);
	});

	it("auditAdminFacetsFn returns the admin facets, empty for anonymous", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(auditAdminFacetsFn()).resolves.toEqual(FACETS_EMPTY);
		mocks.getSessionUser.mockResolvedValue({ id: "u1", email: "admin@x.com" });
		const adminFacets = vi.fn(() => Effect.succeed(FACETS));
		runWith(auditLayer({ adminFacets: adminFacets as never }));
		await expect(auditAdminFacetsFn()).resolves.toEqual(FACETS);
		// Forbidden → empty facets, never an error.
		mocks.runAs.mockImplementationOnce(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<AuditFacets, unknown, Audit>,
					auditLayer({
						adminFacets: () => Effect.fail(new Forbidden({ path: "platform.admin" })),
					}),
				),
			),
		);
		await expect(auditAdminFacetsFn()).resolves.toEqual(FACETS_EMPTY);
		mocks.runAs.mockImplementationOnce(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(effect as Effect.Effect<AuditFacets>),
		);
		await expect(auditAdminFacetsFn()).resolves.toEqual(FACETS_EMPTY);
	});

	it("auditActivityFacetsFn forwards the tenant selector", async () => {
		mocks.getTenantSelector.mockResolvedValue({ raw: "x" });
		const activityFacets = vi.fn(() => Effect.succeed(FACETS));
		runWith(auditLayer({ activityFacets: activityFacets as never }));
		await expect(auditActivityFacetsFn()).resolves.toEqual(FACETS);
		expect(mocks.runAs).toHaveBeenCalledWith(expect.anything(), expect.anything(), { raw: "x" });
	});

	it("auditActivityFacetsFn is empty for anonymous, Forbidden and a missing service", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(auditActivityFacetsFn()).resolves.toEqual(FACETS_EMPTY);
		mocks.getSessionUser.mockResolvedValue({ id: "u1", email: "staff@x.com" });
		// Forbidden → empty facets, never an error.
		mocks.runAs.mockImplementationOnce(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<AuditFacets, unknown, Audit>,
					auditLayer({
						activityFacets: () => Effect.fail(new Forbidden({ path: "audit.read" })),
					}),
				),
			),
		);
		await expect(auditActivityFacetsFn()).resolves.toEqual(FACETS_EMPTY);
		// No Audit service bound → empty facets.
		mocks.runAs.mockImplementationOnce(async (_u: unknown, effect: unknown) =>
			Effect.runPromise(effect as Effect.Effect<AuditFacets>),
		);
		await expect(auditActivityFacetsFn()).resolves.toEqual(FACETS_EMPTY);
	});
});
