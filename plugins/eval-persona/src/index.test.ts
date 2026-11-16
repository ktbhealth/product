import { describe, expect, it } from "vitest";

import { ApiKeys } from "@ktb/auth";
import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { doctors, patients, user as userTable } from "@ktb/db/schema";
import {
	LlmFactory,
	LlmPort,
	type LlmEndpointDescriptor,
	type LlmEndpointPreset,
} from "@ktb/eval-consultation";
import { EvalCredentials, EvalCredentialsLive } from "@ktb/eval-credentials";
import { evalPersona } from "@ktb/eval-validator";
import { Permissions } from "@ktb/rbac";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	EVAL_PERSONA_TEST_DDL,
	EvalEndpoints,
	EvalEndpointsLive,
	EvalInstances,
	EvalInstancesLive,
	EvalPersonas,
	EvalPersonasLive,
	evalPersonaPanelPlugin,
	type EndpointInput,
} from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";
import { evalInstance, evalInstanceItem, evalLlmEndpoint, evalPersonaDef } from "./schema.ts";

const grantLayer = (allow: boolean) =>
	Layer.succeed(
		Permissions,
		Permissions.of({
			permissionsFor: () => Effect.succeed(new Map()),
			canFor: () => Effect.succeed(allow),
			can: () => Effect.succeed(allow),
			requirePermissionFor: () =>
				allow ? Effect.void : Effect.fail(new Forbidden({ path: "rbac.eval.validator" })),
			requirePermission: () =>
				allow ? Effect.void : Effect.fail(new Forbidden({ path: "rbac.eval.validator" })),
			invalidate: () => Effect.void,
		} as never),
	);

const llmScript = "doctor: oi\npatient: oi\ndoctor: queixa?\npatient: dor de cabeça";

// Mixed-shape JSON payload for EvalPersonas.generate: a complete def,
// non-object items (skipped), a sparse def (sanitized to defaults) and
// one with invalid axis values.
const llmDefJson = JSON.stringify([
	{
		name: "gen-1",
		patientName: "Ana",
		gender: "f",
		ageBand: "adult",
		socialClass: "middle",
		education: "higher",
		region: "south",
		register: "neutral",
		specialty: "cardiology",
		doctorGender: "m",
		doctorRegister: "technical",
		notes: "llm",
	},
	"not-an-object",
	null,
	{},
	{ name: "gen-partial", patientName: 42, gender: "x", ageBand: "child", doctorGender: "m" },
]);

type FactoryKind = "ok" | "fail" | "bad" | "genfail" | "json" | "broken";

const factoryLayer = (
	kind: FactoryKind = "ok",
	captured?: LlmEndpointDescriptor[],
	presets?: readonly LlmEndpointPreset[],
) =>
	Layer.succeed(
		LlmFactory,
		LlmFactory.of({
			...(presets !== undefined ? { presets } : {}),
			resolve: (d) => {
				captured?.push(d);
				return kind === "fail"
					? (Effect.fail({ _tag: "PortError", port: "llm", message: "down" }) as never)
					: Effect.succeed(
							Layer.succeed(
								LlmPort,
								LlmPort.of({
									generate: () =>
										kind === "bad"
											? Effect.succeed({ text: "garbage", record: {} as never })
											: kind === "genfail"
												? (Effect.fail({
														_tag: "PortError",
														port: "llm",
														message: "down",
													}) as never)
												: kind === "json"
													? Effect.succeed({ text: llmDefJson, record: {} as never })
													: kind === "broken"
														? Effect.succeed({ text: "[{]", record: {} as never })
														: Effect.succeed({ text: llmScript, record: {} as never }),
									correct: () =>
										Effect.fail({ _tag: "PortError", port: "llm", message: "down" }) as never,
								}),
							),
						);
			},
			test: (d) => {
				captured?.push(d);
				return kind === "fail"
					? (Effect.fail({ _tag: "PortError", port: "llm", message: "down" }) as never)
					: Effect.void;
			},
		}),
	);

const persona = {
	name: "Maria Silva",
	gender: "f",
	ageBand: "elderly",
	socialClass: "low",
	education: "primary",
	region: "northeast",
	register: "colloquial",
	specialty: "general_practice",
	doctor: { gender: "f", register: "neutral" },
};

/** In-memory ApiKeys fake for EvalCredentialsLive — mirrors
 * eval-credentials' own test double (metadata carries
 * `{provider, secret}`; ids are the better-auth string keys). */
const apiKeysLayer = () => {
	let n = 0;
	const rows = new Map<
		string,
		{ name: string; metadata: Record<string, unknown>; referenceId: string }
	>();
	return Layer.succeed(
		ApiKeys,
		ApiKeys.of({
			create: async (input) => {
				const id = `k${++n}`;
				rows.set(id, {
					name: input.name,
					metadata: input.metadata,
					referenceId: input.referenceId,
				});
				return { id };
			},
			list: async (referenceId) =>
				[...rows.entries()]
					.filter(([, r]) => r.referenceId === referenceId)
					.map(([id, r]) => ({
						id,
						referenceId: r.referenceId,
						name: r.name,
						start: null,
						enabled: true,
						metadata: JSON.stringify(r.metadata),
					})),
			remove: async (id, referenceId) => {
				if (rows.get(id)?.referenceId === referenceId) rows.delete(id);
			},
			getSecret: async (id, referenceId) => {
				const r = rows.get(id);
				if (r === undefined || r.referenceId !== referenceId) return null;
				const s = r.metadata.secret;
				return typeof s === "string" ? s : null;
			},
		}),
	);
};

const make = (
	opts: {
		allow?: boolean;
		factory?: FactoryKind | "none";
		email?: boolean;
		captured?: LlmEndpointDescriptor[];
		presets?: readonly LlmEndpointPreset[];
	} = {},
) => {
	const { allow = true, factory = "none", email = true, captured, presets } = opts;
	const d1 = makeD1(EVAL_PERSONA_TEST_DDL);
	const db = makeDb(d1);
	const layers = Layer.mergeAll(
		Layer.succeed(Db, db as unknown as DbClient),
		grantLayer(allow),
		apiKeysLayer(),
		factory === "none" ? Layer.empty : factoryLayer(factory, captured, presets),
	);
	const rt = ManagedRuntime.make(
		Layer.merge(
			Layer.mergeAll(
				EvalPersonasLive,
				EvalEndpointsLive,
				EvalInstancesLive,
				EvalCredentialsLive,
			).pipe(Layer.provide(layers)),
			layers,
		),
	);
	const run = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		rt.runPromise(
			Effect.provideService(effect, Principal, {
				userId: "u1",
				...(email ? { email: "v@x.com" } : {}),
			}) as Effect.Effect<A, E>,
		);
	return { rt, run, db, d1 };
};

const EP: EndpointInput = {
	name: "Ollama local",
	kind: "openai",
	baseUrl: "http://localhost:11434/v1",
	model: "qwen2.5:7b",
};

describe("EvalPersonas", () => {
	it("denies everything without the grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(run(Effect.flatMap(EvalPersonas, (s) => s.list()))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await rt.dispose();
	});

	it("creates, lists, updates and removes defs", async () => {
		const { rt, run } = make();
		const { id } = await run(
			Effect.flatMap(EvalPersonas, (s) => s.create({ name: "idosa", persona, notes: "n" })),
		);
		const listed = await run(Effect.flatMap(EvalPersonas, (s) => s.list()));
		expect(listed[0]?.name).toBe("idosa");
		expect(listed[0]?.persona.name).toBe("Maria Silva");
		expect(listed[0]?.createdBy).toBe("v@x.com");

		await run(
			Effect.flatMap(EvalPersonas, (s) => s.update({ id, name: "idosa 2", persona, notes: "n2" })),
		);
		const updated = await run(Effect.flatMap(EvalPersonas, (s) => s.list()));
		expect(updated[0]?.name).toBe("idosa 2");
		expect(updated[0]?.notes).toBe("n2");
		expect(updated[0]?.updatedAt).not.toBeNull();

		await run(Effect.flatMap(EvalPersonas, (s) => s.update({ id, name: "idosa 3", persona })));
		const cleared = await run(Effect.flatMap(EvalPersonas, (s) => s.list()));
		expect(cleared[0]?.notes).toBeNull();

		await run(Effect.flatMap(EvalPersonas, (s) => s.remove(id)));
		expect(await run(Effect.flatMap(EvalPersonas, (s) => s.list()))).toHaveLength(0);
		await rt.dispose();
	});
});

describe("EvalEndpoints", () => {
	it("cruds endpoints and tests through the factory", async () => {
		const { rt, run } = make({ factory: "ok" });
		const { id } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const listed = await run(Effect.flatMap(EvalEndpoints, (s) => s.list()));
		expect(listed[0]?.kind).toBe("openai");
		expect(listed[0]?.model).toBe("qwen2.5:7b");

		await run(
			Effect.flatMap(EvalEndpoints, (s) =>
				s.update({ ...EP, id, name: "Ollama 2", enabled: false }),
			),
		);
		const updated = await run(Effect.flatMap(EvalEndpoints, (s) => s.list()));
		expect(updated[0]?.enabled).toBe(false);

		await run(Effect.flatMap(EvalEndpoints, (s) => s.test(id)));
		await run(Effect.flatMap(EvalEndpoints, (s) => s.remove(id)));
		expect(await run(Effect.flatMap(EvalEndpoints, (s) => s.list()))).toHaveLength(0);
		await rt.dispose();
	});

	it("test fails without a factory bound", async () => {
		const { rt, run } = make();
		const { id } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		await expect(run(Effect.flatMap(EvalEndpoints, (s) => s.test(id)))).rejects.toMatchObject({
			_tag: "PortError",
		});
		await rt.dispose();
	});

	it("test is a no-op for unknown ids", async () => {
		const { rt, run } = make({ factory: "ok" });
		await run(Effect.flatMap(EvalEndpoints, (s) => s.test(999)));
		await rt.dispose();
	});

	it("presets mirror the bound factory's provider list", async () => {
		const adapterPresets: readonly LlmEndpointPreset[] = [
			{ label: "OpenAI", kind: "openai", baseUrl: "https://hosted.example/v1", model: "m" },
		];
		const { rt, run } = make({ factory: "ok", presets: adapterPresets });
		expect(await run(Effect.flatMap(EvalEndpoints, (s) => s.presets()))).toEqual(adapterPresets);
		await rt.dispose();

		// Factory without presets → []; no factory → [].
		const bare = make({ factory: "ok" });
		expect(await bare.run(Effect.flatMap(EvalEndpoints, (s) => s.presets()))).toEqual([]);
		await bare.rt.dispose();
		const none = make();
		expect(await none.run(Effect.flatMap(EvalEndpoints, (s) => s.presets()))).toEqual([]);
		await none.rt.dispose();
	});
});

describe("EvalInstances", () => {
	it("creates a random instance and generates with template fallback", async () => {
		const { rt, run, db } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "lote", mode: "random", count: 2, seed: 7, minutes: 5 }),
			),
		);
		let d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.total).toBe(2);
		expect(d?.status).toBe("draft");
		expect(d?.items).toHaveLength(2);

		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		// The detached fiber finishes quickly — poll until done.
		for (let i = 0; i < 50; i++) {
			d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(d?.status).toBe("ready");
		expect(d?.done).toBe(2);
		expect(d?.pct).toBe(100);
		expect(d?.items.every((it) => it.status === "done" && it.evalPersonaId !== null)).toBe(true);
		// Synthetic entities landed flagged, linked to eval personas.
		const personas = await db.select().from(evalPersona);
		expect(personas.every((p) => p.scriptMode === "template" && p.patientId !== null)).toBe(true);
		const pats = await db.select().from(patients);
		expect(pats.every((p) => p.synthetic)).toBe(true);
		const docs = await db.select().from(doctors);
		expect(docs.every((doc) => doc.synthetic)).toBe(true);
		const users = await db.select().from(userTable);
		expect(users.every((u) => u.email.endsWith("@eval.ktb"))).toBe(true);
		await rt.dispose();
	});

	it("selected mode snapshots def personas and generates via the endpoint", async () => {
		const { rt, run, db } = make({ factory: "ok" });
		const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const { id: defId } = await run(
			Effect.flatMap(EvalPersonas, (s) => s.create({ name: "d1", persona })),
		);
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "sel", mode: "selected", defIds: [defId], endpointId: epId }),
			),
		);
		let d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.items[0]?.persona?.name).toBe("Maria Silva");
		expect(d?.endpointName).toBe("Ollama local");

		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(d?.status).toBe("ready");
		const personas = await db.select().from(evalPersona);
		expect(personas[0]?.scriptMode).toBe("llm");
		expect(personas[0]?.script).toContain("dor de cabeça");
		await rt.dispose();
	});

	it("falls back to template when the endpoint resolve fails", async () => {
		const { rt, run, db } = make({ factory: "fail" });
		const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "f", mode: "random", count: 1, endpointId: epId }),
			),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const personas = await db.select().from(evalPersona);
		expect(personas[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("falls back to template on unparseable llm output", async () => {
		const { rt, run, db } = make({ factory: "bad" });
		const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "f2", mode: "random", count: 1, endpointId: epId }),
			),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const personas = await db.select().from(evalPersona);
		expect(personas[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("marks items error on per-item defects — the run still completes", async () => {
		const { rt, run, d1 } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "iso", mode: "random", count: 2 })),
		);
		// Dropping eval_persona makes every item's persona insert reject —
		// a defect the per-item isolation converts to an error row.
		await d1.exec("DROP TABLE eval_persona");
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		let d;
		for (let i = 0; i < 50; i++) {
			d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(d?.status).toBe("failed");
		expect(d?.items.every((it) => it.status === "error" && it.error !== null)).toBe(true);
		await rt.dispose();
	});

	it("marks the instance failed on catastrophic defects", async () => {
		const { rt, run, d1 } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "cat", mode: "random", count: 1 })),
		);
		await d1.exec("DROP TABLE eval_persona_batch");
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.status).toBe("failed");
		await rt.dispose();
	});

	it("list drives generation — polls advance items without detail", async () => {
		const { rt, run } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "drv", mode: "random", count: 1 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		let status = "";
		for (let i = 0; i < 10; i++) {
			const rows = await run(Effect.flatMap(EvalInstances, (s) => s.list()));
			status = rows.find((r) => r.id === id)?.status ?? "";
			if (status === "ready") break;
		}
		expect(status).toBe("ready");
		await rt.dispose();
	});

	it("leaves an in-flight item alone — no premature finalize", async () => {
		const { rt, run, db } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "inf", mode: "random", count: 1 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		// Simulate a concurrent tick's FRESH claim: no `pending` left
		// but an item mid-flight — finalize must NOT mark the run ready.
		const items = await db.select().from(evalInstanceItem);
		await db
			.update(evalInstanceItem)
			.set({ status: "generating", claimedAt: new Date() })
			.where(eq(evalInstanceItem.id, items[0]!.id));
		// Tick 1 inits the batch; tick 2 sees the in-flight claim.
		await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.status).toBe("generating");
		await rt.dispose();
	});

	it("reclaims a stale generating claim — the run reaches ready", async () => {
		const { rt, run, db } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "stale", mode: "random", count: 1 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		// A request killed mid-generation leaves its item claimed —
		// simulate with a claim stamp older than the stale threshold.
		await db
			.update(evalInstanceItem)
			.set({ status: "generating", claimedAt: new Date(Date.now() - 120_000) })
			.where(eq(evalInstanceItem.instanceId, id));
		// Tick 1 reclaims + inits the batch; tick 2 claims and generates;
		// tick 3 finalizes.
		await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.status).toBe("ready");
		expect(d?.items[0]?.status).toBe("done");
		expect(d?.items[0]?.evalPersonaId).not.toBeNull();
		await rt.dispose();
	});

	it("finalizes ready when an instance has zero items", async () => {
		const { rt, run } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "empty", mode: "random" })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		// Tick 1 inits the batch; tick 2 finalizes the empty item set.
		await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.status).toBe("ready");
		await rt.dispose();
	});

	it("swallows tick defects — polls keep flowing on broken tables", async () => {
		const { rt, run, d1 } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "cat", mode: "random", count: 1 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		await d1.exec("DROP TABLE eval_instance_item");
		// First tick inits the batch then returns; the SECOND detail's
		// tick hits the dropped items table — catchDefect in
		// tickQuietly swallows it, then detail fails on its own select.
		await expect(run(Effect.flatMap(EvalInstances, (s) => s.detail(id)))).rejects.toThrow();
		await expect(run(Effect.flatMap(EvalInstances, (s) => s.detail(id)))).rejects.toThrow();
		await rt.dispose();
	});

	it("skips the llm layer for disabled endpoints — template generation", async () => {
		const { rt, run, db } = make({ factory: "ok" });
		const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		await run(Effect.flatMap(EvalEndpoints, (s) => s.update({ ...EP, id: epId, enabled: false })));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "dis", mode: "random", count: 1, endpointId: epId }),
			),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const personas = await db.select().from(evalPersona);
		expect(personas[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("falls back to template when the llm generate call itself fails", async () => {
		const { rt, run, db } = make({ factory: "genfail" });
		const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "g", mode: "random", count: 1, endpointId: epId }),
			),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const personas = await db.select().from(evalPersona);
		expect(personas[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("detail survives corrupt persona JSON and deleted endpoints", async () => {
		const { rt, run, db } = make();
		const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "corrupt", mode: "random", count: 1, endpointId: epId }),
			),
		);
		await db
			.update(evalInstanceItem)
			.set({ persona: "{not json" })
			.where(eq(evalInstanceItem.instanceId, id));
		await run(Effect.flatMap(EvalEndpoints, (s) => s.remove(epId)));
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.items[0]?.persona).toEqual({});
		expect(d?.endpointName).toBeNull();
		expect(d?.endpointId).toBeNull();
		await rt.dispose();
	});

	it("removes instances and their items (cascade)", async () => {
		const { rt, run, db } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "del", mode: "random", count: 1 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.remove(id)));
		expect(await db.select().from(evalInstanceItem)).toHaveLength(0);
		expect(await db.select().from(evalInstance)).toHaveLength(0);
		await rt.dispose();
	});

	it("refuses to remove a generating instance but removes finished ones", async () => {
		const { rt, run, db } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "busy", mode: "random", count: 1 })),
		);
		await db.update(evalInstance).set({ status: "generating" }).where(eq(evalInstance.id, id));
		// Deleting mid-flight would orphan claimed items — refused.
		await expect(run(Effect.flatMap(EvalInstances, (s) => s.remove(id)))).rejects.toMatchObject({
			_tag: "InstanceRejected",
		});
		expect(await db.select().from(evalInstance)).toHaveLength(1);
		// Finished runs delete normally.
		await db.update(evalInstance).set({ status: "ready" }).where(eq(evalInstance.id, id));
		await run(Effect.flatMap(EvalInstances, (s) => s.remove(id)));
		expect(await db.select().from(evalInstance)).toHaveLength(0);
		await rt.dispose();
	});

	it("start ignores non-draft and unknown instances", async () => {
		const { rt, run, db } = make();
		await run(Effect.flatMap(EvalInstances, (s) => s.start(999)));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "x", mode: "random", count: 1 })),
		);
		await db.update(evalInstance).set({ status: "ready" }).where(eq(evalInstance.id, id));
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.done).toBe(0);
		expect(d?.items[0]?.status).toBe("pending");
		await rt.dispose();
	});

	it("detail returns null for unknown instances", async () => {
		const { rt, run } = make();
		expect(await run(Effect.flatMap(EvalInstances, (s) => s.detail(999)))).toBeNull();
		await rt.dispose();
	});

	it("denies without the grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(run(Effect.flatMap(EvalInstances, (s) => s.list()))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await rt.dispose();
	});
});

describe("evalPersonaPanelPlugin", () => {
	const pages = evalPersonaPanelPlugin.panel?.pages ?? [];

	it("registers both nested eval pages", () => {
		expect(pages.map((p) => p.path)).toEqual([
			"/platform/eval/personas",
			"/platform/eval/instances",
		]);
	});

	it("guard reflects the eval.validator grant", async () => {
		for (const allow of [true, false]) {
			const { rt } = make({ allow });
			for (const page of pages) {
				expect(await rt.runPromise(page.guard!() as Effect.Effect<boolean>)).toBe(allow);
			}
			await rt.dispose();
		}
	});

	it("personas loader lists defs, degrades to [] on Forbidden", async () => {
		const { rt, run } = make();
		await run(Effect.flatMap(EvalPersonas, (s) => s.create({ name: "d", persona })));
		const personasPage = pages[0]!;
		const data = await run(
			personasPage.loader!() as Effect.Effect<readonly unknown[], never, unknown>,
		);
		expect(data).toHaveLength(1);
		await rt.dispose();

		const denied = make({ allow: false });
		const empty = await denied.run(
			personasPage.loader!() as Effect.Effect<readonly unknown[], never, unknown>,
		);
		expect(empty).toEqual([]);
		await denied.rt.dispose();
	});

	it("instances loader returns all three collections, degrades on Forbidden", async () => {
		const { rt, run } = make();
		const instancesPage = pages[1]!;
		const data = (await run(
			instancesPage.loader!() as Effect.Effect<
				{
					instances: readonly unknown[];
					defs: readonly unknown[];
					endpoints: readonly unknown[];
				},
				never,
				unknown
			>,
		)) as {
			instances: readonly unknown[];
			defs: readonly unknown[];
			endpoints: readonly unknown[];
		};
		expect(data.instances).toEqual([]);
		expect(data.defs).toEqual([]);
		expect(data.endpoints).toEqual([]);
		await rt.dispose();

		const denied = make({ allow: false });
		const empty = (await denied.run(
			instancesPage.loader!() as Effect.Effect<unknown, never, unknown>,
		)) as {
			instances: readonly unknown[];
			defs: readonly unknown[];
			endpoints: readonly unknown[];
		};
		expect(empty).toEqual({ instances: [], defs: [], endpoints: [] });
		await denied.rt.dispose();
	});
});

describe("EvalInstances — edge inputs", () => {
	it("creates a random instance with no count/endpoint/minutes (defaults)", async () => {
		const { rt, run } = make();
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "bare", mode: "random" })),
		);
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.total).toBe(0);
		expect(d?.items).toEqual([]);
		await rt.dispose();
	});

	it("selected mode drops unknown defIds — total counts what was inserted", async () => {
		const { rt, run } = make();
		const { id: defId } = await run(
			Effect.flatMap(EvalPersonas, (s) => s.create({ name: "d", persona })),
		);
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "sel", mode: "selected", defIds: [defId, 999] }),
			),
		);
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.total).toBe(1);
		expect(d?.items).toHaveLength(1);
		await rt.dispose();
	});

	it("selected mode fails the create when nothing was picked", async () => {
		const { rt, run, db } = make();
		await expect(
			run(
				Effect.flatMap(EvalInstances, (s) =>
					s.create({ name: "all-bad", mode: "selected", defIds: [999, 998] }),
				),
			),
		).rejects.toMatchObject({ _tag: "InstanceRejected" });
		await expect(
			run(
				Effect.flatMap(EvalInstances, (s) =>
					s.create({ name: "none", mode: "selected", defIds: [] }),
				),
			),
		).rejects.toMatchObject({ _tag: "InstanceRejected" });
		// No half-created instances left behind.
		expect(await db.select().from(evalInstance)).toHaveLength(0);
		await rt.dispose();
	});

	it("selected mode without defIds rejects, and snapshots count into params", async () => {
		const { rt, run, db } = make();
		// `defIds` absent → the `?? []` arm picks nothing → rejected.
		await expect(
			run(Effect.flatMap(EvalInstances, (s) => s.create({ name: "no-defs", mode: "selected" }))),
		).rejects.toMatchObject({ _tag: "InstanceRejected" });
		// A defined `count` lands in the selected instance's params blob.
		const { id: defId } = await run(
			Effect.flatMap(EvalPersonas, (s) => s.create({ name: "d", persona })),
		);
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "sel-count", mode: "selected", defIds: [defId], count: 3 }),
			),
		);
		const [row] = await db.select().from(evalInstance);
		expect(row?.id).toBe(id);
		expect(JSON.parse(row!.params)).toMatchObject({ count: 3 });
		await rt.dispose();
	});

	it("endpoint without optional fields resolves to a bare descriptor", async () => {
		const { rt, run } = make({ factory: "ok" });
		const { id: epId } = await run(
			Effect.flatMap(EvalEndpoints, (s) =>
				s.create({ name: "acp-agent", kind: "acp", baseUrl: "http://agent/rpc" }),
			),
		);
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "acp-run", mode: "random", count: 1, endpointId: epId }),
			),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.status).toBe("ready");
		await rt.dispose();
	});
});

describe("EvalPersonas — principal and descriptor edges", () => {
	it("records createdBy null when the principal has no email", async () => {
		const { rt, run, db } = make({ email: false });
		await run(Effect.flatMap(EvalPersonas, (s) => s.create({ name: "d", persona })));
		await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		await run(Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 1 })));
		await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "i", mode: "random", count: 1 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.spawn({ count: 1 })));
		expect((await db.select().from(evalPersonaDef))[0]?.createdBy).toBeNull();
		expect((await db.select().from(evalInstance))[0]?.createdBy).toBeNull();
		await rt.dispose();
	});

	it("resolves descriptors carrying session and secret refs, and runs with minutes", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run, db } = make({ factory: "ok", captured });
		const { id: epId } = await run(
			Effect.flatMap(EvalEndpoints, (s) =>
				s.create({ ...EP, sessionId: "sess-1", secretRef: "MY_KEY" }),
			),
		);
		const { id: defId } = await run(
			Effect.flatMap(EvalPersonas, (s) => s.create({ name: "d1", persona })),
		);
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({
					name: "timed",
					mode: "selected",
					defIds: [defId],
					endpointId: epId,
					minutes: 5,
				}),
			),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		const get = () => Effect.flatMap(EvalInstances, (s) => s.detail(id));
		let status = "";
		for (let i = 0; i < 50; i++) {
			const d = await run(get());
			status = d?.status ?? "";
			if (status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(status).toBe("ready");
		const rows = await db.select().from(evalPersona);
		expect(rows[0]?.scriptMode).toBe("llm");
		// Env-var secret refs travel as names — the adapter edge resolves them.
		expect(captured[0]?.sessionId).toBe("sess-1");
		expect(captured[0]?.secretRef).toBe("MY_KEY");
		expect(captured[0]?.apiKey).toBeUndefined();
		await rt.dispose();
	});
});

describe("EvalPersonas.generate", () => {
	it("samples the matrix when no endpoint is bound", async () => {
		const { rt, run } = make();
		const r = await run(Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 3 })));
		expect(r.created).toBe(3);
		const listed = await run(Effect.flatMap(EvalPersonas, (s) => s.list()));
		expect(listed).toHaveLength(3);
		expect(listed[0]?.createdBy).toBe("v@x.com");
		expect(listed.every((d) => d.notes?.includes("sampled"))).toBe(true);
		await rt.dispose();
	});

	it("creates defs from llm json output and tops up shortfalls", async () => {
		const { rt, run } = make({ factory: "json" });
		const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const r = await run(
			Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 4, endpointId: epId, seed: 7 })),
		);
		expect(r.created).toBe(4);
		const listed = await run(Effect.flatMap(EvalPersonas, (s) => s.list()));
		expect(listed.some((d) => d.name === "gen-1")).toBe(true);
		expect(listed.some((d) => d.name === "gen-partial")).toBe(true);
		expect(listed.some((d) => d.name === "Persona")).toBe(true);
		expect(listed.some((d) => d.notes?.includes("sampled"))).toBe(true);
		await rt.dispose();
	});

	it("respects the count when the llm returns more defs than asked", async () => {
		const { rt, run } = make({ factory: "json" });
		const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const r = await run(
			Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 2, endpointId: epId })),
		);
		expect(r.created).toBe(2);
		await rt.dispose();
	});

	it("falls back to sampling for unknown, disabled or factory-less endpoints", async () => {
		// Unknown + disabled rows need a bound factory to reach the row
		// check; the factory-less arm early-returns on serviceOption.
		const bound = make({ factory: "ok" });
		const { id: epId } = await bound.run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		await bound.run(
			Effect.flatMap(EvalEndpoints, (s) => s.update({ ...EP, id: epId, enabled: false })),
		);
		const disabled = await bound.run(
			Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 2, endpointId: epId })),
		);
		expect(disabled.created).toBe(2);
		const unknown = await bound.run(
			Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 1, endpointId: 999 })),
		);
		expect(unknown.created).toBe(1);
		await bound.rt.dispose();

		const { rt, run } = make();
		const { id: ep2 } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const noFactory = await run(
			Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 1, endpointId: ep2 })),
		);
		expect(noFactory.created).toBe(1);
		await rt.dispose();
	});

	it("falls back to sampling when the llm resolve/generate/parse fails", async () => {
		for (const factory of ["fail", "bad", "genfail", "broken"] as const) {
			const { rt, run } = make({ factory });
			const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
			const r = await run(
				Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 1, endpointId: epId })),
			);
			expect(r.created).toBe(1);
			await rt.dispose();
		}
	});

	it("denies generate without the grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(
			run(Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 1 }))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await rt.dispose();
	});

	it("resolves credential:<id> refs into apiKey on the descriptor", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured });
		const { id: credId } = await run(
			Effect.flatMap(EvalCredentials, (c) =>
				c.create({ name: "prod key", provider: "openai", secret: "sk-live-9" }),
			),
		);
		const { id: epId } = await run(
			Effect.flatMap(EvalEndpoints, (s) => s.create({ ...EP, secretRef: `credential:${credId}` })),
		);
		await run(Effect.flatMap(EvalEndpoints, (s) => s.test(epId)));
		expect(captured.at(-1)?.apiKey).toBe("sk-live-9");
		expect(captured.at(-1)?.secretRef).toBeUndefined();
		await rt.dispose();
	});
});

describe("EvalInstances.spawn", () => {
	it("fans out random-mode generator instances with seeded params", async () => {
		const { rt, run, db } = make();
		const r = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.spawn({ count: 3, defCount: 2, seed: 50, name: "gen" }),
			),
		);
		expect(r.created).toBe(3);
		const rows = await db.select().from(evalInstance).orderBy(evalInstance.id);
		expect(rows.map((x) => x.name)).toEqual(["gen #1", "gen #2", "gen #3"]);
		expect(rows.every((x) => x.mode === "random" && x.status === "draft")).toBe(true);
		expect(rows.every((x) => x.createdBy === "v@x.com")).toBe(true);
		expect(JSON.parse(rows[0]!.params)).toEqual({ seed: 50, count: 2 });
		expect(JSON.parse(rows[2]!.params)).toEqual({ seed: 52, count: 2 });
		const items = await db.select().from(evalInstanceItem);
		expect(items).toHaveLength(6);
		await rt.dispose();
	});

	it("defaults name/defCount/seed and carries the endpoint", async () => {
		const { rt, run, db } = make();
		const { id: epId } = await run(Effect.flatMap(EvalEndpoints, (s) => s.create(EP)));
		const r = await run(
			Effect.flatMap(EvalInstances, (s) => s.spawn({ count: 1, endpointId: epId })),
		);
		expect(r.created).toBe(1);
		const [row] = await db.select().from(evalInstance);
		expect(row?.name).toBe("generator #1");
		expect(row?.endpointId).toBe(epId);
		expect(JSON.parse(row!.params)).toEqual({ seed: 100, count: 3 });
		await rt.dispose();
	});

	it("rolls the whole fan-out back when a mid-loop insert fails", async () => {
		const { rt, run, db, d1 } = make();
		// Breaking the items table makes every insertInstance fail inside
		// the transaction — no half-provisioned "generator" rows survive.
		await d1.exec("DROP TABLE eval_instance_item");
		await expect(
			run(Effect.flatMap(EvalInstances, (s) => s.spawn({ count: 3, defCount: 2 }))),
		).rejects.toThrow("no such table");
		expect(await db.select().from(evalInstance)).toHaveLength(0);
		await rt.dispose();
	});

	it("denies spawn without the grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(
			run(Effect.flatMap(EvalInstances, (s) => s.spawn({ count: 1 }))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await rt.dispose();
	});
});

describe("endpoint transport", () => {
	it("stores transport on save and forwards it to the descriptor", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured });
		const { id: ssh } = await run(
			Effect.flatMap(EvalEndpoints, (s) =>
				s.create({ name: "acp-ssh", kind: "acp", baseUrl: "ssh://h", transport: "ssh" }),
			),
		);
		const listed = await run(Effect.flatMap(EvalEndpoints, (s) => s.list()));
		expect(listed[0]?.transport).toBe("ssh");
		await run(Effect.flatMap(EvalEndpoints, (s) => s.test(ssh)));
		expect(captured.at(-1)?.transport).toBe("ssh");

		const { id: ws } = await run(
			Effect.flatMap(EvalEndpoints, (s) =>
				s.create({ name: "acp-ws", kind: "acp", baseUrl: "ws://h", transport: "ws" }),
			),
		);
		await run(Effect.flatMap(EvalEndpoints, (s) => s.test(ws)));
		expect(captured.at(-1)?.transport).toBe("ws");
		await rt.dispose();
	});

	it("omits transport on the descriptor for null or unrecognized values", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run, db } = make({ factory: "ok", captured });
		const { id: bare } = await run(
			Effect.flatMap(EvalEndpoints, (s) =>
				s.create({ name: "acp-bare", kind: "acp", baseUrl: "ws://h" }),
			),
		);
		await run(Effect.flatMap(EvalEndpoints, (s) => s.test(bare)));
		expect(captured.at(-1)?.transport).toBeUndefined();
		// Bogus value written straight to the row — the descriptor
		// whitelist drops anything outside ws|child|ssh.
		await db
			.update(evalLlmEndpoint)
			.set({ transport: "carrier-pigeon" })
			.where(eq(evalLlmEndpoint.id, bare));
		await run(Effect.flatMap(EvalEndpoints, (s) => s.test(bare)));
		expect(captured.at(-1)?.transport).toBeUndefined();
		// Transport is acp-only — an openai row never forwards it even
		// when a value is stored.
		const { id: openai } = await run(
			Effect.flatMap(EvalEndpoints, (s) =>
				s.create({ name: "o", kind: "openai", baseUrl: "https://h/v1" }),
			),
		);
		await db.update(evalLlmEndpoint).set({ transport: "ws" }).where(eq(evalLlmEndpoint.id, openai));
		await run(Effect.flatMap(EvalEndpoints, (s) => s.test(openai)));
		expect(captured.at(-1)?.transport).toBeUndefined();
		await rt.dispose();
	});
});

describe("client plugin mirror", () => {
	it("mirrors the client-safe plugin ids, sidebar items, and panel pages", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"eval.persona.tables",
			"eval.persona.services",
			"eval.persona.chrome",
			"eval.persona.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "eval.persona.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["eval-personas.sidebar", "eval-instances.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "eval.persona.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual([
			"/platform/eval/personas",
			"/platform/eval/instances",
		]);
	});
});
