import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { physical } from "@tanstack/virtual-file-routes";
import { count, desc, eq } from "drizzle-orm";
import { ClipboardCheckIcon } from "lucide-react";

import { Forbidden, Principal } from "@ktb/authz";
import { Db } from "@ktb/db";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";
import {
	DEFAULT_MATRIX,
	enrichPersona,
	EvalArtifacts,
	EvalRunner,
	ptBR,
	renderScript,
	rng,
	sampleMatrix,
	voiceFor,
	type Persona,
} from "@ktb/eval-consultation";

import { EvalValidatorPage } from "./platform-page.tsx";
import {
	evalPersona,
	evalPersonaBatch,
	evalRun,
	evalRunSample,
	type EvalRunSample,
} from "./schema.ts";

export { evalPersona, evalPersonaBatch, evalRun, evalRunSample } from "./schema.ts";

/** Permission the gate checks — same spelling as the rbac catalog. */
export const EVAL_RESOURCE = "eval";
export const EVAL_ACTION = "validator";

/** One persona row as the gallery renders it. */
export interface PersonaCard {
	readonly id: number;
	readonly batchId: number;
	readonly persona: Persona;
	readonly script: string;
	readonly turns: readonly { readonly speaker: string; readonly text: string }[];
	readonly voices: Record<string, string>;
	readonly state: string;
	readonly feedback: string | null;
}

/** review | approved | mixed | rejected — DERIVED from persona
 * states at read time (never a stored column: a denormalized batch
 * state would drift the moment a review lands). */
export type BatchState = "review" | "approved" | "mixed" | "rejected" | "empty";

export const batchStateOf = (p: {
	readonly pending: number;
	readonly approved: number;
	readonly rejected: number;
}): BatchState =>
	p.pending + p.approved + p.rejected === 0
		? "empty"
		: p.pending > 0
			? "review"
			: p.approved > 0 && p.rejected > 0
				? "mixed"
				: p.approved > 0
					? "approved"
					: "rejected";

export interface BatchSummary {
	readonly id: number;
	readonly state: BatchState;
	readonly count: number;
	readonly approved: number;
	readonly rejected: number;
	readonly pending: number;
	readonly createdAt: Date;
}

/** JSON-serializable value — server fns constrain responses to it. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [k: string]: JsonValue };

export interface RunProgress {
	readonly id: number;
	readonly batchId: number;
	readonly status: string;
	readonly total: number;
	readonly done: number;
	readonly pct: number;
	readonly summary: JsonValue | null;
	readonly aggregates: readonly AxisAggregate[];
	readonly samples: readonly RunSampleProgress[];
}

/** Run sample + the persona's gold script — the diff renders ref vs
 * ASR hyp, so progress must carry both. */
export interface RunSampleProgress extends EvalRunSample {
	readonly script: string;
}

/** Mean WER sliced by persona axis — the aggregate answers "where
 * does the engine fail" (per region/class/register), not just "how
 * much". Computed at read time from the run samples; ~100 rows is
 * trivial and stays consistent with live progress. */
export interface AxisSlice {
	readonly key: string;
	readonly samples: number;
	readonly ok: number;
	readonly meanWer: number | null;
}

export interface AxisAggregate {
	readonly axis: string;
	readonly slices: readonly AxisSlice[];
}

const AXES = [
	"region",
	"ageBand",
	"register",
	"specialty",
	"socialClass",
	"education",
	"gender",
] as const;

const aggregateByAxis = (
	samples: readonly {
		readonly status: string;
		readonly result: string | null;
		readonly persona: string;
	}[],
): readonly AxisAggregate[] => {
	const enriched = samples.map((s) => ({
		...s,
		wer: s.status === "ok" ? parseJson<{ wer?: number }>(s.result, {}).wer : undefined,
		p: parseJson<Record<string, string | undefined>>(s.persona, {}),
	}));
	return AXES.map((axis) => {
		const groups = new Map<string, { samples: number; ok: number; werSum: number; werN: number }>();
		for (const s of enriched) {
			const key = s.p[axis] ?? "—";
			const g = groups.get(key) ?? { samples: 0, ok: 0, werSum: 0, werN: 0 };
			g.samples++;
			if (s.wer !== undefined) {
				g.ok++;
				g.werSum += s.wer;
				g.werN++;
			}
			groups.set(key, g);
		}
		return {
			axis,
			slices: [...groups.entries()].map(([key, g]) => ({
				key,
				samples: g.samples,
				ok: g.ok,
				meanWer: g.werN === 0 ? null : g.werSum / g.werN,
			})),
		};
	});
};

const parseJson = <T>(raw: string | null, fallback: T): T => {
	if (raw === null) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
};

const toCard = (row: typeof evalPersona.$inferSelect): PersonaCard => ({
	id: row.id,
	batchId: row.batchId,
	persona: parseJson(row.persona, {} as Persona),
	script: row.script,
	turns: parseJson(row.turns, []),
	voices: parseJson(row.voices, {}),
	state: row.state,
	feedback: row.feedback,
});

/** The validator surface — generation, review workflow, run tracking.
 * Every mutating method requires the `eval.validator` grant (rbac) so
 * the "different login" is a role, not a second IdP. */
export class EvalValidator extends Context.Service<
	EvalValidator,
	{
		readonly generate: (input: {
			readonly count: number;
			readonly seed?: number;
		}) => Effect.Effect<{ batchId: number }, Forbidden, unknown>;
		readonly listBatches: () => Effect.Effect<readonly BatchSummary[], Forbidden, unknown>;
		readonly listPersonas: (
			batchId: number,
		) => Effect.Effect<readonly PersonaCard[], Forbidden, unknown>;
		readonly review: (input: {
			readonly personaId: number;
			readonly decision: "approved" | "rejected";
			readonly feedback?: string;
		}) => Effect.Effect<void, Forbidden, unknown>;
		readonly startRun: (batchId: number) => Effect.Effect<{ runId: number }, Forbidden, unknown>;
		readonly progress: (runId: number) => Effect.Effect<RunProgress | null, Forbidden, unknown>;
		/** Audio bytes for a finished run sample — null when the run
		 * has no audio (failed sample) or no artifact driver is bound. */
		readonly sampleAudio: (
			runSampleId: number,
		) => Effect.Effect<Uint8Array | null, Forbidden, unknown>;
	}
>()("@ktb/eval-validator/EvalValidator") {}

const requireValidator = Effect.fn("EvalValidator.gate")(function* () {
	const permissions = yield* Permissions;
	yield* permissions.requirePermission(EVAL_RESOURCE, EVAL_ACTION);
});

export const EvalValidatorLive = Layer.effect(
	EvalValidator,
	Effect.gen(function* () {
		const db = yield* Db;
		const runner = yield* Effect.serviceOption(EvalRunner);

		return EvalValidator.of({
			generate: Effect.fn("EvalValidator.generate")(function* (input) {
				yield* requireValidator();
				const principal = yield* Principal;
				const seed = input.seed ?? 100;
				// Diverse cells come from the domain matrix — never inline
				// axis tables; enrichPersona/voiceFor keep rng discipline so
				// the batch replays from (seed, count).
				const total =
					DEFAULT_MATRIX.regions.length *
					DEFAULT_MATRIX.ageBands.length *
					DEFAULT_MATRIX.registers.length *
					DEFAULT_MATRIX.specialties.length;
				const cells = sampleMatrix(
					DEFAULT_MATRIX,
					Math.max(1, Math.floor(total / input.count)),
				).slice(0, input.count);
				// db.batch = one transaction on D1: personas land all-or-
				// nothing, a crash mid-batch leaves at most an empty batch
				// row (visible, deletable) — never half a cohort.
				const batchId = yield* Effect.promise(async () => {
					const [batch] = await db
						.insert(evalPersonaBatch)
						.values({
							params: JSON.stringify({
								count: input.count,
								seed,
								variant: "anamnesis",
								locale: "pt-BR",
							}),
							createdBy: principal?.email ?? null,
						})
						.returning();
					const personaValues = cells.map((cell, i) => {
						const rand = rng(seed + i);
						const persona = enrichPersona(cell, rand);
						const render = renderScript({
							template: "",
							persona,
							seed: seed + i,
							profile: ptBR,
							variant: "anamnesis",
						});
						return db.insert(evalPersona).values({
							batchId: batch!.id,
							persona: JSON.stringify(persona),
							script: render.script,
							turns: JSON.stringify(render.turns),
							voices: JSON.stringify({
								doctor: voiceFor(persona.doctor?.gender, rand),
								patient: voiceFor(persona.gender, rand),
							}),
						});
					});
					if (personaValues.length > 0) {
						await db.batch([personaValues[0]!, ...personaValues.slice(1)]);
					}
					return batch!.id;
				});
				return { batchId };
			}),

			listBatches: Effect.fn("EvalValidator.listBatches")(function* () {
				yield* requireValidator();
				const batches = yield* Effect.promise(() =>
					db.select().from(evalPersonaBatch).orderBy(desc(evalPersonaBatch.createdAt)).limit(50),
				);
				// One grouped read for all batches — no N+1.
				const states = yield* Effect.promise(() =>
					db
						.select({ batchId: evalPersona.batchId, state: evalPersona.state, n: count() })
						.from(evalPersona)
						.groupBy(evalPersona.batchId, evalPersona.state),
				);
				const byBatch = new Map<number, Map<string, number>>();
				for (const st of states) {
					const m = byBatch.get(st.batchId) ?? new Map<string, number>();
					m.set(st.state, st.n);
					byBatch.set(st.batchId, m);
				}
				return batches.map((b): BatchSummary => {
					const byState = byBatch.get(b.id) ?? new Map<string, number>();
					const approved = byState.get("approved") ?? 0;
					const rejected = byState.get("rejected") ?? 0;
					const pending = byState.get("under_review") ?? 0;
					return {
						id: b.id,
						state: batchStateOf({ pending, approved, rejected }),
						count: approved + rejected + pending,
						approved,
						rejected,
						pending,
						createdAt: b.createdAt,
					};
				});
			}),

			listPersonas: Effect.fn("EvalValidator.listPersonas")(function* (batchId) {
				yield* requireValidator();
				const rows = yield* Effect.promise(() =>
					db.select().from(evalPersona).where(eq(evalPersona.batchId, batchId)),
				);
				return rows.map(toCard);
			}),

			review: Effect.fn("EvalValidator.review")(function* (input) {
				yield* requireValidator();
				const principal = yield* Principal;
				yield* Effect.promise(() =>
					db
						.update(evalPersona)
						.set({
							state: input.decision,
							feedback: input.feedback ?? null,
							reviewedBy: principal?.email ?? null,
							reviewedAt: new Date(),
						})
						.where(eq(evalPersona.id, input.personaId)),
				);
			}),

			startRun: Effect.fn("EvalValidator.startRun")(function* (batchId) {
				yield* requireValidator();
				const rows = yield* Effect.promise(() =>
					db.select().from(evalPersona).where(eq(evalPersona.batchId, batchId)),
				);
				const approved = rows.filter((r) => r.state === "approved").map(toCard);
				const runRows = yield* Effect.promise(() =>
					db
						.insert(evalRun)
						.values({ batchId, status: "queued", total: approved.length })
						.returning(),
				);
				const run = runRows[0]!;
				yield* Effect.promise(() =>
					db
						.insert(evalRunSample)
						.values(approved.map((p) => ({ runId: run.id, personaId: p.id }))),
				);
				// No EvalRunner bound → run stays queued; the local driver
				// picks it up when present (dev:node).
				if (Option.isSome(runner) && approved.length > 0) {
					yield* Effect.promise(() =>
						db
							.update(evalRun)
							.set({ status: "running", startedAt: new Date() })
							.where(eq(evalRun.id, run.id)),
					);
					// forkDetach: the run outlives this request's scope — evals
					// take minutes; progress is polled via `progress`. Final
					// status lands inside the forked effect.
					yield* Effect.gen(function* () {
						yield* runner.value
							.run({
								runId: run.id,
								items: approved.map((p) => ({
									id: p.id,
									script: p.script,
									turns: p.turns,
									voices: p.voices,
								})),
								onSample: (id, outcome) =>
									Effect.promise(() =>
										db
											.update(evalRunSample)
											.set({
												status: outcome.status,
												result:
													outcome.result === undefined ? null : JSON.stringify(outcome.result),
												error: outcome.error ?? null,
											})
											.where(eq(evalRunSample.personaId, Number(id))),
									),
							})
							.pipe(
								Effect.catch((error) =>
									Effect.logWarning("eval runner failed", { error: String(error) }),
								),
							);
						const finished = yield* Effect.promise(() =>
							db.select().from(evalRunSample).where(eq(evalRunSample.runId, run.id)),
						);
						const ok = finished.filter((s) => s.status === "ok");
						const wers = ok
							.map((s) => parseJson<{ wer?: number }>(s.result, {}).wer)
							.filter((w): w is number => typeof w === "number");
						yield* Effect.promise(() =>
							db
								.update(evalRun)
								.set({
									status: "done",
									done: finished.length,
									summary: JSON.stringify({
										ok: ok.length,
										failed: finished.length - ok.length,
										meanWer: wers.length ? wers.reduce((a, w) => a + w, 0) / wers.length : null,
									}),
									finishedAt: new Date(),
								})
								.where(eq(evalRun.id, run.id)),
						);
					}).pipe(Effect.forkDetach);
				}
				return { runId: run.id };
			}),

			progress: Effect.fn("EvalValidator.progress")(function* (runId) {
				yield* requireValidator();
				const rows = yield* Effect.promise(() =>
					db.select().from(evalRun).where(eq(evalRun.id, runId)),
				);
				const run = rows[0];
				if (run === undefined) return null;
				const samples = yield* Effect.promise(() =>
					db
						.select({
							sample: evalRunSample,
							script: evalPersona.script,
							persona: evalPersona.persona,
						})
						.from(evalRunSample)
						.innerJoin(evalPersona, eq(evalRunSample.personaId, evalPersona.id))
						.where(eq(evalRunSample.runId, runId)),
				);
				return {
					id: run.id,
					batchId: run.batchId,
					status: run.status,
					total: run.total,
					done: samples.filter((s) => s.sample.status !== "pending").length,
					pct:
						run.total === 0
							? 0
							: Math.round(
									(samples.filter((s) => s.sample.status !== "pending").length / run.total) * 100,
								),
					summary: parseJson<JsonValue | null>(run.summary, null),
					aggregates: aggregateByAxis(
						samples.map((s) => ({
							status: s.sample.status,
							result: s.sample.result,
							persona: s.persona,
						})),
					),
					samples: samples.map((s) => ({ ...s.sample, script: s.script })),
				} satisfies RunProgress;
			}),

			sampleAudio: Effect.fn("EvalValidator.sampleAudio")(function* (runSampleId) {
				yield* requireValidator();
				const artifacts = yield* Effect.serviceOption(EvalArtifacts);
				if (Option.isNone(artifacts)) return null;
				const rows = yield* Effect.promise(() =>
					db.select().from(evalRunSample).where(eq(evalRunSample.id, runSampleId)).limit(1),
				);
				const uri = parseJson<{ audioUri?: string }>(rows[0]?.result ?? null, {}).audioUri;
				if (uri === undefined) return null;
				return yield* artifacts.value.getAudio(uri).pipe(Effect.catch(() => Effect.succeed(null)));
			}),
		});
	}),
);

/** DDL mirror of schema.ts for in-memory test databases (same
 * contract as AUDIT_TEST_DDL in plugins/audit). */
export const EVAL_VALIDATOR_TEST_DDL = `
CREATE TABLE eval_persona_batch (id INTEGER PRIMARY KEY AUTOINCREMENT, params TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE eval_persona (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL REFERENCES eval_persona_batch(id) ON DELETE cascade, persona TEXT NOT NULL, script TEXT NOT NULL, turns TEXT NOT NULL, voices TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'under_review', feedback TEXT, reviewed_by TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE eval_run (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL REFERENCES eval_persona_batch(id) ON DELETE cascade, status TEXT NOT NULL DEFAULT 'queued', total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, summary TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE eval_run_sample (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES eval_run(id) ON DELETE cascade, persona_id INTEGER NOT NULL REFERENCES eval_persona(id) ON DELETE cascade, status TEXT NOT NULL DEFAULT 'pending', result TEXT, error TEXT, created_at INTEGER NOT NULL);
`;

export const evalValidatorTablesPlugin = definePlugin({
	id: "eval.validator.tables",
	tables: { evalPersonaBatch, evalPersona, evalRun, evalRunSample },
});

export const evalValidatorServicesPlugin = definePlugin({
	id: "eval.validator.services",
	requiredDeps: [evalValidatorTablesPlugin.id],
	services: EvalValidatorLive,
});

export const evalValidatorChromePlugin = definePlugin({
	id: "eval.validator.chrome",
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "eval-validator.sidebar",
			region: "console.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/eval",
					label: "Eval validator",
					icon: ClipboardCheckIcon,
					group: "System",
				},
			},
		},
	],
});

export const evalValidatorPanelPlugin = definePlugin({
	id: "eval.validator.panel",
	requiredDeps: [platformPanelPlugin.id, evalValidatorServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "eval.validator",
				path: "/platform/eval",
				component: EvalValidatorPage,
				// Permission-gated: the route hard-404s for anyone without
				// the eval.validator grant; the service re-checks anyway
				// (defense in depth, same contract as the admin console).
				guard: () =>
					Effect.gen(function* () {
						const permissions = yield* Permissions;
						return yield* permissions.can(EVAL_RESOURCE, EVAL_ACTION);
					}),
				loader: () =>
					Effect.gen(function* () {
						const validator = yield* EvalValidator;
						return yield* validator
							.listBatches()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as BatchSummary[])));
					}),
			},
		],
	},
});

// API subtree (T-133): /api/eval/:sampleId/audio streams synthesized
// audio through the EvalArtifacts driver. Route modules live in
// src/api-routes/ — the generator scans the mounted directory.
export const evalValidatorRoutesPlugin = definePlugin({
	id: "eval-validator.routes",
	routes: [physical("/api", "../../../../plugins/eval-validator/src/api-routes")],
});

export const plugins: readonly Plugin[] = [
	evalValidatorTablesPlugin,
	evalValidatorServicesPlugin,
	evalValidatorChromePlugin,
	evalValidatorPanelPlugin,
	evalValidatorRoutesPlugin,
];

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"eval.validator.tables": true;
		"eval.validator.services": true;
		"eval.validator.chrome": true;
		"eval.validator.panel": true;
		"eval-validator.routes": true;
	}
}
