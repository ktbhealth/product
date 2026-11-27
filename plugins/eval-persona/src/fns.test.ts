import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import { AiEndpoints, AiEndpointsLive, type EndpointInput } from "@ktb/ai-provider";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { LlmFactory, LlmPort } from "@ktb/eval-consultation";
import { Permissions } from "@ktb/rbac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { EvalInstancesLive, EvalPersonasLive } from "./index.ts";
import {
	createInstanceFn,
	deleteInstanceFn,
	deletePersonaDefFn,
	generatePersonasFn,
	instanceDetailFn,
	listInstancesFn,
	listPersonaDefsFn,
	savePersonaDefFn,
	spawnInstancesFn,
	startInstanceFn,
} from "./fns.ts";

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

	// Endpoint rows go through the AiEndpoints service — the fn
	// surface for endpoint CRUD lives in @ktb/ai-provider now.
	const createEndpoint = (input: EndpointInput) =>
		runtime.runPromise(Effect.flatMap(AiEndpoints, (s) => s.create(input)));

	beforeAll(() => {
		const db = makeDb(makeTestD1());
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
					test: () => Effect.void,
				}),
			),
		);
		// app-host topo composition: eval-persona's services layer sees
		// the AiEndpoints output it soft-deps on.
		const services = (
			[AiEndpointsLive, EvalPersonasLive, EvalInstancesLive] as Layer.Layer<
				unknown,
				unknown,
				unknown
			>[]
		).reduce<Layer.Layer<unknown, unknown, unknown>>(
			(acc, svc) => Layer.merge(acc, svc.pipe(Layer.provideMerge(acc))),
			Layer.empty as unknown as Layer.Layer<unknown, unknown, unknown>,
		);
		runtime = ManagedRuntime.make(
			Layer.merge(services.pipe(Layer.provide(env)), env) as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(
			runtime,
			stubAuth(() => sessionUser(currentEmail)),
		);
	});

	afterAll(() => {
		resetServerFnRuntime();
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
		const ep = await createEndpoint({ name: "gen-ep", kind: "openai", baseUrl: "http://llm" });
		expect(await generatePersonasFn({ data: { count: 1, endpointId: ep.id } })).toEqual({
			ok: true,
			data: { created: 1 },
		});
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
		const ep = await createEndpoint({ name: "e2", kind: "acp", baseUrl: "u" });
		expect(
			await createInstanceFn({
				data: {
					name: "full",
					mode: "random",
					endpointId: ep.id,
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
		const ep = await createEndpoint({
			name: "sp-ep",
			kind: "acp",
			baseUrl: "u",
			transport: "ssh",
		});
		const listed = await runtime.runPromise(Effect.flatMap(AiEndpoints, (s) => s.list()));
		const sp = listed.find((e) => e.name === "sp-ep");
		expect(sp?.transport).toBe("ssh");

		const r = await spawnInstancesFn({
			data: { count: 3, endpointId: ep.id, defCount: 2, seed: 42, name: "gen" },
		});
		expect(r).toEqual({ ok: true, data: { created: 3 } });
		const inst = await listInstancesFn({ data: undefined });
		const names = inst.ok ? inst.data.map((i) => i.name) : [];
		expect(names).toEqual(expect.arrayContaining(["gen #1", "gen #2", "gen #3"]));
		const one = inst.ok ? inst.data.find((i) => i.name === "gen #2") : undefined;
		expect(one?.mode).toBe("random");
		expect(one?.total).toBe(2);
		expect(one?.endpointId).toBe(ep.id);
	});
});
