import { describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { doctors, patients, user as userTable } from "@ktb/db/schema";
import { Forbidden, Principal } from "@ktb/authz";
import { EvalArtifacts, EvalRunner, LlmPort } from "@ktb/eval-consultation";
import { Permissions } from "@ktb/rbac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import type { BatchSummary } from "./index.ts";
import {
	EVAL_VALIDATOR_TEST_DDL,
	evalValidatorPanelPlugin,
	EvalValidator,
	EvalValidatorLive,
} from "./index.ts";
import { evalPersona, evalPersonaBatch, evalRun, evalRunSample } from "./schema.ts";

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

const runnerLayer = (impl?: Parameters<typeof EvalRunner.of>[0]["run"]) =>
	Layer.succeed(
		EvalRunner,
		EvalRunner.of({
			run:
				impl ??
				(({ items, onSample }) =>
					Effect.forEach(
						items,
						(item) =>
							onSample(item.id, {
								status: "ok",
								result: { asrText: item.script, wer: 0.01 },
							}),
						{ discard: true },
					)),
		}),
	);

const artifactsLayer = (bytes: Uint8Array | null | "fail") =>
	Layer.succeed(
		EvalArtifacts,
		EvalArtifacts.of({
			getAudio: () =>
				bytes === "fail"
					? (Effect.fail({ _tag: "PortError", port: "a", message: "io" }) as never)
					: Effect.succeed(bytes),
		}),
	);

/** Stub generator: "fail" → PortError (exercises the template
 * fallback); text → the LLM script path. */
const llmLayer = (result: string | "fail") =>
	Layer.succeed(
		LlmPort,
		LlmPort.of({
			generate: () =>
				result === "fail"
					? (Effect.fail({ _tag: "PortError", port: "llm", message: "down" }) as never)
					: Effect.succeed({ text: result, record: {} as never }),
			correct: () => Effect.fail({ _tag: "PortError", port: "llm", message: "down" }) as never,
		}),
	);

const make = (
	opts: {
		allow?: boolean;
		/** "none" = no EvalRunner bound; absent = default ok-runner. */
		runner?: "none" | Parameters<typeof runnerLayer>[0];
		/** Absent = no EvalArtifacts bound; value = driver returning it. */
		artifacts?: Uint8Array | null | "fail";
		/** Absent = no LlmPort bound (template path); value = stub. */
		llm?: string | "fail";
	} = {},
) => {
	const { allow = true, runner } = opts;
	const db = makeDb(makeD1(EVAL_VALIDATOR_TEST_DDL));
	const layers = Layer.mergeAll(
		Layer.succeed(Db, db as unknown as DbClient),
		grantLayer(allow),
		runner === "none" ? Layer.empty : runnerLayer(runner),
		"artifacts" in opts ? artifactsLayer(opts.artifacts ?? null) : Layer.empty,
		"llm" in opts ? llmLayer(opts.llm ?? "fail") : Layer.empty,
	);
	const rt = ManagedRuntime.make(
		Layer.merge(EvalValidatorLive.pipe(Layer.provide(layers)), layers),
	);
	// The service methods declare `unknown` env (the runtime supplies
	// Permissions/Db); provideService then narrows Principal — cast is
	// the test-only erasure, same contract as runAs.
	const run = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		rt.runPromise(
			Effect.provideService(effect, Principal, {
				userId: "u1",
				email: "v@x.com",
			}) as Effect.Effect<A, E>,
		);
	return { rt, run, db };
};

describe("EvalValidator", () => {
	it("denies every method without the eval.validator grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(run(Effect.flatMap(EvalValidator, (v) => v.listBatches()))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			run(Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1 }))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await rt.dispose();
	});

	it("generate → review → startRun → progress lands the full workflow", async () => {
		const { rt, run } = make({ runner: "none" });
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 2, seed: 42 })),
		);
		const batches = await run(Effect.flatMap(EvalValidator, (v) => v.listBatches()));
		expect(batches[0]?.count).toBe(2);
		expect(batches[0]?.pending).toBe(2);

		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		expect(personas).toHaveLength(2);
		// Persona enrichment surfaced to the validator card.
		expect(personas[0]?.persona.gender).toBeDefined();
		expect(personas[0]?.persona.doctor).toBeDefined();
		expect(personas[0]?.turns.length).toBeGreaterThan(10);

		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[0]!.id, decision: "approved", feedback: "ok" }),
			),
		);
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[1]!.id, decision: "rejected", feedback: "too formal" }),
			),
		);
		const after = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		expect(after[0]?.state).toBe("approved");
		expect(after[1]?.feedback).toBe("too formal");

		// No runner bound → only approved personas enter the run; it
		// stays queued rather than pretending to execute.
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun(batchId)));
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
		expect(progress?.status).toBe("queued");
		expect(progress?.total).toBe(1);
		expect(progress?.samples).toHaveLength(1);
		await rt.dispose();
	});

	it("runner bound → per-sample outcomes persist and the run finishes", async () => {
		const { rt, run } = make();
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 7 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[0]!.id, decision: "approved" }),
			),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun(batchId)));
		// The forked run needs a tick to land — poll briefly.
		let progress = null;
		for (let i = 0; i < 50; i++) {
			progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (progress?.status === "done") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(progress?.status).toBe("done");
		expect(progress?.done).toBe(1);
		expect(progress?.samples[0]?.status).toBe("ok");
		expect(JSON.parse(progress?.samples[0]?.result ?? "{}").wer).toBe(0.01);
		await rt.dispose();
	});

	it("a failing runner still lands the run as done (failure logged, not lost)", async () => {
		const { rt, run } = make({
			runner: ({ items, onSample }) =>
				Effect.forEach(
					items,
					(item) => onSample(item.id, { status: "failed", error: "tts exploded" }),
					{ discard: true },
				),
		});
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 9 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[0]!.id, decision: "approved" }),
			),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun(batchId)));
		let progress = null;
		for (let i = 0; i < 50; i++) {
			progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (progress?.status === "done") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(progress?.status).toBe("done");
		await rt.dispose();
	});

	it("a runner that throws wholesale still finishes the run row", async () => {
		const { rt, run } = make({
			runner: () => Effect.fail(new Error("runner crashed")) as never,
		});
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 11 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[0]!.id, decision: "approved" }),
			),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun(batchId)));
		let progress = null;
		for (let i = 0; i < 50; i++) {
			progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (progress?.status === "done" || progress?.status === "failed") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(progress?.status).toBe("done");
		await rt.dispose();
	});

	it("an empty batch still summarizes — zero counts, no persona rows", async () => {
		const { rt, run } = make({ runner: "none" });
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 0, seed: 3 })),
		);
		const [b] = await run(Effect.flatMap(EvalValidator, (v) => v.listBatches()));
		expect(b?.id).toBe(batchId);
		expect(b?.count).toBe(0);
		expect(b?.approved).toBe(0);
		expect(b?.state).toBe("empty");
		await rt.dispose();
	});

	it("review without feedback stores nulls, reviewer falls back when no email", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 4 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		// Principal without email → reviewedBy null (the ?? branch).
		const [p] = await rt
			.runPromise(
				Effect.provideService(
					Effect.flatMap(EvalValidator, (v) =>
						v.review({ personaId: personas[0]!.id, decision: "rejected" }),
					),
					Principal,
					{ userId: "u2" } as never,
				) as Effect.Effect<unknown>,
			)
			.then(() => db.select().from(evalPersona));
		expect(p?.feedback).toBeNull();
		expect(p?.reviewedBy).toBeNull();
		await rt.dispose();
	});

	it("generate without a seed falls back to 100, mixed review lands as mixed", async () => {
		const { rt, run } = make({ runner: "none" });
		const { batchId } = await run(Effect.flatMap(EvalValidator, (v) => v.generate({ count: 2 })));
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[0]!.id, decision: "approved" }),
			),
		);
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[1]!.id, decision: "rejected" }),
			),
		);
		const [b] = await run(Effect.flatMap(EvalValidator, (v) => v.listBatches()));
		expect(b?.state).toBe("mixed");
		const allApproved = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 6 })),
		);
		const [p2] = await run(
			Effect.flatMap(EvalValidator, (v) => v.listPersonas(allApproved.batchId)),
		);
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ personaId: p2!.id, decision: "approved" })),
		);
		const bs = await run(Effect.flatMap(EvalValidator, (v) => v.listBatches()));
		expect(bs.find((x) => x.id === allApproved.batchId)?.state).toBe("approved");
		await rt.dispose();
	});

	it("an all-rejected batch lands as rejected; a total-0 run has pct 0", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 5 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[0]!.id, decision: "rejected" }),
			),
		);
		const [b] = await run(Effect.flatMap(EvalValidator, (v) => v.listBatches()));
		expect(b?.state).toBe("rejected");
		const [r] = await db.insert(evalRun).values({ batchId, total: 0 }).returning();
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(r!.id)));
		expect(progress?.pct).toBe(0);
		await rt.dispose();
	});

	it("generate with LlmPort bound renders llm scripts and links synthetic entities", async () => {
		const llmScript = [
			"doctor: Bom dia, como posso ajudar?",
			"patient: Estou com dor de cabeça faz uns dias.",
			"doctor: Onde exatamente dói?",
			"patient: Na testa, uma pressão.",
			"doctor: E usa algum remédio?",
			"patient: Só dipirona quando aperta.",
		].join("\n");
		const { rt, run, db } = make({ runner: "none", llm: llmScript });
		// count=3 samples three matrix cells — covers every ageBand
		// (child/adult/elderly) through birthDateFor.
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 3, seed: 42 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		expect(personas).toHaveLength(3);
		for (const p of personas) {
			expect(p.scriptMode).toBe("llm");
			expect(p.turns[0]).toEqual({ speaker: "doctor", text: "Bom dia, como posso ajudar?" });
			expect(p.script).toContain("dor de cabeça");
			// Labels stay OUT of the gold script (template convention).
			expect(p.script).not.toContain("doctor:");
			expect(p.patientId).not.toBeNull();
			expect(p.doctorId).not.toBeNull();
		}
		// Entities exist, flagged synthetic, owned by the synthetic user.
		const pats = await db.select().from(patients);
		expect(pats).toHaveLength(3);
		expect(pats.every((r) => r.synthetic === true)).toBe(true);
		const docs = await db.select().from(doctors);
		expect(docs).toHaveLength(3);
		expect(docs.every((r) => r.synthetic === true)).toBe(true);
		const users = await db.select().from(userTable);
		expect(users.every((u) => u.email.endsWith("@eval.ktb"))).toBe(true);
		await rt.dispose();
	});

	it("a failing LlmPort falls back to the template renderer", async () => {
		const { rt, run } = make({ runner: "none", llm: "fail" });
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 7 })),
		);
		const [p] = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		expect(p?.scriptMode).toBe("template");
		expect(p?.turns.length).toBeGreaterThan(4);
		await rt.dispose();
	});

	it("rejecting a persona deletes its synthetic entities, approving keeps them", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 2, seed: 9 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		expect(personas[0]?.patientId).not.toBeNull();
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[0]!.id, decision: "approved" }),
			),
		);
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[1]!.id, decision: "rejected" }),
			),
		);
		// Rejected: patient + backing doctor user gone (doctor row
		// cascades from user). Approved: entities stay for the run.
		expect(await db.select().from(patients)).toHaveLength(1);
		expect(await db.select().from(userTable)).toHaveLength(1);
		expect(await db.select().from(doctors)).toHaveLength(1);
		const after = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		expect(after[1]?.state).toBe("rejected");
		// FK set null released the links — the review row itself stays.
		expect(after[1]?.patientId).toBeNull();
		expect(after[1]?.doctorId).toBeNull();
		await rt.dispose();
	});

	it("generate with an email-less principal stores createdBy null", async () => {
		const { rt, db } = make({ runner: "none" });
		await rt.runPromise(
			Effect.provideService(
				Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1 })),
				Principal,
				{ userId: "u2" } as never,
			) as Effect.Effect<unknown>,
		);
		const [b] = await db.select().from(evalPersonaBatch);
		expect(b?.createdBy).toBeNull();
		await rt.dispose();
	});

	it("progress aggregates slices by axis and degrades missing keys to '—'", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { eq } = await import("drizzle-orm");
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 2, seed: 4 })),
		);
		const [p1, p2] = await db.select().from(evalPersona).where(eq(evalPersona.batchId, batchId));
		// Persona JSON missing most axes → the "—" bucket.
		await db
			.update(evalPersona)
			.set({ persona: JSON.stringify({ region: "south" }) })
			.where(eq(evalPersona.id, p2!.id));
		const [r] = await db.insert(evalRun).values({ batchId, total: 2 }).returning();
		await db.insert(evalRunSample).values({
			runId: r!.id,
			personaId: p1!.id,
			status: "ok",
			result: JSON.stringify({ wer: 0.2 }),
		});
		await db.insert(evalRunSample).values({
			runId: r!.id,
			personaId: p2!.id,
			status: "pending",
		});
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(r!.id)));
		const gender = progress?.aggregates.find((a) => a.axis === "gender");
		expect(gender?.slices.some((s) => s.key === "—")).toBe(true);
		const region = progress?.aggregates.find((a) => a.axis === "region");
		const south = region?.slices.find((s) => s.key === "south");
		expect(south).toMatchObject({ samples: 1, ok: 0, meanWer: null });
		const okSlice = region?.slices.find((s) => s.ok === 1);
		expect(okSlice?.meanWer).toBe(0.2);
		await rt.dispose();
	});

	it("parseJson falls back on malformed stored JSON", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 1 })),
		);
		// Corrupt the persona JSON in place — the card read must
		// degrade, not throw.
		const { eq } = await import("drizzle-orm");
		await db
			.update(evalPersona)
			.set({ persona: "{broken json" })
			.where(eq(evalPersona.batchId, batchId));
		const cards = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		expect(cards[0]?.persona).toEqual({});
		await rt.dispose();
	});

	it("sampleAudio streams bytes through EvalArtifacts, null without it", async () => {
		const { eq } = await import("drizzle-orm");
		const seedRun = async (
			run: <A, E>(e: Effect.Effect<A, E, unknown>) => Promise<A>,
			db: DbClient,
		) => {
			const { batchId } = await run(
				Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 2 })),
			);
			const [p] = await db.select().from(evalPersona).where(eq(evalPersona.batchId, batchId));
			const [r] = await db.insert(evalRun).values({ batchId }).returning();
			const [s] = await db
				.insert(evalRunSample)
				.values({
					runId: r!.id,
					personaId: p!.id,
					status: "ok",
					result: JSON.stringify({ audioUri: "file:///work/tts/audio/a.wav" }),
				})
				.returning();
			return s!.id;
		};

		const withDriver = make({ runner: "none", artifacts: new Uint8Array([1, 2, 3]) });
		const sampleId = await seedRun(withDriver.run, withDriver.db);
		const bytes = await withDriver.rt.runPromise(
			Effect.provideService(
				Effect.flatMap(EvalValidator, (v) => v.sampleAudio(sampleId)),
				Principal,
				{ userId: "u", email: "e" },
			) as Effect.Effect<Uint8Array | null>,
		);
		expect(bytes ? [...bytes] : null).toEqual([1, 2, 3]);
		await withDriver.rt.dispose();

		// Same row, no artifacts driver bound → honest null (route 404s).
		const noDriver = make({ runner: "none" });
		const sampleId2 = await seedRun(noDriver.run, noDriver.db);
		const missing = await noDriver.rt.runPromise(
			Effect.provideService(
				Effect.flatMap(EvalValidator, (v) => v.sampleAudio(sampleId2)),
				Principal,
				{ userId: "u", email: "e" },
			) as Effect.Effect<Uint8Array | null>,
		);
		expect(missing).toBeNull();
		await noDriver.rt.dispose();

		// Driver bound but the read fails → catch degrades to null.
		const failing = make({ runner: "none", artifacts: "fail" });
		const sampleId3 = await seedRun(failing.run, failing.db);
		const ioError = await failing.rt.runPromise(
			Effect.provideService(
				Effect.flatMap(EvalValidator, (v) => v.sampleAudio(sampleId3)),
				Principal,
				{ userId: "u", email: "e" },
			) as Effect.Effect<Uint8Array | null>,
		);
		expect(ioError).toBeNull();
		await failing.rt.dispose();
	});

	it("panel guard follows the permission, loader yields batch list or []", async () => {
		const allow = make();
		const page = evalValidatorPanelPlugin.panel!.pages[0]!;
		const guardOk = await allow.rt.runPromise(
			Effect.provideService(page.guard!(), Principal, {
				userId: "u",
				email: "e",
			}) as Effect.Effect<boolean>,
		);
		expect(guardOk).toBe(true);
		const batches = await allow.rt.runPromise(
			Effect.provideService(page.loader!(), Principal, {
				userId: "u",
				email: "e",
			}) as Effect.Effect<readonly BatchSummary[]>,
		);
		expect(Array.isArray(batches)).toBe(true);
		await allow.rt.dispose();

		const deny = make({ allow: false });
		const guardNo = await deny.rt.runPromise(
			Effect.provideService(page.guard!(), Principal, {
				userId: "u",
				email: "e",
			}) as Effect.Effect<boolean>,
		);
		expect(guardNo).toBe(false);
		const loaderFallback = await deny.rt.runPromise(
			Effect.provideService(page.loader!(), Principal, {
				userId: "u",
				email: "e",
			}) as Effect.Effect<readonly BatchSummary[]>,
		);
		expect(loaderFallback).toEqual([]);
		await deny.rt.dispose();
	});
});

describe("EvalValidator — pipeline stages + run CRUD", () => {
	it("hands persona demographics to the runner as patient context", async () => {
		const seen: { patient?: { sex?: string; age?: number } }[] = [];
		const { rt, run } = make({
			runner: ({ items, onSample }) =>
				Effect.forEach(
					items,
					(item) => {
						seen.push(item);
						return onSample(item.id, { status: "ok", result: { wer: 0 } });
					},
					{ discard: true },
				),
		});
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 9, seed: 3 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		for (const p of personas) {
			await run(
				Effect.flatMap(EvalValidator, (v) => v.review({ personaId: p.id, decision: "approved" })),
			);
		}
		await run(Effect.flatMap(EvalValidator, (v) => v.startRun(batchId)));
		await new Promise((r) => setTimeout(r, 300));
		const ages = new Set(seen.map((i) => i.patient?.age));
		expect(ages.size).toBe(3);
		expect([...ages].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([8, 40, 70]);
		for (const i of seen) {
			expect(i.patient?.sex === "male" || i.patient?.sex === "female").toBe(true);
		}
		await rt.dispose();
	});

	it("run summary carries per-stage means when samples report them", async () => {
		const { rt, run } = make({
			runner: ({ items, onSample }) =>
				Effect.forEach(
					items,
					(item) =>
						onSample(item.id, {
							status: "ok",
							result: {
								wer: 0.2,
								cleanup: { edits: 3, corrected: "x", werAfter: 0.1, cerAfter: 0.05 },
								anamnesis: { engine: "stub", sections: 8, filled: 6, completeness: 0.75 },
							},
						}),
					{ discard: true },
				),
		});
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 5 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[0]!.id, decision: "approved" }),
			),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun(batchId)));
		let progress = null;
		for (let i = 0; i < 50; i++) {
			progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (progress?.status === "done") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		const s = progress?.summary as {
			meanWer?: number;
			meanWerAfter?: number;
			meanCompleteness?: number;
		} | null;
		expect(s?.meanWer).toBe(0.2);
		expect(s?.meanWerAfter).toBe(0.1);
		expect(s?.meanCompleteness).toBe(0.75);
		await rt.dispose();
	});

	it("deleteRun removes the run and cascades its samples", async () => {
		const { rt, run, db } = make();
		const { batchId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.generate({ count: 1, seed: 9 })),
		);
		const personas = await run(Effect.flatMap(EvalValidator, (v) => v.listPersonas(batchId)));
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ personaId: personas[0]!.id, decision: "approved" }),
			),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun(batchId)));
		await new Promise((r) => setTimeout(r, 200));
		expect(await db.select().from(evalRunSample)).not.toHaveLength(0);
		await run(Effect.flatMap(EvalValidator, (v) => v.deleteRun(runId)));
		expect(await db.select().from(evalRun)).toHaveLength(0);
		expect(await db.select().from(evalRunSample)).toHaveLength(0);
		expect(await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)))).toBeNull();
		await rt.dispose();
	});

	it("deleteRun is gated by the validator grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(run(Effect.flatMap(EvalValidator, (v) => v.deleteRun(1)))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await rt.dispose();
	});
});
