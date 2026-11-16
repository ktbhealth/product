import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const headers = { current: new Headers() };

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => headers.current,
}));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const chain = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return chain;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (arg?: { data?: unknown }) =>
				h(arg === undefined ? {} : { ...arg, data: validate ? validate(arg.data) : arg.data }),
		};
		return chain;
	},
}));

import { Auth } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { LlmFactory } from "@ktb/eval-consultation";
import { Permissions } from "@ktb/rbac";
import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { AI_ENDPOINTS_TEST_DDL, AiEndpointsLive } from "./index.ts";
import {
	deleteEndpointFn,
	listEndpointPresetsFn,
	listEndpointsFn,
	saveEndpointFn,
	testEndpointFn,
} from "./fns.ts";

const sessionFor = (email: string | null) =>
	email === null
		? null
		: {
				user: { id: `id-${email}`, email, name: email },
				sessionId: "s1",
				expiresAt: new Date(Date.now() + 3600_000),
			};

describe("ai-endpoints fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	let allow = true;
	let factoryFails: false | "port" | "raw" = false;

	beforeAll(() => {
		const db = makeDb(makeD1(AI_ENDPOINTS_TEST_DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(
				Permissions,
				Permissions.of({
					permissionsFor: () => Effect.succeed(new Map()),
					canFor: () => Effect.succeed(allow),
					can: () => Effect.succeed(allow),
					requirePermissionFor: () =>
						allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
					requirePermission: () =>
						allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
					invalidate: () => Effect.void,
				} as never),
			),
			Layer.succeed(
				LlmFactory,
				LlmFactory.of({
					resolve: () => Effect.die("unused") as never,
					test: () =>
						factoryFails === "port"
							? (Effect.fail({ _tag: "PortError", port: "l", message: "down" }) as never)
							: factoryFails === "raw"
								? (Effect.fail("raw outage") as never)
								: Effect.void,
				}),
			),
		);
		runtime = ManagedRuntime.make(
			Layer.merge(AiEndpointsLive.pipe(Layer.provide(env)), env) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		const auth = Auth.of({
			setUserBanned: async () => {},
			getSession: async () => sessionFor(currentEmail) as never,
		});
		setServerRuntime({
			run: ((effect: Effect.Effect<unknown, unknown, unknown>) =>
				runtime.runPromise(effect.pipe(Effect.provideService(Auth, auth)))) as ServerRuntime["run"],
			runAs: ((
				user: { id: string; email: string },
				effect: Effect.Effect<unknown, unknown, unknown>,
			) =>
				runtime.runPromise(
					effect.pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
						}),
					),
				)) as ServerRuntime["runAs"],
			audioTranscribeModel: "test-model",
			getLocale: () => "en",
		});
	});

	afterAll(() => {
		resetServerRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		await expect(listEndpointsFn({ data: undefined })).rejects.toThrow("unauthenticated");
		await expect(listEndpointPresetsFn({ data: undefined })).rejects.toThrow("unauthenticated");
		await expect(testEndpointFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
	});

	it("returns { ok: false } when the grant is missing", async () => {
		currentEmail = "v@x.com";
		allow = false;
		expect(await listEndpointsFn({ data: undefined })).toEqual({ ok: false });
		expect(await listEndpointPresetsFn({ data: undefined })).toEqual({ ok: false });
		expect(await saveEndpointFn({ data: { name: "x", kind: "openai", baseUrl: "u" } })).toEqual({
			ok: false,
		});
		expect(await deleteEndpointFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await testEndpointFn({ data: { id: 1 } })).toEqual({ ok: false });
		allow = true;
	});

	it("drives the endpoint CRUD + test through the fn surface", async () => {
		const created = await saveEndpointFn({
			data: {
				name: "Ollama",
				kind: "openai",
				baseUrl: "http://localhost:11434/v1",
				model: "qwen",
				sessionId: "s",
				secretRef: "KEY",
				transport: null,
				scope: "eval",
				isDefault: true,
				timeoutMs: 5000,
				enabled: true,
			},
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const id = created.data.id;

		expect(
			await saveEndpointFn({
				data: { id, name: "O2", kind: "acp", baseUrl: "u2", transport: "ssh" },
			}),
		).toEqual({
			ok: true,
			data: { id },
		});
		const listed = await listEndpointsFn({ data: undefined });
		expect(listed.ok && listed.data[0]?.kind).toBe("acp");

		// The stub factory declares no presets — the fn degrades to [].
		expect(await listEndpointPresetsFn({ data: undefined })).toEqual({ ok: true, data: [] });

		// Required-fields-only create — no optionals on the wire.
		expect(
			await saveEndpointFn({ data: { name: "bare-ep", kind: "openai", baseUrl: "u" } }),
		).toMatchObject({ ok: true });

		const okTest = await testEndpointFn({ data: { id } });
		expect(okTest.ok).toBe(true);
		factoryFails = "port";
		const badTest = await testEndpointFn({ data: { id } });
		expect(badTest).toEqual({ ok: false, data: { message: "down" } });
		factoryFails = "raw";
		const rawTest = await testEndpointFn({ data: { id } });
		expect(rawTest).toEqual({ ok: false, data: { message: "raw outage" } });
		factoryFails = false;

		expect(await deleteEndpointFn({ data: { id } })).toEqual({ ok: true, data: null });
	});
});
