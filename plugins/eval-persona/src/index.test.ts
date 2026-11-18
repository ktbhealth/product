import { describe, expect, it } from "vitest";

import { AiEndpoints, AiEndpointsLive, type EndpointInput } from "@ktb/ai-provider";
import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { consultations, doctors, patients, user as userTable } from "@ktb/db/schema";
import {
	LlmFactory,
	LlmPort,
	type LlmEndpointDescriptor,
	type LlmEndpointPreset,
} from "@ktb/eval-consultation";
import { Permissions } from "@ktb/rbac";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	EVAL_PERSONA_TEST_DDL,
	EvalInstances,
	EvalInstancesLive,
	EvalPersonas,
	EvalPersonasLive,
	evalPersonaPanelPlugin,
} from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";
import { evalInstance, evalInstanceItem, evalPersonaDef } from "./schema.ts";

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

// Second JSON payload for EvalPersonas.generate — coherent and
// incoherent axis pairs that exercise the persona coherence clamps
// (pediatrics vs ageBand, education vs ageBand).
const llmClampJson = JSON.stringify([
	{ name: "clamp-peds-adult", specialty: "pediatrics", ageBand: "adult", education: "higher" },
	{ name: "clamp-peds-child", specialty: "pediatrics", ageBand: "child", education: "primary" },
	{ name: "clamp-peds-teen", specialty: "pediatrics", ageBand: "teen", education: "secondary" },
	{ name: "clamp-child", ageBand: "child", education: "higher" },
	{ name: "clamp-teen", ageBand: "teen", education: "higher" },
]);

type FactoryKind = "ok" | "fail" | "bad" | "genfail" | "json" | "json2" | "broken";

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
													: kind === "json2"
														? Effect.succeed({ text: llmClampJson, record: {} as never })
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

// An AiEndpoints stub whose calls fail typed — simulates the grant
// flipping mid-request (or a plugin edge failure) so consumers'
// `Effect.catch` fallbacks fire instead of a null row.
const failingEndpointsLayer = Layer.succeed(
	AiEndpoints,
	AiEndpoints.of({
		list: () => Effect.fail(new Forbidden({ path: "rbac.eval.validator" })),
		get: () => Effect.succeed(null),
		create: () => Effect.fail(new Forbidden({ path: "rbac.eval.validator" })),
		update: () => Effect.fail(new Forbidden({ path: "rbac.eval.validator" })),
		remove: () => Effect.fail(new Forbidden({ path: "rbac.eval.validator" })),
		presets: () => Effect.succeed([]),
		test: () => Effect.void,
		resolve: () => Effect.fail(new Forbidden({ path: "rbac.eval.validator" })),
		resolveDefault: () => Effect.succeed(null),
	} as never),
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

const make = (
	opts: {
		allow?: boolean;
		factory?: FactoryKind | "none";
		email?: boolean;
		endpoints?: boolean | "fail";
		captured?: LlmEndpointDescriptor[];
		presets?: readonly LlmEndpointPreset[];
	} = {},
) => {
	const {
		allow = true,
		factory = "none",
		email = true,
		endpoints = true,
		captured,
		presets,
	} = opts;
	const d1 = makeD1(EVAL_PERSONA_TEST_DDL);
	const db = makeDb(d1);
	const layers = Layer.mergeAll(
		Layer.succeed(Db, db as never),
		grantLayer(allow),
		factory === "none" ? Layer.empty : factoryLayer(factory, captured, presets),
	);
	// Mirror app-host composition: plugin services compose in topo
	// order via provideMerge, so eval-persona's build-time
	// serviceOption sees the AiEndpoints output it soft-deps on.
	// `endpoints: false` runs the plugin standalone — endpoint picks
	// degrade to template mode. `endpoints: "fail"` binds a stub whose
	// calls fail typed, exercising the consumers' catch fallbacks.
	const endpointsLayer =
		endpoints === "fail" ? [failingEndpointsLayer] : endpoints ? [AiEndpointsLive] : [];
	const services = (
		[...endpointsLayer, EvalPersonasLive, EvalInstancesLive] as Layer.Layer<
			unknown,
			unknown,
			unknown
		>[]
	).reduce<Layer.Layer<unknown, unknown, unknown>>(
		(acc, svc) => Layer.merge(acc, svc.pipe(Layer.provideMerge(acc))),
		Layer.empty as unknown as Layer.Layer<unknown, unknown, unknown>,
	);
	const rt = ManagedRuntime.make(
		Layer.merge(services.pipe(Layer.provide(layers)), layers) as Layer.Layer<unknown, never, never>,
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

// Random-mode instances sample the persona registry — tests driving a
// random instance seed defs first through this helper.
const seedDefs = (n: number) =>
	Effect.forEach(
		Array.from({ length: n }, (_, i) => i),
		(i) => Effect.flatMap(EvalPersonas, (s) => s.create({ name: `d${i}`, persona })),
		{ discard: true },
	);

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

describe("EvalInstances", () => {
	it("creates a random instance and generates with template fallback", async () => {
		const { rt, run, db } = make();
		await run(seedDefs(2));
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
		expect(
			d?.items.every(
				(it) => it.status === "done" && it.scriptMode === "template" && it.state === "under_review",
			),
		).toBe(true);
		// Synthetic entities landed flagged, linked on the item's corpus fields.
		const items = await db.select().from(evalInstanceItem);
		expect(items.every((p) => p.scriptMode === "template" && p.patientId !== null)).toBe(true);
		const pats = await db.select().from(patients);
		expect(pats.every((p) => p.synthetic)).toBe(true);
		const docs = await db.select().from(doctors);
		expect(docs.every((doc) => doc.synthetic)).toBe(true);
		const users = await db.select().from(userTable);
		expect(users.every((u) => u.email.endsWith("@eval.ktb"))).toBe(true);
		// WS-F: each item also persists a REAL consultations row —
		// synthetic=1, source=eval, evalItemId provenance, gold script
		// as the transcript the run pipeline writes back onto.
		const consults = await db.select().from(consultations);
		expect(consults).toHaveLength(2);
		expect(
			consults.every(
				(c) => c.synthetic && c.source === "eval" && c.evalItemId !== null && c.transcript !== "",
			),
		).toBe(true);
		expect(consults.map((c) => c.evalItemId).sort()).toEqual(items.map((i) => i.id).sort());
		// Finalize wrote the DatasetManifest projection — the cohort's
		// registry identity eval runs pin as their dataset.
		const [instRow] = await db.select().from(evalInstance);
		const manifest = JSON.parse(instRow?.manifest ?? "{}") as {
			id: string;
			version: string;
			sampleCount: number;
			domain: string;
		};
		expect(manifest.id).toBe(`eval-instance-${id}`);
		expect(manifest.domain).toBe("eval.consultation");
		expect(manifest.sampleCount).toBe(2);
		expect(manifest.version).toMatch(/^v2-[0-9a-f]{8}$/);
		await rt.dispose();
	});

	it("selected mode snapshots def personas and generates via the endpoint", async () => {
		const { rt, run, db } = make({ factory: "ok" });
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
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
		const items = await db.select().from(evalInstanceItem);
		expect(items[0]?.scriptMode).toBe("llm");
		expect(items[0]?.script).toContain("dor de cabeça");
		await rt.dispose();
	});

	it("falls back to template when the endpoint resolve fails", async () => {
		const { rt, run, db } = make({ factory: "fail" });
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		await run(seedDefs(1));
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
		const items = await db.select().from(evalInstanceItem);
		expect(items[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("falls back to template when the endpoints service errors typed", async () => {
		const { rt, run, db, d1 } = make({ factory: "ok", endpoints: "fail" });
		await run(seedDefs(1));
		// A raw endpoint row satisfies the FK — the stub never reads it.
		await d1.exec(
			"INSERT INTO ai_endpoint (name, kind, base_url, scope, created_at) VALUES ('ep', 'openai', 'http://x', 'eval', 1)",
		);
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "tf", mode: "random", count: 1, endpointId: 1 }),
			),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const items = await db.select().from(evalInstanceItem);
		expect(items[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("runs standalone without the ai-provider plugin bound", async () => {
		const { rt, run, d1 } = make({ endpoints: false });
		await run(seedDefs(1));
		// A raw endpoint row satisfies the FK — nothing resolves it
		// without the plugin bound.
		await d1.exec(
			"INSERT INTO ai_endpoint (name, kind, base_url, scope, created_at) VALUES ('ep', 'openai', 'http://x', 'eval', 1)",
		);
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "sa", mode: "random", count: 1, endpointId: 1 }),
			),
		);
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.endpointName).toBeNull();
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const dd = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (dd?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const done = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(done?.status).toBe("ready");
		const rows = await run(Effect.flatMap(EvalInstances, (s) => s.list()));
		expect(rows.find((r) => r.id === id)?.endpointName).toBeNull();
		await rt.dispose();
	});

	it("falls back to template on unparseable llm output", async () => {
		const { rt, run, db } = make({ factory: "bad" });
		await run(seedDefs(1));
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
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
		const items = await db.select().from(evalInstanceItem);
		expect(items[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("marks items error on per-item defects — the run still completes", async () => {
		const { rt, run, db, d1 } = make();
		await run(seedDefs(2));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "iso", mode: "random", count: 2 })),
		);
		// Dropping `patients` makes every item's synthetic-entity
		// insert reject — a defect the per-item isolation converts to
		// an error row.
		await d1.exec("DROP TABLE patients");
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		let d;
		for (let i = 0; i < 50; i++) {
			d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(d?.status).toBe("failed");
		expect(d?.items.every((it) => it.status === "error" && it.error !== null)).toBe(true);
		// A failed instance still records the manifest of the partial
		// corpus it attempted — sampleCount honestly reports 0 done.
		const [instRow] = await db.select().from(evalInstance);
		expect(JSON.parse(instRow?.manifest ?? "{}")).toMatchObject({
			id: `eval-instance-${id}`,
			sampleCount: 0,
		});
		await rt.dispose();
	});

	it("marks the instance failed on catastrophic defects", async () => {
		const { rt, run, d1 } = make();
		await run(seedDefs(1));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "cat", mode: "random", count: 1 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		// The items scan is init-level: its defect marks the instance
		// `failed` — detail still rejects on the missing table, so
		// rename it back before reading the row.
		await d1.exec("ALTER TABLE eval_instance_item RENAME TO eval_instance_item_bak");
		await expect(run(Effect.flatMap(EvalInstances, (s) => s.detail(id)))).rejects.toThrow();
		await d1.exec("ALTER TABLE eval_instance_item_bak RENAME TO eval_instance_item");
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.status).toBe("failed");
		await rt.dispose();
	});

	it("list drives generation — polls advance items without detail", async () => {
		const { rt, run } = make();
		await run(seedDefs(1));
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
		await run(seedDefs(1));
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
		// The tick sees the in-flight claim and must NOT finalize.
		await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.status).toBe("generating");
		await rt.dispose();
	});

	it("reclaims a stale generating claim — the run reaches ready", async () => {
		const { rt, run, db } = make();
		await run(seedDefs(1));
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
		// Tick 1 reclaims the stale claim and generates it; tick 2
		// finalizes; tick 3 confirms.
		await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.status).toBe("ready");
		expect(d?.items[0]?.status).toBe("done");
		expect(d?.items[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("finalizes ready when an instance has zero items", async () => {
		const { rt, run, db } = make();
		// Zero-item instances can't come from create (random rejects on
		// an empty registry, selected needs ≥1 def) — seed the row.
		const [inst] = await db
			.insert(evalInstance)
			.values({ name: "empty", mode: "random", params: "{}", createdAt: new Date() })
			.returning();
		await run(Effect.flatMap(EvalInstances, (s) => s.start(inst!.id)));
		// The first poll finalizes the empty item set.
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(inst!.id)));
		expect(d?.status).toBe("ready");
		// No items → no manifest (nothing to pin).
		const [row] = await db.select().from(evalInstance);
		expect(row?.manifest).toBeNull();
		await rt.dispose();
	});

	it("swallows tick defects — polls keep flowing on broken tables", async () => {
		const { rt, run, d1 } = make();
		await run(seedDefs(1));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "cat", mode: "random", count: 1 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		await d1.exec("DROP TABLE eval_instance_item");
		// The FIRST detail's tick hits the dropped items table — the
		// init-level catch marks the instance failed and tickQuietly
		// swallows the defect; detail then fails on its own select.
		// The SECOND detail's tick returns early (status `failed`) and
		// the select still throws.
		await expect(run(Effect.flatMap(EvalInstances, (s) => s.detail(id)))).rejects.toThrow();
		await expect(run(Effect.flatMap(EvalInstances, (s) => s.detail(id)))).rejects.toThrow();
		await rt.dispose();
	});

	it("skips the llm layer for disabled endpoints — template generation", async () => {
		const { rt, run, db } = make({ factory: "ok" });
		await run(seedDefs(1));
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		await run(Effect.flatMap(AiEndpoints, (s) => s.update({ ...EP, id: epId, enabled: false })));
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
		const items = await db.select().from(evalInstanceItem);
		expect(items[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("falls back to template when the llm generate call itself fails", async () => {
		const { rt, run, db } = make({ factory: "genfail" });
		await run(seedDefs(1));
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
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
		const items = await db.select().from(evalInstanceItem);
		expect(items[0]?.scriptMode).toBe("template");
		await rt.dispose();
	});

	it("detail survives corrupt persona JSON and deleted endpoints", async () => {
		const { rt, run, db } = make();
		await run(seedDefs(1));
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) =>
				s.create({ name: "corrupt", mode: "random", count: 1, endpointId: epId }),
			),
		);
		await db
			.update(evalInstanceItem)
			.set({ persona: "{not json" })
			.where(eq(evalInstanceItem.instanceId, id));
		await run(Effect.flatMap(AiEndpoints, (s) => s.remove(epId)));
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.items[0]?.persona).toEqual({});
		expect(d?.endpointName).toBeNull();
		expect(d?.endpointId).toBeNull();
		await rt.dispose();
	});

	it("detail renders a null persona snapshot as null", async () => {
		const { rt, run, db } = make();
		await run(seedDefs(1));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "np", mode: "random", count: 1 })),
		);
		await db
			.update(evalInstanceItem)
			.set({ persona: null })
			.where(eq(evalInstanceItem.instanceId, id));
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.items[0]?.persona).toBeNull();
		await rt.dispose();
	});

	it("generates a male doctor for personas with a male doctor", async () => {
		const { rt, run, db } = make();
		await run(
			Effect.flatMap(EvalPersonas, (s) =>
				s.create({
					name: "male-doc",
					persona: { ...persona, doctor: { gender: "m", register: "neutral" } },
				}),
			),
		);
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "md", mode: "random", count: 1 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const docs = await db.select().from(doctors);
		expect(docs[0]?.displayName).toMatch(/^Dr\./);
		await rt.dispose();
	});

	it("removes instances and their items (cascade)", async () => {
		const { rt, run, db } = make();
		await run(seedDefs(1));
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
		await run(seedDefs(1));
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
		await run(seedDefs(1));
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
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)))).rejects.toMatchObject({
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

	it("instances loader lists no endpoints without the ai-provider plugin", async () => {
		const { rt, run } = make({ endpoints: false });
		const instancesPage = pages[1]!;
		const data = (await run(instancesPage.loader!() as Effect.Effect<unknown, never, unknown>)) as {
			instances: readonly unknown[];
			defs: readonly unknown[];
			endpoints: readonly unknown[];
		};
		expect(data.endpoints).toEqual([]);
		await rt.dispose();
	});
});

describe("EvalInstances — edge inputs", () => {
	it("random mode without a count defaults to the whole registry", async () => {
		const { rt, run } = make();
		await run(seedDefs(2));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "bare", mode: "random" })),
		);
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.total).toBe(2);
		expect(d?.items).toHaveLength(2);
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

	it("rejects random mode on an empty persona registry", async () => {
		const { rt, run } = make();
		await expect(
			run(Effect.flatMap(EvalInstances, (s) => s.create({ name: "empty", mode: "random" }))),
		).rejects.toMatchObject({ _tag: "InstanceRejected" });
		await rt.dispose();
	});

	it("birth dates follow the persona age band", async () => {
		const { rt, run, db } = make();
		const year = new Date().getFullYear();
		await run(
			Effect.forEach(
				[
					{ ...persona, ageBand: "teen" },
					{ ...persona, ageBand: "adult" },
				],
				(p) => Effect.flatMap(EvalPersonas, (s) => s.create({ name: p.ageBand, persona: p })),
				{ discard: true },
			),
		);
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "bands", mode: "random", count: 2 })),
		);
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		for (let i = 0; i < 50; i++) {
			const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const pats = await db.select().from(patients);
		const byDate = (a: string | null, b: string | null) => String(a).localeCompare(String(b));
		expect(pats.map((p) => p.birthDate).sort(byDate)).toEqual(
			[`${year - 15}-01-01`, `${year - 35}-01-01`].sort(byDate),
		);
		await rt.dispose();
	});

	it("a defect inside tick is swallowed by the poll wrapper", async () => {
		const { rt, run, d1 } = make();
		await run(Effect.flatMap(EvalPersonas, (s) => s.create({ name: "d", persona })));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "defect", mode: "random", count: 1 })),
		);
		// Renaming the table makes tick's first select reject — a defect
		// the quietly wrapper must swallow; detail's own read then fails.
		await d1.exec("ALTER TABLE eval_instance RENAME TO eval_instance_bak");
		await expect(run(Effect.flatMap(EvalInstances, (s) => s.detail(id)))).rejects.toThrow();
		await rt.dispose();
	});

	it("endpoint without optional fields resolves to a bare descriptor", async () => {
		const { rt, run } = make({ factory: "ok" });
		await run(seedDefs(1));
		const { id: epId } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
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

	it("random mode with count 0 creates an instance with no items", async () => {
		const { rt, run } = make();
		await run(seedDefs(2));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "zero", mode: "random", count: 0 })),
		);
		const d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
		expect(d?.total).toBe(0);
		expect(d?.items).toHaveLength(0);
		await rt.dispose();
	});

	it("marks the item error when its persona snapshot is null", async () => {
		const { rt, run, db } = make();
		await run(seedDefs(1));
		const { id } = await run(
			Effect.flatMap(EvalInstances, (s) => s.create({ name: "nop", mode: "random", count: 1 })),
		);
		await db
			.update(evalInstanceItem)
			.set({ persona: null })
			.where(eq(evalInstanceItem.instanceId, id));
		await run(Effect.flatMap(EvalInstances, (s) => s.start(id)));
		let d;
		for (let i = 0; i < 50; i++) {
			d = await run(Effect.flatMap(EvalInstances, (s) => s.detail(id)));
			if (d?.status !== "generating") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(d?.items[0]?.status).toBe("error");
		expect(d?.items[0]?.error).toContain("no resolved persona");
		await rt.dispose();
	});
});

describe("EvalPersonas — principal and descriptor edges", () => {
	it("records createdBy null when the principal has no email", async () => {
		const { rt, run, db } = make({ email: false });
		await run(Effect.flatMap(EvalPersonas, (s) => s.create({ name: "d", persona })));
		await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
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
			Effect.flatMap(AiEndpoints, (s) =>
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
		const rows = await db.select().from(evalInstanceItem);
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
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
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
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
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
		const { id: epId } = await bound.run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		await bound.run(
			Effect.flatMap(AiEndpoints, (s) => s.update({ ...EP, id: epId, enabled: false })),
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
		const { id: ep2 } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		const noFactory = await run(
			Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 1, endpointId: ep2 })),
		);
		expect(noFactory.created).toBe(1);
		await rt.dispose();
	});

	it("falls back to sampling when the endpoints service errors typed", async () => {
		const { rt, run } = make({ factory: "ok", endpoints: "fail" });
		const r = await run(
			Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 2, endpointId: 1 })),
		);
		expect(r.created).toBe(2);
		const listed = await run(Effect.flatMap(EvalPersonas, (s) => s.list()));
		expect(listed.every((d) => d.notes?.includes("sampled"))).toBe(true);
		await rt.dispose();
	});

	it("falls back to sampling when the llm resolve/generate/parse fails", async () => {
		for (const factory of ["fail", "bad", "genfail", "broken"] as const) {
			const { rt, run } = make({ factory });
			const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
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

	it("clamps incoherent llm persona fields to plausible values", async () => {
		const { rt, run } = make({ factory: "json2" });
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		const r = await run(
			Effect.flatMap(EvalPersonas, (s) => s.generate({ count: 5, endpointId: epId })),
		);
		expect(r.created).toBe(5);
		const listed = await run(Effect.flatMap(EvalPersonas, (s) => s.list()));
		const byName = new Map(listed.map((d) => [d.name, d.persona] as const));
		// pediatrics forces a minor band; already-minor bands pass through.
		expect(byName.get("clamp-peds-adult")?.ageBand).toBe("child");
		expect(byName.get("clamp-peds-child")?.ageBand).toBe("child");
		expect(byName.get("clamp-peds-teen")?.ageBand).toBe("teen");
		// education is clamped to fit the age band.
		expect(byName.get("clamp-child")?.education).toBe("primary");
		expect(byName.get("clamp-teen")?.education).toBe("secondary");
		await rt.dispose();
	});
});

describe("EvalInstances.spawn", () => {
	it("fans out random-mode generator instances with seeded params", async () => {
		const { rt, run, db } = make();
		await run(seedDefs(2));
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
		const { id: epId } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		await run(seedDefs(1));
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
		await run(seedDefs(1));
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

	it("rejects and rolls back when the persona registry is empty", async () => {
		const { rt, run, db } = make();
		await expect(run(Effect.flatMap(EvalInstances, (s) => s.spawn({ count: 1 })))).rejects.toThrow(
			"random mode needs personas",
		);
		expect(await db.select().from(evalInstance)).toHaveLength(0);
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
