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
import { LlmFactory, LlmPort } from "@ktb/eval-consultation";
import { Permissions } from "@ktb/rbac";
import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	EVAL_PERSONA_TEST_DDL,
	EvalEndpointsLive,
	EvalInstancesLive,
	EvalPersonasLive,
} from "./index.ts";
import {
	createInstanceFn,
	deleteEndpointFn,
	deleteInstanceFn,
	deletePersonaDefFn,
	generatePersonasFn,
	instanceDetailFn,
	listEndpointPresetsFn,
	listEndpointsFn,
	listInstancesFn,
	listPersonaDefsFn,
	saveEndpointFn,
	savePersonaDefFn,
	spawnInstancesFn,
	startInstanceFn,
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

const defInput = {
	name: "idosa",
	patientName: "Maria",
	gender: "female",
	ageBand: "elderly",
	socialClass: "low",
	education: "primary",
	region: "northeast",
	register: "colloquial",
	specialty: "general_practice",
	doctorGender: "female",
	doctorRegister: "neutral",
};

describe("eval-persona fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	let allow = true;
	let factoryFails: false | "port" | "raw" = false;

	beforeAll(() => {
		const db = makeDb(makeD1(EVAL_PERSONA_TEST_DDL));
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
					resolve: () =>
						Effect.succeed(
							Layer.succeed(
								LlmPort,
								LlmPort.of({
									generate: () =>
										Effect.succeed({
											text: "doctor: oi\npatient: oi\ndoctor: queixa?\npatient: dor",
											record: {} as never,
										}),
									correct: () =>
										Effect.fail({ _tag: "PortError", port: "l", message: "x" }) as never,
								}),
							),
						),
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
			Layer.merge(
				Layer.mergeAll(EvalPersonasLive, EvalEndpointsLive, EvalInstancesLive).pipe(
					Layer.provide(env),
				),
				env,
			) as Layer.Layer<unknown, never, never>,
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
		await expect(listPersonaDefsFn({ data: undefined })).rejects.toThrow("unauthenticated");
		await expect(listInstancesFn({ data: undefined })).rejects.toThrow("unauthenticated");
	});

	it("returns { ok: false } when the grant is missing", async () => {
		currentEmail = "v@x.com";
		allow = false;
		expect(await listPersonaDefsFn({ data: undefined })).toEqual({ ok: false });
		expect(await savePersonaDefFn({ data: defInput })).toEqual({ ok: false });
		expect(await deletePersonaDefFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await generatePersonasFn({ data: { count: 5 } })).toEqual({ ok: false });
		expect(await listEndpointsFn({ data: undefined })).toEqual({ ok: false });
		expect(await listEndpointPresetsFn({ data: undefined })).toEqual({ ok: false });
		expect(await saveEndpointFn({ data: { name: "x", kind: "openai", baseUrl: "u" } })).toEqual({
			ok: false,
		});
		expect(await deleteEndpointFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await testEndpointFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await listInstancesFn({ data: undefined })).toEqual({ ok: false });
		expect(await instanceDetailFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await createInstanceFn({ data: { name: "i", mode: "random" } })).toEqual({
			ok: false,
		});
		expect(await startInstanceFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await deleteInstanceFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await spawnInstancesFn({ data: { count: 2 } })).toEqual({ ok: false });
		allow = true;
	});

	it("drives the persona-def CRUD through the fn surface", async () => {
		const created = await savePersonaDefFn({ data: { ...defInput, notes: "n" } });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const updated = await savePersonaDefFn({
			data: {
				...defInput,
				id: created.data.id,
				name: "renamed",
				gender: "male",
				doctorGender: "male",
				notes: "n2",
			},
		});
		expect(updated).toEqual({ ok: true, data: { id: created.data.id } });

		// Second update without notes — the wire update omits the key.
		expect(
			await savePersonaDefFn({
				data: { ...defInput, id: created.data.id, name: "plain" },
			}),
		).toEqual({ ok: true, data: { id: created.data.id } });

		const listed = await listPersonaDefsFn({ data: undefined });
		expect(listed.ok && listed.data[0]?.name).toBe("plain");

		expect(await deletePersonaDefFn({ data: { id: created.data.id } })).toEqual({
			ok: true,
			data: null,
		});
	});

	it("generates persona defs through the fn surface", async () => {
		// Template path — no endpoint on the wire.
		expect(await generatePersonasFn({ data: { count: 2, seed: 3 } })).toEqual({
			ok: true,
			data: { created: 2 },
		});
		// Endpoint path — the llm returns a script, not a def array, so
		// the sample top-up still lands the requested count.
		const ep = await saveEndpointFn({
			data: { name: "gen-ep", kind: "openai", baseUrl: "http://llm" },
		});
		if (!ep.ok) return;
		expect(await generatePersonasFn({ data: { count: 1, endpointId: ep.data.id } })).toEqual({
			ok: true,
			data: { created: 1 },
		});
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
				timeoutMs: 5000,
				enabled: true,
			},
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const id = created.data.id;

		expect(await saveEndpointFn({ data: { id, name: "O2", kind: "acp", baseUrl: "u2" } })).toEqual({
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

	it("drives instance create/start/detail/delete through the fn surface", async () => {
		const def = await savePersonaDefFn({ data: defInput });
		if (!def.ok) return;

		const inst = await createInstanceFn({
			data: {
				name: "sel",
				mode: "selected",
				defIds: [def.data.id],
				endpointId: null,
				count: null,
				seed: 5,
				minutes: 5,
			},
		});
		// Minimal create — no optionals on the wire at all.
		expect(await createInstanceFn({ data: { name: "bare", mode: "random" } })).toMatchObject({
			ok: true,
		});
		// Populated create — every optional on the wire.
		const ep = await saveEndpointFn({ data: { name: "e2", kind: "acp", baseUrl: "u" } });
		if (!ep.ok) return;
		expect(
			await createInstanceFn({
				data: {
					name: "full",
					mode: "random",
					endpointId: ep.data.id,
					count: 1,
					seed: 1,
					minutes: 5,
				},
			}),
		).toMatchObject({ ok: true });
		expect(inst.ok).toBe(true);
		if (!inst.ok) return;

		expect(await startInstanceFn({ data: { id: inst.data.id } })).toEqual({
			ok: true,
			data: null,
		});
		let detail: { status?: string } | null = null;
		for (let i = 0; i < 60; i++) {
			const d = await instanceDetailFn({ data: { id: inst.data.id } });
			if (d.ok) detail = d.data;
			if (detail?.status !== "generating" && detail?.status !== "draft") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(detail?.status).toBe("ready");

		const list = await listInstancesFn({ data: undefined });
		expect(list.ok && list.data.length).toBe(3);

		expect(await deleteInstanceFn({ data: { id: inst.data.id } })).toEqual({
			ok: true,
			data: null,
		});
	});

	it("rejects out-of-range counts, defCounts and seeds at the wire", async () => {
		for (const count of [0, -1, 1e9, 1.5]) {
			await expect(spawnInstancesFn({ data: { count } })).rejects.toThrow("Expected");
			await expect(generatePersonasFn({ data: { count } })).rejects.toThrow("Expected");
		}
		await expect(spawnInstancesFn({ data: { count: 1, defCount: 0 } })).rejects.toThrow("Expected");
		await expect(spawnInstancesFn({ data: { count: 1, defCount: 201 } })).rejects.toThrow(
			"Expected",
		);
		await expect(spawnInstancesFn({ data: { count: 1, seed: -5 } })).rejects.toThrow("Expected");
		await expect(spawnInstancesFn({ data: { count: 1, seed: 3e9 } })).rejects.toThrow("Expected");
		await expect(
			createInstanceFn({ data: { name: "x", mode: "random", count: 0 } }),
		).rejects.toThrow("Expected");
		await expect(
			createInstanceFn({ data: { name: "x", mode: "random", count: 1e9 } }),
		).rejects.toThrow("Expected");
	});

	it("rejects persona defs with non-whitelist axis values", async () => {
		await expect(
			savePersonaDefFn({ data: { ...defInput, ageBand: "centenarian" } }),
		).rejects.toThrow("Expected");
		await expect(savePersonaDefFn({ data: { ...defInput, gender: "x" } })).rejects.toThrow(
			"Expected",
		);
		await expect(
			savePersonaDefFn({ data: { ...defInput, doctorRegister: "baroque" } }),
		).rejects.toThrow("Expected");
	});

	it("surfaces InstanceRejected as { ok: false, data: { message } }", async () => {
		// Selected mode with only unknown defIds — nothing to insert.
		const rejected = await createInstanceFn({
			data: { name: "sel", mode: "selected", defIds: [9999] },
		});
		expect(rejected).toEqual({
			ok: false,
			data: { message: "selected mode needs at least one known persona def" },
		});

		// Deleting a generating instance is refused with the reason.
		const inst = await createInstanceFn({ data: { name: "busy", mode: "random", count: 1 } });
		if (!inst.ok) return;
		await startInstanceFn({ data: { id: inst.data.id } });
		const del = await deleteInstanceFn({ data: { id: inst.data.id } });
		expect(del).toEqual({
			ok: false,
			data: { message: "instance is generating — wait for it to finish before removing" },
		});
	});

	it("spawns generator instances through the fn surface", async () => {
		const ep = await saveEndpointFn({
			data: { name: "sp-ep", kind: "acp", baseUrl: "u", transport: "ssh" },
		});
		if (!ep.ok) return;
		const listed = await listEndpointsFn({ data: undefined });
		const sp = listed.ok ? listed.data.find((e) => e.name === "sp-ep") : undefined;
		expect(sp?.transport).toBe("ssh");

		const r = await spawnInstancesFn({
			data: { count: 3, endpointId: ep.data.id, defCount: 2, seed: 42, name: "gen" },
		});
		expect(r).toEqual({ ok: true, data: { created: 3 } });
		const inst = await listInstancesFn({ data: undefined });
		const names = inst.ok ? inst.data.map((i) => i.name) : [];
		expect(names).toEqual(expect.arrayContaining(["gen #1", "gen #2", "gen #3"]));
		const one = inst.ok ? inst.data.find((i) => i.name === "gen #2") : undefined;
		expect(one?.mode).toBe("random");
		expect(one?.total).toBe(2);
		expect(one?.endpointId).toBe(ep.data.id);
	});
});
