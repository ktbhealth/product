import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Auth } from "@ktb/auth";
import { Principal } from "@ktb/authz";

import { getServerRuntime, run, runAs } from "./runtime.ts";
import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	serverFnRequestHeaders,
	sessionUser,
	stubAuth,
} from "./testing.ts";

describe("reactStartMock", () => {
	it("stubs the createServerFn validator/handler chain", async () => {
		const { createServerFn } = reactStartMock();

		const seen: unknown[] = [];
		const fn = createServerFn({ method: "POST" })
			.validator((input: unknown) => ({ wrapped: input }))
			.handler(async (arg) => {
				seen.push(arg?.data);
				return "ok";
			});

		await expect(fn({ data: 42 })).resolves.toBe("ok");
		expect(seen).toEqual([{ wrapped: 42 }]);
		// createServerFn options ride on the callable, like production.
		expect((fn as unknown as { method: string }).method).toBe("POST");
	});

	it("passes a bare {} arg and skips validation when no validator ran", async () => {
		const { createServerFn } = reactStartMock();

		const seen: unknown[] = [];
		const fn = createServerFn({ method: "GET" }).handler(async (arg) => {
			seen.push(arg);
			return "ok";
		});

		await expect(fn()).resolves.toBe("ok");
		expect(seen).toEqual([{}]);
		await expect(fn({ data: "raw" })).resolves.toBe("ok");
		expect(seen[1]).toEqual({ data: "raw" });
	});

	it("tolerates createServerFn called without options", async () => {
		const { createServerFn } = reactStartMock();

		const fn = createServerFn().handler(async () => "ok");
		await expect(fn()).resolves.toBe("ok");
		// No options object → nothing rides on the callable.
		expect((fn as unknown as Record<string, unknown>).method).toBeUndefined();
	});
});

describe("reactStartServerMock", () => {
	it("returns fresh Headers copies seeded from serverFnRequestHeaders", () => {
		const { getRequestHeaders } = reactStartServerMock();

		serverFnRequestHeaders.current = new Headers({ cookie: "session=abc" });
		const first = getRequestHeaders();
		const second = getRequestHeaders();

		expect(first).not.toBe(second);
		expect(first.get("cookie")).toBe("session=abc");
		expect(second.get("cookie")).toBe("session=abc");
	});
});

describe("session fixtures", () => {
	it("sessionUser returns null for anonymous and a Session otherwise", () => {
		expect(sessionUser(null)).toBeNull();
		const session = sessionUser("doc@x.com");
		expect(session?.user).toMatchObject({ id: "id-doc@x.com", email: "doc@x.com" });
	});

	it("stubAuth resolves through the reader and no-ops setUserBanned", async () => {
		const auth = stubAuth(() => sessionUser("a@b.c"));
		await expect(auth.getSession(new Headers())).resolves.toMatchObject({
			user: { email: "a@b.c" },
		});
		await auth.setUserBanned("u1", true);
	});

	it("stubAuth no-ops updateUser and deleteUser", async () => {
		const auth = stubAuth(() => sessionUser("a@b.c"));
		await expect(auth.updateUser("u1", { name: "N" })).resolves.toEqual({ ok: true });
		await expect(auth.deleteUser("u1")).resolves.toBeUndefined();
	});
});

describe("installServerFnRuntime", () => {
	it("wires run/runAs with Auth and Principal plus overrides", async () => {
		const runtime = ManagedRuntime.make(Layer.empty) as unknown as ManagedRuntime.ManagedRuntime<
			unknown,
			never
		>;
		const auth = stubAuth(() => sessionUser("admin@x.com"));
		installServerFnRuntime(runtime, auth, {
			pluginEnabled: async (id) => id === "pkg.on",
			getLocale: () => "pt-BR",
		});
		try {
			const session = await run(
				Effect.gen(function* () {
					const shape = yield* Auth;
					return shape.getSession(new Headers());
				}),
			);
			expect(session?.user.email).toBe("admin@x.com");

			const principal = await runAs(
				{ id: "u7", email: "u@x.com", actorId: "act-1" },
				Effect.gen(function* () {
					return yield* Principal;
				}),
			);
			expect(principal).toEqual({ userId: "u7", email: "u@x.com", actorId: "act-1" });

			expect(getServerRuntime().getLocale()).toBe("pt-BR");
			await expect(getServerRuntime().pluginEnabled?.("pkg.on")).resolves.toBe(true);
			await expect(getServerRuntime().pluginEnabled?.("pkg.off")).resolves.toBe(false);
		} finally {
			resetServerFnRuntime();
			await runtime.dispose();
		}
	});

	it("keeps accessor overrides lazy — getters re-read on every access", async () => {
		const runtime = ManagedRuntime.make(Layer.empty) as unknown as ManagedRuntime.ManagedRuntime<
			unknown,
			never
		>;
		let flag = false;
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{
				get jobs() {
					return flag ? { enqueue: async () => ({}) } : undefined;
				},
			},
		);
		try {
			expect(getServerRuntime().jobs).toBeUndefined();
			flag = true;
			expect(getServerRuntime().jobs).toBeDefined();
		} finally {
			resetServerFnRuntime();
			await runtime.dispose();
		}
	});

	it("defaults getLocale to en and exposes the test transcribe model", async () => {
		const runtime = ManagedRuntime.make(Layer.empty) as unknown as ManagedRuntime.ManagedRuntime<
			unknown,
			never
		>;
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
		);
		try {
			expect(getServerRuntime().getLocale()).toBe("en");
			expect(getServerRuntime().audioTranscribeModel).toBe("test-model");
		} finally {
			resetServerFnRuntime();
			await runtime.dispose();
		}
	});
});
