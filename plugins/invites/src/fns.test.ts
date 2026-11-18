import { beforeEach, describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

import * as Effect from "effect/Effect";

const mocks = vi.hoisted(() => ({
	getLocale: vi.fn(() => "en"),
	run: vi.fn(),
	issue: vi.fn(),
	preview: vi.fn(),
	accept: vi.fn(),
}));

// Same fake as the host's route tests: the handler runs as a plain async
// fn. It also keeps the HTTP method, which decides whether the input
// travels in the query string (GET) or in the body (POST).
vi.mock("@tanstack/react-start", () => reactStartMock());
vi.mock("@ktb/server-fns", () => ({
	getLocale: mocks.getLocale,
	run: mocks.run,
}));

import { InviteRejected, Invites, type InviteErrorCode } from "./index.ts";
import { acceptInviteFn, invitePreviewFn, localeFn } from "./fns.ts";

const preview = {
	email: "sec@ktb.test",
	kind: "secretary",
	inviterName: "Dra. Ana",
	accountExists: false,
};
const input = { token: "tok-1", name: "Maria Souza", password: "senha12345" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getLocale.mockReturnValue("en");
	const service = {
		issue: mocks.issue,
		preview: mocks.preview,
		accept: mocks.accept,
	};
	// `run` resolves the Invites service like the app runtime would.
	mocks.run.mockImplementation((effect: Effect.Effect<unknown, never, Invites>) =>
		Effect.runPromise(effect.pipe(Effect.provideService(Invites, service))),
	);
});

describe("token-carrying fns", () => {
	it("take the token in the request body, never in the URL", () => {
		expect((invitePreviewFn as unknown as { method: string }).method).toBe("POST");
		expect((acceptInviteFn as unknown as { method: string }).method).toBe("POST");
	});
});

describe("localeFn", () => {
	it("returns the active locale", async () => {
		await expect(localeFn()).resolves.toBe("en");
		mocks.getLocale.mockReturnValue("pt-BR");
		await expect(localeFn()).resolves.toBe("pt-BR");
	});
});

describe("invitePreviewFn", () => {
	it("previews the link the token opens", async () => {
		mocks.preview.mockReturnValue(Effect.succeed(preview));
		await expect(invitePreviewFn({ data: "tok-1" })).resolves.toEqual(preview);
		expect(mocks.preview.mock.calls).toEqual([["tok-1"]]);
	});

	it("is null for a dead link", async () => {
		mocks.preview.mockReturnValue(Effect.succeed(null));
		await expect(invitePreviewFn({ data: "gone" })).resolves.toBeNull();
		expect(mocks.preview).toHaveBeenCalledWith("gone");
	});

	it.each([
		["a number", 42],
		["an object", { token: "tok-1" }],
		["null", null],
		["nothing", undefined],
	])("rejects %s as a token on the wire", async (_label, token) => {
		await expect(invitePreviewFn({ data: token as never })).rejects.toThrow();
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.preview).not.toHaveBeenCalled();
	});
});

describe("acceptInviteFn", () => {
	it("creates the account and reports whose and of what kind", async () => {
		mocks.accept.mockReturnValue(Effect.succeed({ email: "sec@ktb.test", kind: "secretary" }));
		await expect(acceptInviteFn({ data: input })).resolves.toEqual({
			ok: true,
			email: "sec@ktb.test",
			kind: "secretary",
		});
		expect(mocks.accept.mock.calls).toEqual([[input]]);
	});

	it("passes only the token, the name and the password to the service", async () => {
		mocks.accept.mockReturnValue(Effect.succeed({ email: "sec@ktb.test", kind: "secretary" }));
		await acceptInviteFn({
			data: { ...input, email: "attacker@evil.test" } as never,
		});
		expect(mocks.accept.mock.calls).toEqual([[input]]);
	});

	it.each(["invalid", "account_exists", "invalid_name", "invalid_password"] as const)(
		"returns the %s rejection as a result, not a failure",
		async (code: InviteErrorCode) => {
			mocks.accept.mockReturnValue(Effect.fail(new InviteRejected({ code })));
			await expect(acceptInviteFn({ data: input })).resolves.toEqual({
				ok: false,
				error: code,
			});
		},
	);

	it.each([
		["a missing password", { token: "tok-1", name: "Maria Souza" }],
		["a missing token", { name: "Maria Souza", password: "senha12345" }],
		["a non-string name", { ...input, name: 7 }],
		["a non-string token", { ...input, token: ["tok-1"] }],
		["a bare string", "tok-1"],
		["nothing", undefined],
	])("rejects %s on the wire", async (_label, payload) => {
		await expect(acceptInviteFn({ data: payload as never })).rejects.toThrow();
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.accept).not.toHaveBeenCalled();
	});
});
