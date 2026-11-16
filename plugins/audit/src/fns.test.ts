import { beforeEach, describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	runAs: vi.fn(),
}));

// Same fake as the sibling plugin fns tests: handlers run as plain
// async fns; `runAs` executes the Effect for real so the
// serviceOption/Forbidden branches are exercised.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		const api = {
			validator: () => api,
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (call?: { data?: unknown }) =>
				h(call ?? {}),
		};
		return api;
	},
}));
vi.mock("@ktb/server-fns", () => ({
	getSessionUser: mocks.getSessionUser,
	runAs: mocks.runAs,
}));

import { Forbidden } from "@ktb/authz";

import { Audit, type AuditVerifyResult } from "./index.ts";
import { auditVerifyFn } from "./fns.ts";

const VERIFIED: AuditVerifyResult = { status: "verified", entries: 4, brokenAt: null };

/** Layer providing a stub Audit service; `adminVerify` is the only
 * member the fn under test reaches. */
const auditLayer = (adminVerify: () => Effect.Effect<AuditVerifyResult, Forbidden>) =>
	Layer.succeed(Audit, {
		record: () => Effect.void,
		adminList: () => Effect.die("unused"),
		adminVerify,
		activityAccess: () => Effect.succeed(false),
		activityList: () => Effect.die("unused"),
		patientList: () => Effect.die("unused"),
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
					auditLayer(adminVerify),
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
					auditLayer(() => Effect.fail(new Forbidden({ path: "audit.admin" }))),
				),
			),
		);
		await expect(auditVerifyFn()).resolves.toBeNull();
	});
});
