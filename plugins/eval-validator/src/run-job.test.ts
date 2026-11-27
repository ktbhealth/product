import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { consultations } from "@ktb/db/schema";

import { EvalRunner } from "@ktb/eval-consultation";
import { evalInstance, evalInstanceItem } from "@ktb/eval-persona";
import { jobHandlers } from "@ktb/jobs-port";
import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { EVAL_RUN_JOB_KIND, executeEvalRun, registerEvalRunJobHandler } from "./run-job.ts";
import { evalRun, evalRunSample } from "./schema.ts";

/** WS-E: eval.run job kind — payload decode, the DB-driven
 * executeEvalRun (pending-only resume), and the consumer handler's
 * ServerRuntime hop. */

const okRunner = (seen?: number[]) =>
	EvalRunner.of({
		run: ({ items, onSample }) =>
			Effect.forEach(
				items,
				(item) => {
					seen?.push(Number(item.id));
					return onSample(item.id, { status: "ok", result: { wer: 0.1 } });
				},
				{ discard: true },
			),
	});

/** Seed a cohort instance + N items + a queued run with one sample
 * per item in the given statuses (default: all pending). */
const seedRun = async (
	db: DbClient,
	input: { readonly statuses?: readonly ("pending" | "ok" | "failed")[] } = {},
) => {
	const statuses = input.statuses ?? ["pending"];
	const [inst] = await db
		.insert(evalInstance)
		.values({ name: "cohort", mode: "selected", params: "{}", createdAt: new Date() })
		.returning();
	const itemIds: number[] = [];
	for (let i = 0; i < statuses.length; i++) {
		const [item] = await db
			.insert(evalInstanceItem)
			.values({
				instanceId: inst!.id,
				persona: JSON.stringify({ gender: "f", ageBand: "adult" }),
				script: `script ${i}`,
				turns: "[]",
				voices: "{}",
				scriptMode: "template",
				status: "done",
				state: "approved",
				createdAt: new Date(),
			})
			.returning();
		itemIds.push(item!.id);
	}
	const [r] = await db
		.insert(evalRun)
		.values({
			instanceId: inst!.id,
			params: JSON.stringify({ instanceId: inst!.id, itemIds }),
			status: "queued",
			total: itemIds.length,
			createdAt: new Date(),
		})
		.returning();
	for (const [i, status] of statuses.entries()) {
		await db.insert(evalRunSample).values({
			runId: r!.id,
			itemId: itemIds[i]!,
			status,
			result: status === "ok" ? JSON.stringify({ wer: 0.5 }) : null,
			createdAt: new Date(),
		});
	}
	return { runId: r!.id, itemIds, instanceId: inst!.id };
};

const runtimes: ManagedRuntime.ManagedRuntime<unknown, never>[] = [];

/** Minimal ServerRuntime whose `run` executes inside a ManagedRuntime
 * over the given layer — the same shape apps/web wires via
 * setServerRuntime, minus the request-scoped capabilities the eval
 * path never touches. */
const runtimeFor = (layer: Layer.Layer<unknown, never, never>) => {
	const rt = ManagedRuntime.make(layer);
	runtimes.push(rt);
	setServerRuntime({
		run: ((effect: Effect.Effect<unknown, unknown, unknown>) =>
			rt.runPromise(effect as Effect.Effect<unknown, unknown, never>)) as ServerRuntime["run"],
		runAs: ((
			_user: { id: string; email?: string },
			effect: Effect.Effect<unknown, unknown, unknown>,
		) => rt.runPromise(effect as Effect.Effect<unknown, unknown, never>)) as ServerRuntime["runAs"],
		audioTranscribeModel: "test-model",
		getLocale: () => "en",
	});
	return rt;
};

const handler = () => {
	registerEvalRunJobHandler();
	const reg = jobHandlers[EVAL_RUN_JOB_KIND];
	if (reg === undefined) throw new Error("eval.run handler not registered");
	return reg;
};

const envelope = (runId: number) => ({
	id: `env-${runId}`,
	kind: EVAL_RUN_JOB_KIND,
	payload: { runId },
});

afterEach(async () => {
	resetServerRuntime();
	while (runtimes.length > 0) await runtimes.pop()!.dispose();
});

describe("eval.run job — executeEvalRun", () => {
	it("runs a queued run to done: pending samples execute, run flips running→done", async () => {
		const db = makeDb(makeTestD1());
		const { runId } = await seedRun(db, { statuses: ["pending", "pending"] });
		await Effect.runPromise(executeEvalRun(db, okRunner(), runId));
		const [run] = await db.select().from(evalRun);
		expect(run?.status).toBe("done");
		expect(run?.done).toBe(2);
		expect(run?.startedAt).not.toBeNull();
		expect(run?.finishedAt).not.toBeNull();
		expect(run?.experiment).not.toBeNull();
		const samples = await db.select().from(evalRunSample);
		expect(samples.map((s) => s.status)).toEqual(["ok", "ok"]);
	});

	it("resumes after a crash: only pending samples go back through the runner", async () => {
		const db = makeDb(makeTestD1());
		const { runId, itemIds } = await seedRun(db, {
			statuses: ["ok", "pending", "failed"],
		});
		const seen: number[] = [];
		await Effect.runPromise(executeEvalRun(db, okRunner(seen), runId));
		// The ok/failed samples keep their recorded outcomes — the
		// runner only saw the pending tail.
		expect(seen).toEqual([itemIds[1]]);
		const samples = await db.select().from(evalRunSample);
		expect(samples.map((s) => s.status)).toEqual(["ok", "ok", "failed"]);
		const [run] = await db.select().from(evalRun);
		expect(run?.status).toBe("done");
	});

	it("a wholesale runner failure lands the run failed, not stuck running", async () => {
		const db = makeDb(makeTestD1());
		const { runId } = await seedRun(db);
		const crashing = EvalRunner.of({ run: () => Effect.fail(new Error("boom")) as never });
		await Effect.runPromise(executeEvalRun(db, crashing, runId));
		const [run] = await db.select().from(evalRun);
		expect(run?.status).toBe("failed");
		expect(run?.experiment).not.toBeNull();
	});

	it("a missing/deleted run row is a succeed-no-op", async () => {
		const db = makeDb(makeTestD1());
		await Effect.runPromise(executeEvalRun(db, okRunner(), 9999));
		expect(await db.select().from(evalRun)).toHaveLength(0);
	});

	it("retries a failed run: flips back to running and keeps startedAt", async () => {
		const db = makeDb(makeTestD1());
		const { runId } = await seedRun(db);
		const startedAt = new Date("2026-01-02T03:04:05.000Z");
		await db
			.update(evalRun)
			.set({ status: "failed", startedAt, finishedAt: new Date(), summary: "{}" })
			.where(eq(evalRun.id, runId));
		await Effect.runPromise(executeEvalRun(db, okRunner(), runId));
		const [run] = await db.select().from(evalRun);
		expect(run?.status).toBe("done");
		// startedAt ?? new Date() — the retry keeps the original start.
		expect(run?.startedAt).toEqual(startedAt);
	});

	it("redelivers a done run idempotently: no pending samples reach the runner", async () => {
		const db = makeDb(makeTestD1());
		const { runId } = await seedRun(db, { statuses: ["ok", "ok"] });
		await db.update(evalRun).set({ status: "done" }).where(eq(evalRun.id, runId));
		const seen: number[] = [];
		await Effect.runPromise(executeEvalRun(db, okRunner(seen), runId));
		// pendingSamples empty → the item load is skipped entirely.
		expect(seen).toEqual([]);
		const [run] = await db.select().from(evalRun);
		expect(run?.status).toBe("done");
		expect(run?.done).toBe(2);
		expect(run?.experiment).not.toBeNull();
	});

	it("writes pipeline outputs back onto the item's synthetic consultations row", async () => {
		const db = makeDb(makeTestD1());
		const { runId, itemIds } = await seedRun(db);
		await db.insert(consultations).values({
			transcript: "gold script",
			evalItemId: itemIds[0],
			createdAt: new Date(),
		});
		const rich = EvalRunner.of({
			run: ({ items, onSample }) =>
				Effect.forEach(
					items,
					(item) =>
						onSample(item.id, {
							status: "ok",
							result: {
								wer: 0.2,
								asrText: "asr out",
								cleanup: { corrected: "cleaned out" },
								anamnesis: { engine: "acp", json: { filled: 3 } },
							},
						}),
					{ discard: true },
				),
		});
		await Effect.runPromise(executeEvalRun(db, rich, runId));
		const rows = await db.select().from(consultations);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.audioStatus).toBe("done");
		expect(rows[0]?.serverTranscript).toBe("asr out");
		expect(rows[0]?.correctedTranscript).toBe("cleaned out");
		expect(rows[0]?.engine).toBe("acp");
		expect(rows[0]?.anamnesis).toBe(JSON.stringify({ filled: 3 }));
	});

	it("skips the experiment projection when the run row disappears mid-run", async () => {
		const db = makeDb(makeTestD1());
		const { runId } = await seedRun(db);
		// Concurrent delete between the finalize update and the
		// experiment re-read — the projection must no-op, not throw.
		const deleting = EvalRunner.of({
			run: () => Effect.promise(() => db.delete(evalRun).where(eq(evalRun.id, runId))),
		});
		await Effect.runPromise(executeEvalRun(db, deleting, runId));
		expect(await db.select().from(evalRun)).toHaveLength(0);
	});

	it("pins the dataset from params.instanceId when the instance link is gone", async () => {
		const db = makeDb(makeTestD1());
		const { runId, instanceId } = await seedRun(db);
		// instance_id set-nulls when the cohort instance is deleted —
		// params.instanceId stays authoritative for the dataset pin.
		await db.update(evalRun).set({ instanceId: null }).where(eq(evalRun.id, runId));
		await Effect.runPromise(executeEvalRun(db, okRunner(), runId));
		const [run] = await db.select().from(evalRun);
		const experiment = JSON.parse(run?.experiment ?? "{}") as {
			dataset?: { id?: string };
		};
		expect(experiment.dataset?.id).toBe(`eval-instance-${instanceId}`);
	});

	it("falls back to an unknown dataset pin when neither link nor params survive", async () => {
		const db = makeDb(makeTestD1());
		const { runId } = await seedRun(db);
		await db.update(evalRun).set({ instanceId: null, params: "{}" }).where(eq(evalRun.id, runId));
		await Effect.runPromise(executeEvalRun(db, okRunner(), runId));
		const [run] = await db.select().from(evalRun);
		const experiment = JSON.parse(run?.experiment ?? "{}") as {
			dataset?: { id?: string };
		};
		expect(experiment.dataset?.id).toBe("eval-instance-unknown");
	});
});

describe("eval.run job — consumer handler", () => {
	it("registers under eval.run and decodes {runId} defensively", () => {
		const reg = handler();
		expect(reg.decodePayload!({ runId: 3 })).toEqual({ runId: 3 });
		// Poison payloads throw → the consumer marks failed + acks.
		expect(() => reg.decodePayload!({})).toThrow("Missing key");
		expect(() => reg.decodePayload!({ runId: "x" })).toThrow("Expected number");
		expect(() => reg.decodePayload!(null)).toThrow("Expected object");
	});

	it("handle throws when no ServerRuntime is registered", async () => {
		resetServerRuntime();
		const reg = handler();
		await expect(reg.handle({ runId: 1 }, envelope(1))).rejects.toThrow(/app runtime/);
	});

	it("handle executes the run inside the app runtime", async () => {
		const db = makeDb(makeTestD1());
		const { runId } = await seedRun(db);
		runtimeFor(
			Layer.mergeAll(
				Layer.succeed(Db, db as unknown as DbClient),
				Layer.succeed(EvalRunner, okRunner()),
			) as Layer.Layer<unknown, never, never>,
		);
		const reg = handler();
		await reg.handle({ runId }, envelope(runId));
		const [run] = await db.select().from(evalRun);
		expect(run?.status).toBe("done");
		const samples = await db.select().from(evalRunSample);
		expect(samples[0]?.status).toBe("ok");
	});

	it("handle fails the run honestly when no EvalRunner is bound", async () => {
		const db = makeDb(makeTestD1());
		const { runId } = await seedRun(db);
		// Db only — serviceOption(EvalRunner) is None inside the runtime.
		runtimeFor(Layer.succeed(Db, db as unknown as DbClient) as Layer.Layer<unknown, never, never>);
		const reg = handler();
		await reg.handle({ runId }, envelope(runId));
		const [run] = await db.select().from(evalRun);
		expect(run?.status).toBe("failed");
		expect(run?.summary).toContain("EvalRunner");
	});
});
