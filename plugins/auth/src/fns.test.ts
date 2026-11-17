import { beforeEach, describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";

const mocks = vi.hoisted(() => ({
	getLocale: vi.fn(),
	run: vi.fn(),
	sender: { current: null as unknown },
}));

// Same fake as the other plugins' route tests: the handler runs as a
// plain async fn; `run` executes the Effect for real against a stub
// Email service so the `sender !== null` branch is exercised.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		const chain = {
			validator: () => chain,
			handler: (h: (arg?: unknown) => unknown) => async (arg?: unknown) => h(arg ?? {}),
		};
		return chain;
	},
}));
vi.mock("@ktb/server-fns", () => ({
	getLocale: mocks.getLocale,
	run: mocks.run,
}));

import { Email } from "@ktb/email";

import { emailEnabledFn, localeFn } from "./fns.ts";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sender.current = null;
	mocks.run.mockImplementation((effect: Effect.Effect<unknown, unknown, Email>) =>
		Effect.runPromise(effect.pipe(Effect.provideService(Email, mocks.sender.current as never))),
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
