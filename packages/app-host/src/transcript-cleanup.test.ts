import { describe, expect, it } from "vitest";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	loadOrchestrationRun,
	makeOrchestrationRunner,
	makeOrchestratorRegistry,
	OrchestratorRegistry,
	type JsonObject,
	type OrchestrationKind,
	type OrchestratorRegistryService,
} from "@ktb/orchestrator";
import {
	makePipelineRegistry,
	PipelineRegistry,
	PipelineStageError,
	type PipelinePack,
	type PipelineRegistryService,
	type PipelineStage,
} from "@ktb/pipeline";
import {
	EnvCorrector,
	transcriptPipelinePack,
	type EnvCorrectorFn,
} from "@ktb/plugin-pipeline-transcript";
import { makeTranscriptOrchestratorRegistry } from "@ktb/plugin-pipeline-transcript/orchestration";

import { correctTranscriptEffect } from "./transcript-cleanup.ts";

/**
 * Probe-order suite for the P-120 cutover: OrchestratorRegistry wins
 * when bound and knowing `consultation-transcript`; PipelineRegistry
 * is the transition fallback. Stub registries pin WHICH engine ran
 * (distinct corrected/engine markers) and exercise every failure arm;
 * the real transcript packs pin the envCorrect config plumbing on
 * each engine.
 */

const envCorrect: EnvCorrectorFn = (text) =>
	Effect.succeed({ corrected: `env:${text}`, engine: "env-x" });

const input = { text: "texto cru" };

const cleanupState = (cleanup: JsonObject): JsonObject => ({ cleanup });

/** OrchestratorRegistry stub whose single node writes `state`
 * verbatim — proves the orchestrator path ran. `run` overrides the
 * kind body for failure-path tests. */
const orchRegistry = (
	state: JsonObject,
	run?: OrchestrationKind["run"],
): OrchestratorRegistryService => {
	const kind: OrchestrationKind = {
		id: "stub.state",
		run: run ?? (() => Effect.succeed({ state })),
	};
	const registry = makeOrchestratorRegistry([kind]);
	registry.registerDef({
		id: "consultation-transcript",
		nodes: [{ id: "n", kind: "stub.state", on: ["input"], emits: [] }],
	});
	return registry;
};

const orchLayer = (state: JsonObject, run?: OrchestrationKind["run"]) =>
	Layer.succeed(OrchestratorRegistry, orchRegistry(state, run));

/** OrchestratorRegistry whose def spins on a self-emitted event
 * until the event budget fails `run` typed (OrchestrationRunError). */
const spinningOrchRegistry = (): OrchestratorRegistryService => {
	const kind: OrchestrationKind = {
		id: "stub.spin",
		run: () => Effect.succeed({ events: [{ type: "tick" }] }),
	};
	const registry = makeOrchestratorRegistry([kind]);
	registry.registerDef({
		id: "consultation-transcript",
		nodes: [{ id: "n", kind: "stub.spin", on: ["input", "tick"], emits: ["tick"] }],
	});
	return registry;
};

/** PipelineRegistry stub under the real pipeline id — same marker
 * trick on the fallback engine. `run` overrides the stage body. */
const pipeRegistry = (state: JsonObject, run?: PipelineStage["run"]): PipelineRegistryService => {
	const stage: PipelineStage = {
		id: "s",
		run: run ?? (() => Effect.succeed({ state })),
	};
	const pack: PipelinePack = {
		def: { id: "consultation-transcript", stages: [{ id: "s" }] },
		stages: { s: stage },
	};
	const registry = makePipelineRegistry();
	registry.register(pack);
	return registry;
};

const pipeLayer = (state: JsonObject, run?: PipelineStage["run"]) =>
	Layer.succeed(PipelineRegistry, pipeRegistry(state, run));

const run = (
	layer: Layer.Layer<never>,
	override?: {
		readonly text?: string;
		readonly segments?: readonly { readonly text: string }[];
		readonly envCorrect?: EnvCorrectorFn;
	},
) =>
	Effect.runPromise(
		correctTranscriptEffect(
			{
				text: override?.text ?? input.text,
				...(override?.segments !== undefined ? { segments: override.segments } : {}),
			},
			override?.envCorrect ?? envCorrect,
		).pipe(Effect.provide(layer)),
	);

describe("correctTranscriptEffect probe order", () => {
	it("returns null for empty text without touching any registry", async () => {
		await expect(run(Layer.empty, { text: "   " })).resolves.toBeNull();
	});

	it("prefers OrchestratorRegistry when it knows the def", async () => {
		const layer = Layer.mergeAll(
			orchLayer(cleanupState({ enabled: true, corrected: "orch text", engine: "stub-orch" })),
			pipeLayer(cleanupState({ enabled: true, corrected: "pipe text", engine: "stub-pipe" })),
		);
		await expect(run(layer)).resolves.toEqual({
			corrected: "orch text",
			engine: "pipeline:stub-orch",
		});
	});

	it("falls back to PipelineRegistry when the orchestrator is unbound", async () => {
		const layer = pipeLayer(
			cleanupState({ enabled: true, corrected: "pipe text", engine: "stub-pipe" }),
		);
		await expect(run(layer)).resolves.toEqual({
			corrected: "pipe text",
			engine: "pipeline:stub-pipe",
		});
	});

	it("falls back to PipelineRegistry when the orchestrator lacks the def", async () => {
		// Orchestrator bound but empty — transition-safe: a composition
		// that hasn't collected the pack yet still corrects via the
		// pipeline twin.
		const layer = Layer.mergeAll(
			Layer.succeed(OrchestratorRegistry, makeOrchestratorRegistry()),
			pipeLayer(cleanupState({ enabled: true, corrected: "pipe text", engine: "stub-pipe" })),
		);
		await expect(run(layer)).resolves.toEqual({
			corrected: "pipe text",
			engine: "pipeline:stub-pipe",
		});
	});

	it("returns null when the pipeline registry is bound without the def", async () => {
		const layer = Layer.succeed(PipelineRegistry, makePipelineRegistry());
		await expect(run(layer)).resolves.toBeNull();
	});

	it("does not retry on the pipeline after an orchestrator run", async () => {
		// Orchestrator ran and produced disabled state — the shared
		// stages would only repeat the same probes on the pipeline, so
		// the outcome is final (null → caller stores nothing).
		const layer = Layer.mergeAll(
			orchLayer(cleanupState({ enabled: false })),
			pipeLayer(cleanupState({ enabled: true, corrected: "pipe text", engine: "stub-pipe" })),
		);
		await expect(run(layer)).resolves.toBeNull();
	});

	it("returns null when neither registry is bound", async () => {
		await expect(run(Layer.empty)).resolves.toBeNull();
	});

	it("returns null when the orchestrator cleanup disables", async () => {
		await expect(run(orchLayer(cleanupState({ enabled: false })))).resolves.toBeNull();
	});

	it("returns null when the run state carries no cleanup fragment", async () => {
		await expect(run(orchLayer({}))).resolves.toBeNull();
	});

	it("treats malformed cleanup fields as no correction", async () => {
		await expect(
			run(orchLayer(cleanupState({ enabled: true, corrected: 42, engine: "stub-orch" }))),
		).resolves.toBeNull();
		await expect(
			run(orchLayer(cleanupState({ enabled: true, corrected: "text", engine: 42 }))),
		).resolves.toBeNull();
	});

	it("treats an empty correction as no correction", async () => {
		await expect(
			run(orchLayer(cleanupState({ enabled: true, corrected: "   ", engine: "stub-orch" }))),
		).resolves.toBeNull();
	});

	it("forwards segments to the wire input", async () => {
		const seen: unknown[] = [];
		const layer = orchLayer(cleanupState({ enabled: false }), (ctx) => {
			seen.push(ctx.event.payload);
			return Effect.succeed({ state: {} });
		});
		await run(layer, { segments: [{ text: "seg" }] });
		expect(seen).toEqual([{ text: "texto cru", segments: [{ text: "seg" }] }]);
	});
});

describe("correctTranscriptEffect run failures", () => {
	it("returns null when the orchestration run fails typed", async () => {
		// A node re-emitting its own trigger spins until the event
		// budget fails run() typed (OrchestrationRunError).
		const layer = Layer.succeed(OrchestratorRegistry, spinningOrchRegistry());
		await expect(run(layer)).resolves.toBeNull();
	});

	it("returns null when the orchestration run defects", async () => {
		const layer = orchLayer({}, () => Effect.die("kind defect"));
		await expect(run(layer)).resolves.toBeNull();
	});

	it("returns null when the pipeline run fails typed", async () => {
		const layer = pipeLayer({}, () =>
			Effect.fail(new PipelineStageError({ stageId: "s", message: "boom" })),
		);
		await expect(run(layer)).resolves.toBeNull();
	});

	it("returns null when the pipeline run defects", async () => {
		const layer = pipeLayer({}, () => Effect.die("stage defect"));
		await expect(run(layer)).resolves.toBeNull();
	});
});

describe("correctTranscriptEffect envCorrect plumbing", () => {
	it("reaches the env-cleanup stage through the real orchestration", async () => {
		// No platform endpoints (Layer.empty ambient inside the run) —
		// the orchestration's env-cleanup reads envCorrect from
		// RunOptions.config via transcriptOrchestrationConfig.
		const layer = Layer.succeed(OrchestratorRegistry, makeTranscriptOrchestratorRegistry());
		await expect(run(layer)).resolves.toEqual({
			corrected: "env:texto cru",
			engine: "pipeline:env-x",
		});
	});

	it("reaches the env-cleanup stage through the real pipeline pack", async () => {
		const registry = makePipelineRegistry();
		registry.register(transcriptPipelinePack);
		const layer = Layer.succeed(PipelineRegistry, registry);
		await expect(run(layer)).resolves.toEqual({
			corrected: "env:texto cru",
			engine: "pipeline:env-x",
		});
	});

	it("the envCorrect argument wins over an ambient EnvCorrector binding", async () => {
		// correctTranscriptEffect lifts its argument into the port for
		// the run — an ambient binding (e.g. the app's EnvCorrectorLive)
		// must not shadow the explicit per-call corrector.
		const layer = Layer.mergeAll(
			Layer.succeed(OrchestratorRegistry, makeTranscriptOrchestratorRegistry()),
			Layer.succeed(EnvCorrector, {
				correct: () => Effect.succeed({ corrected: "ambient", engine: "amb-x" }),
			}),
		);
		await expect(run(layer)).resolves.toEqual({
			corrected: "env:texto cru",
			engine: "pipeline:env-x",
		});
	});
});

/**
 * Durable-runner suite: the env-cleanup stage's EnvCorrector probe is
 * the ONLY corrector binding that survives `orchestration_*`
 * serialization — the run-config function is dropped by JSON. These
 * tests drive the real transcript OrchestrationDef through
 * makeOrchestrationRunner + ambientContext, the same path an
 * `orchestrator.step` consumer takes.
 */
describe("durable runner env corrector", () => {
	const DDL = `
CREATE TABLE orchestration_defs (
	id TEXT PRIMARY KEY,
	version TEXT NOT NULL,
	def TEXT NOT NULL,
	enabled INTEGER DEFAULT true NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE orchestration_runs (
	id TEXT PRIMARY KEY,
	def_id TEXT NOT NULL,
	def_version TEXT NOT NULL,
	status TEXT DEFAULT 'running' NOT NULL,
	state TEXT NOT NULL,
	runtime TEXT NOT NULL,
	error TEXT,
	tenant_id INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE orchestration_events (
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	event_id TEXT NOT NULL,
	event_type TEXT NOT NULL,
	payload TEXT NOT NULL,
	source TEXT NOT NULL,
	ts INTEGER NOT NULL,
	PRIMARY KEY(run_id, seq)
);
CREATE TABLE orchestration_node_runs (
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	node_id TEXT NOT NULL,
	status TEXT NOT NULL,
	latency_ms INTEGER NOT NULL,
	error TEXT,
	fires INTEGER NOT NULL,
	PRIMARY KEY(run_id, seq)
);
`;

	const fakeJobs = () => {
		const sent: { kind: string; payload: unknown }[] = [];
		return {
			sent,
			jobs: {
				enqueue: async (kind: string, payload: unknown) => {
					sent.push({ kind, payload });
					return { id: `job-${sent.length}`, kind, payload };
				},
			},
		};
	};

	const cleanupOf = (state: Readonly<Record<string, unknown>>) =>
		state["cleanup"] as
			| { readonly enabled?: unknown; readonly corrected?: unknown; readonly engine?: unknown }
			| undefined;

	it("corrects via the ambient EnvCorrector port across durable steps", async () => {
		const db = makeDb(makeD1(DDL));
		const registry = makeTranscriptOrchestratorRegistry();
		const { jobs, sent } = fakeJobs();
		const runner = makeOrchestrationRunner({
			db,
			jobs,
			registry,
			ambientContext: Context.make(EnvCorrector, { correct: envCorrect }),
		});
		const runId = await Effect.runPromise(
			runner.start("consultation-transcript", { text: "texto cru" }),
		);
		// The whole chain fits one 50-event batch — a single step drains it.
		await Effect.runPromise(runner.step(runId));
		const loaded = await loadOrchestrationRun(db, runId);
		expect(loaded?.record.status).toBe("done");
		// env-cleanup skipped nothing — the port corrected; the
		// run-config function never entered the picture (it could not
		// have survived serialization anyway).
		expect(cleanupOf(loaded?.runtime?.state ?? {})).toMatchObject({
			enabled: true,
			corrected: "env:texto cru",
			engine: "env-x",
		});
		expect(sent.every((j) => j.kind === "orchestrator.step")).toBe(true);
	});

	it("degrades env-cleanup honestly when ambientContext carries no port", async () => {
		const db = makeDb(makeD1(DDL));
		const registry = makeTranscriptOrchestratorRegistry();
		const { jobs } = fakeJobs();
		const runner = makeOrchestrationRunner({ db, jobs, registry });
		const runId = await Effect.runPromise(
			runner.start("consultation-transcript", { text: "texto cru" }),
		);
		await Effect.runPromise(runner.step(runId));
		const loaded = await loadOrchestrationRun(db, runId);
		expect(loaded?.record.status).toBe("done");
		// No platform endpoints either → cleanup stays disabled and the
		// node output records the no-port degrade.
		expect(cleanupOf(loaded?.runtime?.state ?? {})).toMatchObject({ enabled: false });
		expect(loaded?.runtime?.state["env-cleanup"]).toEqual({
			skipped: true,
			reason: "no-port",
		});
	});
});
