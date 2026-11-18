import { beforeEach, describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

import * as Effect from "effect/Effect";

const mocks = vi.hoisted(() => ({
	getLocale: vi.fn(),
	getSessionUser: vi.fn(),
	run: vi.fn(),
	runAs: vi.fn(),
	sender: { current: null as unknown },
	adminGate: { current: null as unknown },
}));

// Same fake as the other plugins' route tests: the handler runs as a
// plain async fn; `run` executes the Effect for real against a stub
// Email service so the `sender !== null` branch is exercised.
vi.mock("@tanstack/react-start", () => reactStartMock());
vi.mock("@ktb/server-fns", () => ({
	getLocale: mocks.getLocale,
	getSessionUser: mocks.getSessionUser,
	run: mocks.run,
	runAs: mocks.runAs,
}));

import { Email } from "@ktb/email";
import { PlatformAdmin } from "@ktb/platform";

import { emailEnabledFn, localeFn, platformAdminAccessFn } from "./fns.ts";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sender.current = null;
	mocks.adminGate.current = null;
	mocks.getSessionUser.mockResolvedValue(null);
	mocks.run.mockImplementation((effect: Effect.Effect<unknown, unknown, Email>) =>
		Effect.runPromise(effect.pipe(Effect.provideService(Email, mocks.sender.current as never))),
	);
	// runAs executes the effect for real, binding the PlatformAdmin
	// stub when a test installs one — serviceOption sees it either way.
	mocks.runAs.mockImplementation(
		(_user: unknown, effect: Effect.Effect<unknown, unknown, unknown>) => {
			const eff =
				mocks.adminGate.current === null
					? effect
					: effect.pipe(Effect.provideService(PlatformAdmin, mocks.adminGate.current as never));
			return Effect.runPromise(eff as never);
		},
	);
});

describe("localeFn", () => {
	it("returns the request's active locale", async () => {
		mocks.getLocale.mockReturnValue("pt-BR");
		await expect(localeFn()).resolves.toBe("pt-BR");
	});
});

describe("emailEnabledFn", () => {
	it("is false when no Email driver is bound", async () => {
		await expect(emailEnabledFn()).resolves.toBe(false);
	});

	it("is true when an Email driver is bound", async () => {
		mocks.sender.current = { send: vi.fn() };
		await expect(emailEnabledFn()).resolves.toBe(true);
	});
});

describe("platformAdminAccessFn", () => {
	const user = { id: "u1", email: "root@x.com", name: "Root" };

	it("is false for anonymous sessions", async () => {
		await expect(platformAdminAccessFn()).resolves.toBe(false);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("is false when the PlatformAdmin service is absent", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		await expect(platformAdminAccessFn()).resolves.toBe(false);
	});

	it("passes the session subject to the gate — email + account id", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		const isAdmin = vi.fn(() => Effect.succeed(true));
		mocks.adminGate.current = { isAdmin, requireAdmin: () => Effect.void };
		await expect(platformAdminAccessFn()).resolves.toBe(true);
		expect(isAdmin).toHaveBeenCalledWith({ email: "root@x.com", userId: "u1" });
	});

	it("is false when the gate denies", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		mocks.adminGate.current = {
			isAdmin: () => Effect.succeed(false),
			requireAdmin: () => Effect.void,
		};
		await expect(platformAdminAccessFn()).resolves.toBe(false);
	});
});
