import { beforeEach, describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";
import * as Effect from "effect/Effect";

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	runAs: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => reactStartMock());
vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return Object.assign(mocks, actual.serverFnHandlerMocks(), {
		forbiddenTo: actual.forbiddenTo,
	});
});

import { PortalAudience } from "@ktb/portal";

import { portalAudiencesFn } from "./fns.ts";

const user = { id: "ana", email: "ana@ktb.test", name: "Ana" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("portalAudiencesFn", () => {
	it("returns an empty list for anonymous callers", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(portalAudiencesFn()).resolves.toEqual([]);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("returns an empty list when the PortalAudience service is absent", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		mocks.runAs.mockImplementation(
			(_user: unknown, effect: Effect.Effect<unknown, unknown, PortalAudience>) =>
				Effect.runPromise(effect as Effect.Effect<unknown, unknown, never>),
		);
		await expect(portalAudiencesFn()).resolves.toEqual([]);
	});

	it("returns the caller's audiences sorted", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		mocks.runAs.mockImplementation(
			(_user: unknown, effect: Effect.Effect<unknown, unknown, PortalAudience>) =>
				Effect.runPromise(
					effect.pipe(
						Effect.provideService(
							PortalAudience,
							PortalAudience.of({
								audiences: () => Effect.succeed(new Set(["patient", "doctor"])),
							}),
						),
					),
				),
		);
		await expect(portalAudiencesFn()).resolves.toEqual(["doctor", "patient"]);
	});
});
