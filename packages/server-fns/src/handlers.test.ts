import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { Data } from "effect";

import { Auth, type AuthShape, type Session } from "@ktb/auth";
import { Forbidden } from "@ktb/authz";

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => requestHeaders.current,
}));

import { DoctorProfiles, type DoctorProfile } from "./profiles.ts";
import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "./runtime.ts";
import {
	doctorHandler,
	forbiddenTo,
	optionalDoctorHandler,
	optionalSessionHandler,
	pluginHandler,
	sessionHandler,
} from "./handlers.ts";
import { NotADoctorError, UnauthenticatedError } from "./session.ts";
import { PluginDisabledError } from "./plugin-route.ts";

const session: Session = {
	user: { id: "u1", email: "a@x.com", name: "A" },
	sessionId: "s1",
	expiresAt: new Date("2030-01-01T00:00:00Z"),
};

let sessionResult: Session | null = session;
/** Doctor profiles the directory returns; null = no directory deployed. */
let doctorProfiles: "none" | readonly DoctorProfile[] = "none";
let pluginEnabledResult = true;
let runAsCalls: readonly { id: string; actorId?: string }[] = [];

const authShape: AuthShape = {
	getSession: async () => sessionResult,
	setUserBanned: async () => {},
	updateUser: async () => ({ ok: true as const }),
	deleteUser: async () => {},
};

const doctorDirectory = DoctorProfiles.of({
	listFor: () => Effect.succeed(doctorProfiles === "none" ? [] : doctorProfiles),
	claimInvites: () => Effect.succeed(0),
});

const runtime: ServerRuntime = {
	run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		Effect.runPromise(
			effect.pipe(
				Effect.provideService(Auth, authShape),
				doctorProfiles === "none"
					? (e) => e
					: Effect.provideService(DoctorProfiles, doctorDirectory),
			) as Effect.Effect<A, E, never>,
		),
	runAs: <A, E>(
		user: { readonly id: string; readonly email?: string; readonly actorId?: string },
		effect: Effect.Effect<A, E, unknown>,
	) => {
		runAsCalls = [
			...runAsCalls,
			{ id: user.id, ...(user.actorId ? { actorId: user.actorId } : {}) },
		];
		return Effect.runPromise(effect as Effect.Effect<A, E, never>);
	},
	getLocale: () => "en",
	audioTranscribeModel: "test-model",
	pluginEnabled: async () => pluginEnabledResult,
};

beforeEach(() => {
	resetServerRuntime();
	setServerRuntime(runtime);
	sessionResult = session;
	doctorProfiles = "none";
	pluginEnabledResult = true;
	runAsCalls = [];
	requestHeaders.current = new Headers();
});

describe("sessionHandler", () => {
	it("rejects anonymous callers with UnauthenticatedError", async () => {
		sessionResult = null;
		const fn = sessionHandler(async () => "unreachable");
		await expect(fn({ data: 1 })).rejects.toBeInstanceOf(UnauthenticatedError);
	});

	it("injects user and a run bound through runAs", async () => {
		const fn = sessionHandler<{ data: number }, string>(async ({ data, user, run }) => {
			expect(data).toBe(42);
			expect(user.id).toBe("u1");
			return run(Effect.succeed("done"));
		});
		await expect(fn({ data: 42 })).resolves.toBe("done");
		expect(runAsCalls).toEqual([{ id: "u1" }]);
	});
});

describe("doctorHandler", () => {
	it("acts as the account itself when no directory is deployed", async () => {
		const fn = doctorHandler(async ({ user, run }) => {
			expect(user.id).toBe("u1");
			expect(user.actorId).toBe("u1");
			return run(Effect.succeed(user.doctor.email));
		});
		await expect(fn({ data: undefined })).resolves.toBe("a@x.com");
		expect(runAsCalls).toEqual([{ id: "u1", actorId: "u1" }]);
	});

	it("rejects signed-in accounts with no doctor profile", async () => {
		doctorProfiles = [];
		const fn = doctorHandler(async () => "unreachable");
		await expect(fn({ data: undefined })).rejects.toBeInstanceOf(NotADoctorError);
	});

	it("rejects anonymous callers with UnauthenticatedError", async () => {
		sessionResult = null;
		const fn = doctorHandler(async () => "unreachable");
		await expect(fn({ data: undefined })).rejects.toBeInstanceOf(UnauthenticatedError);
	});
});

describe("optionalSessionHandler", () => {
	it("answers anonymous callers through onAnonymous", async () => {
		sessionResult = null;
		const fn = optionalSessionHandler(
			(args: { data: number }) => `anon:${args.data}`,
			async ({ user }) => user.id,
		);
		await expect(fn({ data: 7 })).resolves.toBe("anon:7");
	});

	it("injects the session context for signed-in callers", async () => {
		const fn = optionalSessionHandler<{ data: string }, string>(
			() => "anon",
			async ({ data, user, run }) => run(Effect.succeed(`${user.id}:${data}`)),
		);
		await expect(fn({ data: "x" })).resolves.toBe("u1:x");
		expect(runAsCalls).toEqual([{ id: "u1" }]);
	});
});

describe("optionalDoctorHandler", () => {
	it("collapses anonymous and no-doctor callers to onAnonymous", async () => {
		sessionResult = null;
		const anonymous = optionalDoctorHandler(
			() => "hidden",
			async ({ user }) => user.id,
		);
		await expect(anonymous({ data: undefined })).resolves.toBe("hidden");

		sessionResult = session;
		doctorProfiles = [];
		await expect(anonymous({ data: undefined })).resolves.toBe("hidden");
	});

	it("injects the acting doctor for eligible callers", async () => {
		const fn = optionalDoctorHandler(
			() => "hidden",
			async ({ user, run }) => run(Effect.succeed(`${user.id}/${user.actorId}`)),
		);
		await expect(fn({ data: undefined })).resolves.toBe("u1/u1");
	});
});

describe("pluginHandler", () => {
	it("delegates when the plugin is enabled", async () => {
		const fn = pluginHandler<{ data: number }, string>(
			"demo.routes",
			async ({ data }) => `ok:${data}`,
		);
		await expect(fn({ data: 1 })).resolves.toBe("ok:1");
	});

	it("fails with PluginDisabledError when the plugin is disabled", async () => {
		pluginEnabledResult = false;
		const fn = pluginHandler("demo.routes", async () => "unreachable");
		await expect(fn({ data: undefined })).rejects.toBeInstanceOf(PluginDisabledError);
	});

	it("composes ahead of sessionHandler, gate first", async () => {
		pluginEnabledResult = false;
		sessionResult = null;
		const fn = pluginHandler(
			"demo.routes",
			sessionHandler(async () => "unreachable"),
		);
		// The enablement gate runs before the session check.
		await expect(fn({ data: undefined })).rejects.toBeInstanceOf(PluginDisabledError);
	});
});

describe("forbiddenTo", () => {
	class OtherError extends Data.TaggedError("OtherError")<{}> {}

	it("collapses a Forbidden failure into the fallback", async () => {
		const program = Effect.fail(new Forbidden({ path: "x" })).pipe(
			forbiddenTo({ ok: false as const }),
		);
		await expect(Effect.runPromise(program)).resolves.toEqual({ ok: false });
	});

	it("lets other tagged errors propagate", async () => {
		const program = Effect.fail(new OtherError()).pipe(forbiddenTo(null));
		await expect(Effect.runPromise(program)).rejects.toBeInstanceOf(OtherError);
	});

	it("keeps successful results untouched", async () => {
		const program = Effect.succeed(3).pipe(forbiddenTo(0));
		await expect(Effect.runPromise(program)).resolves.toBe(3);
	});
});
