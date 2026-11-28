import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { physical } from "@tanstack/virtual-file-routes";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { ClipboardCheckIcon } from "lucide-react";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, tx } from "@ktb/db";
import { consultations, doctors, patients, user as userTable } from "@ktb/db/schema";
import { EvalArtifacts, EvalRunner, type Persona } from "@ktb/eval-consultation";
import {
	EVAL_ACTION,
	EVAL_RESOURCE,
	evalInstance,
	evalInstanceItem,
	type EvalInstanceItem,
} from "@ktb/eval-persona";
import { Jobs } from "@ktb/jobs-port";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin } from "@ktb/platform";
import { jobKindContribution } from "@ktb/platform/capabilities";
import { Permissions } from "@ktb/rbac";

import { parseJson } from "./core-map.ts";
import { EvalValidatorPage } from "./platform-page.tsx";
import { EVAL_RUN_JOB_KIND, executeEvalRun } from "./run-job.ts";
import { EVAL_RUN_FAIL_SOURCES } from "./status-machine.ts";
import { evalRun, evalRunRecord, evalRunSample, type EvalRunSample } from "./schema.ts";

export { evalRun, evalRunRecord, evalRunSample } from "./schema.ts";
export {
	evalRunMachine,
	EVAL_RUN_FAIL_SOURCES,
	EVAL_RUN_FINALIZE_SOURCES,
	EVAL_RUN_START_SOURCES,
	type EvalRunEvent,
	type EvalRunStatus,
} from "./status-machine.ts";
export {
	datasetPinFor,
	runRecordFromRow,
	runRecordRow,
	runRecordRows,
	runToExperiment,
} from "./core-map.ts";

// Re-exported for the plugins that pin the grant spelling through
// this package (ai-provider, credentials) — the canonical
// definition lives in @ktb/eval-persona, the pipeline's base layer.
export { EVAL_ACTION, EVAL_RESOURCE };

/** One generated consultation (eval_instance_item) as the review
 * gallery renders it — the item IS the corpus row now: persona
 * snapshot + rendered script/turns/voices + synthetic entity links +
 * generation status + review state live on the same row. */
export interface CohortItemCard {
	readonly id: number;
	readonly instanceId: number;
	readonly personaDefId: number | null;
	readonly persona: Persona | null;
	readonly script: string | null;
	readonly turns: readonly { readonly speaker: string; readonly text: string }[];
	readonly voices: Record<string, string>;
	/** Synthetic entity links — the generated patient + doctor rows. */
	readonly patientId: number | null;
	readonly doctorId: number | null;
	/** llm | template — which script source rendered the dialogue. */
	readonly scriptMode: string | null;
	/** pending | generating | done | error — generation status. */
	readonly status: string;
	readonly error: string | null;
	/** under_review | approved | rejected — the review gate. */
	readonly state: string;
	readonly feedback: string | null;
}

/** review | approved | mixed | rejected — DERIVED from item states
 * at read time (never a stored column: a denormalized cohort state
 * would drift the moment a review lands). Only GENERATED items
 * (status='done') count — a pending/error slot isn't reviewable. */
export type CohortState = "review" | "approved" | "mixed" | "rejected" | "empty";

export const cohortStateOf = (p: {
	readonly pending: number;
	readonly approved: number;
	readonly rejected: number;
}): CohortState =>
	p.pending + p.approved + p.rejected === 0
		? "empty"
		: p.pending > 0
			? "review"
			: p.approved > 0 && p.rejected > 0
				? "mixed"
				: p.approved > 0
					? "approved"
					: "rejected";

/** A reviewable cohort = one generation instance (step 2 output)
 * with its review rollup — the validator never lists personas
 * without the instance that produced them. */
export interface CohortSummary {
	readonly id: number;
	readonly name: string;
	/** Instance generation status: draft | generating | ready | failed. */
	readonly status: string;
	readonly state: CohortState;
	/** Generated items only — pending/error slots aren't corpus. */
	readonly count: number;
	readonly approved: number;
	readonly rejected: number;
	readonly pending: number;
	readonly createdBy: string | null;
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
	readonly instanceId: number | null;
	/** {instanceId, itemIds} — the exact input set the run executed. */
	readonly params: JsonValue;
	readonly status: string;
	readonly total: number;
	readonly done: number;
	readonly pct: number;
	readonly summary: JsonValue | null;
	readonly aggregates: readonly AxisAggregate[];
	readonly samples: readonly RunSampleProgress[];
	/** Honest capability signals (WS-E): whether an EvalRunner driver
	 * is bound (runs can execute at all) and whether the jobs queue is
	 * bound (runs dispatch to the eval.run consumer instead of the
	 * inline fork). The UI warns before startRun when runnerBound is
	 * false — a queued run only progresses where a runner exists.
	 * Optional on the wire: older servers omit them and the view
	 * degrades to no warning (same contract as RunProgressView). */
	readonly runnerBound?: boolean;
	readonly queueBound?: boolean;
}

/** Run sample + the item's gold script — the diff renders ref vs
 * ASR hyp, so progress must carry both (null while/after the item
 * never generated a script). */
export interface RunSampleProgress extends EvalRunSample {
	readonly script: string | null;
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

/** One run row as the history list renders it — status rollup plus
 * the persisted summary chips (meanWer / meanWerAfter / completeness). */
export interface RunListItem {
	readonly id: number;
	readonly instanceId: number | null;
	readonly status: string;
	readonly total: number;
	readonly done: number;
	readonly summary: JsonValue | null;
	readonly createdAt: Date;
	readonly finishedAt: Date | null;
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
		readonly persona: string | null;
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

const toItemCard = (row: EvalInstanceItem): CohortItemCard => ({
	id: row.id,
	instanceId: row.instanceId,
	personaDefId: row.personaDefId,
	persona: row.persona === null ? null : parseJson(row.persona, {} as Persona),
	script: row.script,
	turns: parseJson(row.turns, []),
	voices: parseJson(row.voices, {}),
	patientId: row.patientId,
	doctorId: row.doctorId,
	scriptMode: row.scriptMode,
	status: row.status,
	error: row.error,
	state: row.state,
	feedback: row.feedback,
});

/** An item is runnable when it generated a full corpus row AND the
 * reviewer approved it — the review gate and the generation gate
 * compose, neither alone is enough. */
const runnable = (r: EvalInstanceItem): boolean =>
	r.state === "approved" && r.status === "done" && r.script !== null;

/** The validator surface — step 3 of the pipeline: cohort curation
 * (review/approve generated consultations) + eval runs. Every
 * mutating method requires the `eval.validator` grant (rbac) so the
 * "different login" is a role, not a second IdP. */
export class EvalValidator extends Context.Service<
	EvalValidator,
	{
		/** Reviewable cohorts — generation instances with their
		 * per-state item rollup. */
		readonly listCohorts: () => Effect.Effect<readonly CohortSummary[], Forbidden, unknown>;
		/** All items of one cohort — generated AND pending/error, so
		 * the gallery can show generation status alongside review
		 * state. */
		readonly listItems: (
			cohortId: number,
		) => Effect.Effect<readonly CohortItemCard[], Forbidden, unknown>;
		/** Approve/reject one item; rejection deletes the synthetic
		 * patient + doctor user it generated. */
		readonly review: (input: {
			readonly itemId: number;
			readonly decision: "approved" | "rejected";
			readonly feedback?: string;
		}) => Effect.Effect<void, Forbidden, unknown>;
		/** Start an eval run over the cohort's runnable items (or an
		 * explicit subset via itemIds). The resolved input set lands on
		 * run.params — the run replays/audits from its own record. The
		 * run NEVER regenerates consultations: it scores the corpus
		 * that already exists on the items. */
		readonly startRun: (input: {
			readonly instanceId: number;
			readonly itemIds?: readonly number[];
		}) => Effect.Effect<{ runId: number }, Forbidden, unknown>;
		/** Runs of one cohort, newest first — the history list the page
		 * renders so a finished run can be reopened (metrics, diffs,
		 * audio) after the session that started it is gone. */
		readonly listRuns: (
			instanceId: number,
		) => Effect.Effect<readonly RunListItem[], Forbidden, unknown>;
		readonly progress: (runId: number) => Effect.Effect<RunProgress | null, Forbidden, unknown>;
		/** Delete a run row — samples cascade via FK. Runs hold no
		 * assets beyond their rows (audio stays in the artifact root). */
		readonly deleteRun: (runId: number) => Effect.Effect<void, Forbidden, unknown>;
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
		// WS-E: the generic jobs port — bound by app-host when the
		// deploy wires a queue transport (AUDIO_QUEUE). Absent →
		// startRun keeps the inline forkDetach path.
		const jobs = yield* Effect.serviceOption(Jobs);
		// Availability signals surfaced on RunProgress — captured once
		// at layer build, they describe this runtime's capabilities.
		const runnerBound = Option.isSome(runner);
		const queueBound = Option.isSome(jobs);

		return EvalValidator.of({
			listCohorts: Effect.fn("EvalValidator.listCohorts")(function* () {
				yield* requireValidator();
				const instances = yield* Effect.promise(() =>
					db.select().from(evalInstance).orderBy(desc(evalInstance.createdAt)).limit(50),
				);
				// One grouped read for all cohorts — no N+1. Only generated
				// items (status='done') count toward the review rollup.
				const states = yield* Effect.promise(() =>
					db
						.select({
							instanceId: evalInstanceItem.instanceId,
							state: evalInstanceItem.state,
							n: count(),
						})
						.from(evalInstanceItem)
						.where(eq(evalInstanceItem.status, "done"))
						.groupBy(evalInstanceItem.instanceId, evalInstanceItem.state),
				);
				const byInstance = new Map<number, Map<string, number>>();
				for (const st of states) {
					const m = byInstance.get(st.instanceId) ?? new Map<string, number>();
					m.set(st.state, st.n);
					byInstance.set(st.instanceId, m);
				}
				return instances.map((i): CohortSummary => {
					const byState = byInstance.get(i.id) ?? new Map<string, number>();
					const approved = byState.get("approved") ?? 0;
					const rejected = byState.get("rejected") ?? 0;
					const pending = byState.get("under_review") ?? 0;
					return {
						id: i.id,
						name: i.name,
						status: i.status,
						state: cohortStateOf({ pending, approved, rejected }),
						count: approved + rejected + pending,
						approved,
						rejected,
						pending,
						createdBy: i.createdBy,
						createdAt: i.createdAt,
					};
				});
			}),

			listItems: Effect.fn("EvalValidator.listItems")(function* (cohortId) {
				yield* requireValidator();
				const rows = yield* Effect.promise(() =>
					db
						.select()
						.from(evalInstanceItem)
						.where(eq(evalInstanceItem.instanceId, cohortId))
						.orderBy(evalInstanceItem.id),
				);
				return rows.map(toItemCard);
			}),

			review: Effect.fn("EvalValidator.review")(function* (input) {
				yield* requireValidator();
				const principal = yield* Principal;
				// Rejection deletes the synthetic entities: patient row +
				// the doctor's backing user (which cascades the doctor row
				// and set-nulls both FK columns here). Approvals keep them
				// — they're the entities the run exercises.
				const [item] = yield* Effect.promise(() =>
					db
						.select({
							patientId: evalInstanceItem.patientId,
							doctorId: evalInstanceItem.doctorId,
						})
						.from(evalInstanceItem)
						.where(eq(evalInstanceItem.id, input.itemId)),
				);
				const doctorRow =
					input.decision === "rejected" && item?.doctorId != null
						? yield* Effect.promise(() =>
								db
									.select({ userId: doctors.userId })
									.from(doctors)
									.where(eq(doctors.id, item.doctorId!)),
							)
						: [];
				const synUserId = doctorRow[0]?.userId;
				yield* Effect.promise(() =>
					tx(db, [
						db
							.update(evalInstanceItem)
							.set({
								state: input.decision,
								feedback: input.feedback ?? null,
								reviewedBy: principal?.email ?? null,
								reviewedAt: new Date(),
							})
							.where(eq(evalInstanceItem.id, input.itemId)),
						...(input.decision === "rejected"
							? [
									// WS-F: the item's synthetic consultations row
									// goes with the corpus — its patientId FK
									// would block the patient delete below.
									db.delete(consultations).where(eq(consultations.evalItemId, input.itemId)),
								]
							: []),
						...(input.decision === "rejected" && item?.patientId != null
							? [db.delete(patients).where(eq(patients.id, item.patientId))]
							: []),
						...(synUserId !== undefined
							? [db.delete(userTable).where(eq(userTable.id, synUserId))]
							: []),
					]),
				);
			}),

			startRun: Effect.fn("EvalValidator.startRun")(function* (input) {
				yield* requireValidator();
				const principal = yield* Principal;
				const items = yield* Effect.promise(() =>
					db
						.select()
						.from(evalInstanceItem)
						.where(
							input.itemIds === undefined
								? eq(evalInstanceItem.instanceId, input.instanceId)
								: and(
										eq(evalInstanceItem.instanceId, input.instanceId),
										inArray(evalInstanceItem.id, input.itemIds),
									),
						),
				);
				const picked = items.filter(runnable);
				const runRows = yield* Effect.promise(() =>
					db
						.insert(evalRun)
						.values({
							instanceId: input.instanceId,
							// The exact input set — the run replays/audits from
							// this record even if the cohort is edited/deleted
							// later (instanceId set-nulls, params stays).
							params: JSON.stringify({
								instanceId: input.instanceId,
								itemIds: picked.map((p) => p.id),
							}),
							status: "queued",
							total: picked.length,
							createdBy: principal?.email ?? null,
							createdAt: new Date(),
						})
						.returning(),
				);
				const run = runRows[0]!;
				if (picked.length > 0) {
					yield* Effect.promise(() =>
						db.insert(evalRunSample).values(
							picked.map((p) => ({
								runId: run.id,
								itemId: p.id,
								createdAt: new Date(),
							})),
						),
					);
				}
				// WS-E: with the jobs queue bound the run is handed to the
				// eval.run consumer — it flips queued→running and drives
				// executeEvalRun, which resumes pending samples so a
				// redelivery after a crash picks up where it stopped.
				// Without the queue but with a runner, keep the
				// request-scoped fork (tests + minimal runtimes). Neither
				// → the row stays honestly queued.
				if (Option.isSome(jobs) && picked.length > 0) {
					yield* Effect.tryPromise({
						try: () => jobs.value.enqueue(EVAL_RUN_JOB_KIND, { runId: run.id }),
						catch: (error) => error,
					}).pipe(
						Effect.catch((error) =>
							// An enqueue failure must not leave a zombie
							// "queued" row — fail it, then propagate as a
							// defect (operational failure, not a domain
							// denial).
							Effect.promise(() =>
								db
									.update(evalRun)
									.set({
										status: "failed",
										finishedAt: new Date(),
										summary: JSON.stringify({
											error: `eval.run enqueue failed: ${String(error)}`,
										}),
									})
									.where(
										and(
											eq(evalRun.id, run.id),
											inArray(evalRun.status, [...EVAL_RUN_FAIL_SOURCES]),
										),
									),
							).pipe(Effect.andThen(Effect.die(error))),
						),
					);
				} else if (Option.isSome(runner) && picked.length > 0) {
					// forkDetach: the run outlives this request's scope —
					// evals take minutes; progress is polled via
					// `progress`. executeEvalRun re-reads the samples it
					// just inserted, so the inline path and the queue
					// path share ONE implementation (and the same
					// pending-only resume semantics).
					yield* executeEvalRun(db, runner.value, run.id).pipe(Effect.forkDetach);
				}
				return { runId: run.id };
			}),

			listRuns: Effect.fn("EvalValidator.listRuns")(function* (instanceId) {
				yield* requireValidator();
				const rows = yield* Effect.promise(() =>
					db
						.select()
						.from(evalRun)
						.where(eq(evalRun.instanceId, instanceId))
						.orderBy(desc(evalRun.id)),
				);
				return rows.map((r) => ({
					id: r.id,
					instanceId: r.instanceId,
					status: r.status,
					total: r.total,
					done: r.done,
					summary: parseJson<JsonValue | null>(r.summary, null),
					createdAt: r.createdAt,
					finishedAt: r.finishedAt,
				}));
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
							script: evalInstanceItem.script,
							persona: evalInstanceItem.persona,
						})
						.from(evalRunSample)
						.innerJoin(evalInstanceItem, eq(evalRunSample.itemId, evalInstanceItem.id))
						.where(eq(evalRunSample.runId, runId)),
				);
				return {
					id: run.id,
					instanceId: run.instanceId,
					params: parseJson<JsonValue>(run.params, {}),
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
					runnerBound,
					queueBound,
				} satisfies RunProgress;
			}),

			deleteRun: Effect.fn("EvalValidator.deleteRun")(function* (runId) {
				yield* requireValidator();
				yield* Effect.promise(() => db.delete(evalRun).where(eq(evalRun.id, runId)));
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

export const evalValidatorTablesPlugin = definePlugin({
	id: "eval.validator.tables",
	meta: { keywords: ["eval", "validator", "tables"] },
	// run tables FK into eval_instance / eval_instance_item — the
	// step-2 plugin must land its DDL first.
	requiredDeps: ["eval.persona.tables"],
	tables: { evalRun, evalRunSample, evalRunRecord },
});

export const evalValidatorServicesPlugin = definePlugin({
	id: "eval.validator.services",
	meta: { keywords: ["eval", "validator", "services"] },
	requiredDeps: [evalValidatorTablesPlugin.id],
	services: EvalValidatorLive,
	// P-094: capability declaration — eval.run is a real job kind but
	// NOT schedulable: its payload requires a specific eval_run row id,
	// so cron-style scheduling cannot produce a valid envelope.
	contributions: [
		jobKindContribution(EVAL_RUN_JOB_KIND, {
			description:
				"Executes a queued eval run — payload is { runId } for a specific eval_run row; enqueued by startRun, not schedulable.",
		}),
	],
});

export const evalValidatorChromePlugin = definePlugin({
	i18nKeys: {
		groups: { Evaluation: "panel_group_evaluation" },
	},
	id: "eval.validator.chrome",
	meta: { keywords: ["eval", "validator", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "eval-validator.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/eval",
					label: "3 · Run eval",
					icon: ClipboardCheckIcon,
					group: "Evaluation",
				},
			},
		},
	],
});

export const evalValidatorPanelPlugin = definePlugin({
	id: "eval.validator.panel",
	meta: { keywords: ["eval", "validator", "ui"] },
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
							.listCohorts()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as CohortSummary[])));
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
	meta: { keywords: ["eval", "validator", "routes"] },
	routes: [physical("/api", "../../../../plugins/eval-validator/src/api-routes")],
});

// WS-E: the eval.run consumer registration lives in ./run-job.ts as a
// plain JobRegistration value — apps/web's composition root
// (lib/platform.ts) registers it into its job-handler registry. There
// is no module-scope mutation: plugin manifests stay data-only.

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
