import { and, eq, inArray } from "drizzle-orm";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Db, type DbClient } from "@ktb/db";
import { consultations } from "@ktb/db/schema";
import { EvalRunner, type EvalRunnerItem, type Persona } from "@ktb/eval-consultation";
import { evalInstance, evalInstanceItem, type EvalInstanceItem } from "@ktb/eval-persona";
import { registerJobHandler } from "@ktb/jobs-port";
import { peekServerRuntime } from "@ktb/server-fns";

import { datasetPinFor, parseJson, runRecordRows, runToExperiment } from "./core-map.ts";
import { evalRun, evalRunRecord, evalRunSample } from "./schema.ts";

/**
 * WS-E (PL-009): eval run execution on the generic jobs queue
 * (@ktb/jobs-port). `startRun` enqueues `{runId}` under this kind; the
 * shared queue consumer dispatches it to the handler registered here,
 * which runs `executeEvalRun` inside the app runtime — the same body
 * the legacy request-scoped forkDetach path uses, so queue and inline
 * execution can't drift.
 */
export const EVAL_RUN_JOB_KIND = "eval.run";

/** Wire payload — decoded defensively at the consumer edge; a
 * malformed body is poison (acked, never retried). */
const EvalRunJobPayload = Schema.Struct({ runId: Schema.Number });

/** One corpus row → the runner's item — the item's own stored
 * script/turns/voices (never a regeneration) plus the demographic
 * slice handed to the anamnesis stage as `patient` context. Shared by
 * every path that builds runner items so they can't drift. Callers
 * filter `script !== null` first — `runnable` guaranteed it at insert
 * time, but the corpus row may have been edited since. */
export const toEvalRunnerItem = (item: EvalInstanceItem): EvalRunnerItem => ({
	id: item.id,
	/* v8 ignore next -- callers filter script !== null before mapping */
	script: item.script!,
	turns: parseJson(item.turns, []),
	voices: parseJson(item.voices, {}),
	patient:
		item.persona === null
			? {}
			: (() => {
					const persona = parseJson<Persona>(item.persona, {} as Persona);
					return {
						...(persona.gender !== undefined
							? { sex: persona.gender === "m" ? "male" : "female" }
							: /* v8 ignore next -- enrich always fills gender */ {}),
						...(persona.ageBand === "adult"
							? { age: 40 }
							: persona.ageBand === "elderly"
								? { age: 70 }
								: { age: 8 }),
					};
				})(),
});

/** WS-F: mirror a finished sample's pipeline outputs onto the item's
 * synthetic consultations row — the eval exercises the REAL record,
 * not a side channel: ASR text → serverTranscript, cleanup output →
 * correctedTranscript, extractor result → anamnesis/engine,
 * audioStatus → done. Only fields the runner actually produced are
 * written; items without a consultations row (pre-WS-F corpus) are a
 * no-op update. */
const consultationWriteBack = (db: DbClient, itemId: number, result: unknown): Promise<unknown> => {
	const r = result as {
		readonly asrText?: unknown;
		readonly cleanup?: { readonly corrected?: unknown };
		readonly anamnesis?: { readonly engine?: unknown; readonly json?: unknown };
	};
	const set: {
		audioStatus: string;
		serverTranscript?: string;
		correctedTranscript?: string;
		engine?: string;
		anamnesis?: string;
	} = { audioStatus: "done" };
	if (typeof r.asrText === "string") set.serverTranscript = r.asrText;
	if (typeof r.cleanup?.corrected === "string") set.correctedTranscript = r.cleanup.corrected;
	if (typeof r.anamnesis?.engine === "string") set.engine = r.anamnesis.engine;
	if (r.anamnesis?.json !== undefined) set.anamnesis = JSON.stringify(r.anamnesis.json);
	return db.update(consultations).set(set).where(eq(consultations.evalItemId, itemId));
};

/** Mark a run failed without touching terminal states — used when the
 * job lands where no EvalRunner is bound (prod workerd: the local
 * driver is dev:node-only) so the row never sits queued/running
 * forever pretending something will pick it up. */
const failRun = (db: DbClient, runId: number, error: string) =>
	Effect.promise(() =>
		db
			.update(evalRun)
			.set({
				status: "failed",
				finishedAt: new Date(),
				summary: JSON.stringify({ error }),
			})
			.where(and(eq(evalRun.id, runId), inArray(evalRun.status, ["queued", "running"]))),
	);

/**
 * Drive one eval run to completion — DB-sourced so it serves both the
 * queue consumer and the inline forkDetach fallback, and so a crashed
 * attempt RESUMES: only samples still `pending` go back through the
 * runner (a redelivery after a mid-run crash picks up the tail).
 *
 * Status ownership: a `queued` (or previously `failed`) row flips to
 * `running` here; `done` rows still flow through — their pending set
 * is empty so the runner no-ops and finalize rewrites identical
 * values (idempotent redelivery). A wholesale runner failure lands
 * `failed` via the finalize block, never a stuck `running`.
 */
export const executeEvalRun = Effect.fn("EvalValidator.executeEvalRun")(function* (
	db: DbClient,
	runner: EvalRunner["Service"],
	runId: number,
) {
	const runRows = yield* Effect.promise(() =>
		db.select().from(evalRun).where(eq(evalRun.id, runId)),
	);
	const run = runRows[0];
	// Deleted between enqueue and delivery — nothing to do.
	if (run === undefined) return;
	if (run.status === "queued" || run.status === "failed") {
		yield* Effect.promise(() =>
			db
				.update(evalRun)
				.set({ status: "running", startedAt: run.startedAt ?? new Date() })
				.where(eq(evalRun.id, run.id)),
		);
	}
	const pendingSamples = yield* Effect.promise(() =>
		db
			.select({ itemId: evalRunSample.itemId })
			.from(evalRunSample)
			.where(and(eq(evalRunSample.runId, run.id), eq(evalRunSample.status, "pending"))),
	);
	const itemRows =
		pendingSamples.length === 0
			? []
			: yield* Effect.promise(() =>
					db
						.select()
						.from(evalInstanceItem)
						.where(
							inArray(
								evalInstanceItem.id,
								pendingSamples.map((s) => s.itemId),
							),
						),
				);
	// Corpus rows deleted/edited after enqueue drop out — their samples
	// stay pending and land in the failed count at finalize.
	const items = itemRows.filter((item) => item.script !== null).map(toEvalRunnerItem);
	const runnerFailed = yield* runner
		.run({
			runId: run.id,
			items,
			onSample: (id, outcome) =>
				Effect.promise(async () => {
					await db
						.update(evalRunSample)
						.set({
							status: outcome.status,
							result: outcome.result === undefined ? null : JSON.stringify(outcome.result),
							error: outcome.error ?? null,
						})
						.where(and(eq(evalRunSample.runId, run.id), eq(evalRunSample.itemId, Number(id))));
					// Per-stage audit trail (WS-D): the runner's RunRecords
					// land as eval_run_record rows — itemId stays a soft ref
					// (no FK) so records survive corpus edits like
					// run.params does.
					if (outcome.records !== undefined && outcome.records.length > 0) {
						await db
							.insert(evalRunRecord)
							.values(runRecordRows(outcome.records, { runId: run.id, itemId: Number(id) }));
					}
					// WS-F: the sample's pipeline outputs land on the item's
					// synthetic consultations row.
					if (outcome.status === "ok" && outcome.result !== undefined) {
						await consultationWriteBack(db, Number(id), outcome.result);
					}
				}),
		})
		.pipe(
			// A wholesale runner failure must NOT leave the run
			// "running" forever — flag it so finalize lands `failed`
			// (with whatever samples landed).
			Effect.as(false),
			Effect.catch((error) =>
				Effect.logWarning("eval runner failed", { error: String(error) }).pipe(Effect.as(true)),
			),
		);
	const finished = yield* Effect.promise(() =>
		db.select().from(evalRunSample).where(eq(evalRunSample.runId, run.id)),
	);
	const ok = finished.filter((s) => s.status === "ok");
	const wers = ok
		.map((s) => parseJson<{ wer?: number }>(s.result, {}).wer)
		.filter((w): w is number => typeof w === "number");
	// Per-stage means — cleanup fidelity (WER after the corrector) and
	// anamnesis completeness, when the run exercised those stages.
	const werAfters = ok
		.map((s) => parseJson<{ cleanup?: { werAfter?: number } }>(s.result, {}).cleanup?.werAfter)
		.filter((w): w is number => typeof w === "number");
	const completeness = ok
		.map(
			(s) =>
				parseJson<{ anamnesis?: { completeness?: number } }>(s.result, {}).anamnesis?.completeness,
		)
		.filter((w): w is number => typeof w === "number");
	const mean = (xs: readonly number[]) =>
		xs.length ? xs.reduce((a, w) => a + w, 0) / xs.length : null;
	const summary = {
		ok: ok.length,
		failed: finished.length - ok.length,
		meanWer: mean(wers),
		meanWerAfter: mean(werAfters),
		meanCompleteness: mean(completeness),
	};
	yield* Effect.promise(() =>
		db
			.update(evalRun)
			.set({
				status: runnerFailed ? "failed" : "done",
				done: finished.length,
				summary: JSON.stringify(summary),
				finishedAt: new Date(),
			})
			.where(eq(evalRun.id, run.id)),
	);
	// Experiment projection (WS-D): re-read the run row — the captured
	// `run` predates the running/startedAt flip, and the summary above
	// must land inside the experiment's metrics bag. The dataset pin
	// resolves from the instance's stored manifest (params.instanceId
	// is authoritative: the column set-nulls when the instance is
	// deleted).
	const [runRow] = yield* Effect.promise(() =>
		db.select().from(evalRun).where(eq(evalRun.id, run.id)),
	);
	if (runRow !== undefined) {
		const paramsInstanceId = parseJson<{ instanceId?: number }>(runRow.params, {}).instanceId;
		const pinInstanceId = runRow.instanceId ?? paramsInstanceId ?? null;
		const instRows =
			pinInstanceId === null
				? []
				: yield* Effect.promise(() =>
						db
							.select({ manifest: evalInstance.manifest })
							.from(evalInstance)
							.where(eq(evalInstance.id, pinInstanceId)),
					);
		yield* Effect.promise(() =>
			db
				.update(evalRun)
				.set({
					experiment: JSON.stringify(
						runToExperiment(
							runRow,
							finished,
							datasetPinFor(instRows[0]?.manifest ?? null, pinInstanceId),
						),
					),
				})
				.where(eq(evalRun.id, run.id)),
		);
	}
});

/**
 * Register the eval.run consumer handler — called once at module
 * scope in index.ts (plugins are imported eagerly by app-host
 * discovery, so the registry is populated before any queue batch is
 * consumed).
 *
 * eval.run rides the in-app AUDIO_QUEUE transport ONLY: the handler
 * needs the app ServerRuntime (Db + EvalRunner live inside it), and
 * apps/jobs-worker (the Redis transport) has no such runtime — it only
 * ever sees jobs.ping today.
 */
export const registerEvalRunJobHandler = (): void => {
	registerJobHandler(EVAL_RUN_JOB_KIND, {
		// A malformed payload throws here → the consumer marks the run
		// failed and acks (poison is never retried).
		decodePayload: (payload) => Schema.decodeUnknownSync(EvalRunJobPayload)(payload),
		handle: async (payload) => {
			const rt = peekServerRuntime();
			if (rt === undefined) {
				throw new Error("eval.run requires the app runtime (setServerRuntime)");
			}
			const { runId } = payload as { readonly runId: number };
			await rt.run(
				Effect.gen(function* () {
					const db = yield* Db;
					const runner = yield* Effect.serviceOption(EvalRunner);
					if (Option.isNone(runner)) {
						// Honest failure — no silent stuck "queued" row.
						yield* failRun(
							db,
							runId,
							"no EvalRunner bound — eval runs need the local runner driver (dev:node)",
						);
						return;
					}
					yield* executeEvalRun(db, runner.value, runId);
				}),
			);
		},
	});
};
