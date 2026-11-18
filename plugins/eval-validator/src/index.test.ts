import { describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { consultations, doctors, patients, user as userTable } from "@ktb/db/schema";
import { Forbidden, Principal } from "@ktb/authz";
import { EvalArtifacts, EvalRunner } from "@ktb/eval-consultation";
import { evalInstance, evalInstanceItem } from "@ktb/eval-persona";
import { Jobs, type JobsEnqueuer } from "@ktb/jobs-port";
import { Permissions } from "@ktb/rbac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import type { CohortSummary } from "./index.ts";
import { evalValidatorPanelPlugin, EvalValidator, EvalValidatorLive } from "./index.ts";
import { evalRun, evalRunRecord, evalRunSample } from "./schema.ts";
import { EVAL_VALIDATOR_TEST_DDL } from "./test-ddl.ts";

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

const make = (
	opts: {
		allow?: boolean;
		/** "none" = no EvalRunner bound; absent = default ok-runner. */
		runner?: "none" | Parameters<typeof runnerLayer>[0];
		/** Absent = no EvalArtifacts bound; value = driver returning it. */
		artifacts?: Uint8Array | null | "fail";
		/** Absent = no Jobs bound; value = enqueuer stub (WS-E). */
		jobs?: JobsEnqueuer;
	} = {},
) => {
	const { allow = true, runner } = opts;
	const db = makeDb(makeD1(EVAL_VALIDATOR_TEST_DDL));
	const layers = Layer.mergeAll(
		Layer.succeed(Db, db as unknown as DbClient),
		grantLayer(allow),
		runner === "none" ? Layer.empty : runnerLayer(runner),
		"artifacts" in opts ? artifactsLayer(opts.artifacts ?? null) : Layer.empty,
		opts.jobs === undefined ? Layer.empty : Layer.succeed(Jobs, opts.jobs),
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

/** Seed a generation instance (the step-2 output — a reviewable
 * cohort) with N items. `item` overrides let tests plant specific
 * generation statuses/review states/corpus fields. */
const seedCohort = async (
	db: DbClient,
	input: {
		readonly count: number;
		readonly status?: string;
		readonly items?: readonly {
			readonly status?: string;
			readonly state?: string;
			readonly script?: string | null;
			readonly persona?: string | null;
			readonly withEntities?: boolean;
		}[];
	},
) => {
	const [inst] = await db
		.insert(evalInstance)
		.values({
			name: "cohort",
			mode: "selected",
			params: "{}",
			status: input.status ?? "ready",
			total: input.count,
			done: input.count,
			createdAt: new Date(),
		})
		.returning();
	const itemIds: number[] = [];
	for (let i = 0; i < input.count; i++) {
		const o = input.items?.[i] ?? {};
		const withEntities = o.withEntities ?? false;
		let patientId: number | null = null;
		let doctorId: number | null = null;
		if (withEntities) {
			const synUserId = `syn-${inst!.id}-${i}`;
			await db.insert(userTable).values({
				id: synUserId,
				name: "Dra. Teste",
				email: `${synUserId}@eval.ktb`,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
			const [d] = await db
				.insert(doctors)
				.values({
					userId: synUserId,
					displayName: "Dra. Teste",
					synthetic: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.returning();
			const [p] = await db
				.insert(patients)
				.values({
					ownerId: synUserId,
					name: "Paciente",
					synthetic: true,
					createdAt: new Date(),
				})
				.returning();
			doctorId = d!.id;
			patientId = p!.id;
		}
		const [item] = await db
			.insert(evalInstanceItem)
			.values({
				instanceId: inst!.id,
				persona:
					o.persona !== undefined
						? o.persona
						: JSON.stringify({ name: `p${i}`, gender: "f", ageBand: "adult", region: "south" }),
				script: o.script === undefined ? `script ${i}` : o.script,
				turns: "[]",
				voices: "{}",
				patientId,
				doctorId,
				scriptMode: "template",
				status: o.status ?? "done",
				state: o.state ?? "under_review",
				createdAt: new Date(),
			})
			.returning();
		itemIds.push(item!.id);
	}
	return { instanceId: inst!.id, itemIds };
};

describe("EvalValidator", () => {
	it("denies every method without the eval.validator grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(run(Effect.flatMap(EvalValidator, (v) => v.listCohorts()))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(run(Effect.flatMap(EvalValidator, (v) => v.listItems(1)))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId: 1 }))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await rt.dispose();
	});

	it("cohort rollup → review → startRun → progress lands the workflow", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { instanceId } = await seedCohort(db, { count: 2 });
		const cohorts = await run(Effect.flatMap(EvalValidator, (v) => v.listCohorts()));
		expect(cohorts[0]?.id).toBe(instanceId);
		expect(cohorts[0]?.count).toBe(2);
		expect(cohorts[0]?.pending).toBe(2);
		expect(cohorts[0]?.state).toBe("review");

		const items = await run(Effect.flatMap(EvalValidator, (v) => v.listItems(instanceId)));
		expect(items).toHaveLength(2);
		expect(items[0]?.persona?.gender).toBe("f");
		expect(items[0]?.script).toBe("script 0");

		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ itemId: items[0]!.id, decision: "approved", feedback: "ok" }),
			),
		);
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ itemId: items[1]!.id, decision: "rejected", feedback: "too formal" }),
			),
		);
		const after = await run(Effect.flatMap(EvalValidator, (v) => v.listItems(instanceId)));
		expect(after[0]?.state).toBe("approved");
		expect(after[1]?.feedback).toBe("too formal");

		// No runner bound → only approved items enter the run; it
		// stays queued rather than pretending to execute.
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
		expect(progress?.status).toBe("queued");
		expect(progress?.total).toBe(1);
		expect(progress?.instanceId).toBe(instanceId);
		expect(progress?.samples).toHaveLength(1);
		// The recorded input set makes the run auditable on its own.
		expect(progress?.params).toMatchObject({ instanceId, itemIds: [items[0]!.id] });
		await rt.dispose();
	});

	it("an explicit itemIds subset runs exactly those items", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { instanceId, itemIds } = await seedCohort(db, { count: 2 });
		for (const id of itemIds) {
			await run(
				Effect.flatMap(EvalValidator, (v) => v.review({ itemId: id, decision: "approved" })),
			);
		}
		const { runId } = await run(
			Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId, itemIds: [itemIds[1]!] })),
		);
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
		expect(progress?.total).toBe(1);
		expect(progress?.samples[0]?.itemId).toBe(itemIds[1]);
		await rt.dispose();
	});

	it("runner bound → per-sample outcomes persist and the run finishes", async () => {
		const { rt, run, db } = make();
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
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
		const { rt, run, db } = make({
			runner: ({ items, onSample }) =>
				Effect.forEach(
					items,
					(item) => onSample(item.id, { status: "failed", error: "tts exploded" }),
					{ discard: true },
				),
		});
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		let progress = null;
		for (let i = 0; i < 50; i++) {
			progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (progress?.status === "done") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(progress?.status).toBe("done");
		await rt.dispose();
	});

	it("a runner that throws wholesale lands the run as failed, not stuck running", async () => {
		const { rt, run, db } = make({
			runner: () => Effect.fail(new Error("runner crashed")) as never,
		});
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		let progress = null;
		for (let i = 0; i < 50; i++) {
			progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (progress?.status === "done" || progress?.status === "failed") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		// The run must terminate honestly — a crashed runner is a failed
		// run, never an eternal "running" row.
		expect(progress?.status).toBe("failed");
		// …and the experiment artifact still lands for audit.
		const [row] = await db.select().from(evalRun);
		expect(row?.experiment).not.toBeNull();
		await rt.dispose();
	});

	it("runner records persist as eval_run_record rows and the experiment column fills", async () => {
		const { rt, run, db } = make({
			runner: ({ items, onSample }) =>
				Effect.forEach(
					items,
					(item) =>
						onSample(item.id, {
							status: "ok",
							result: { wer: 0.05 },
							records: [
								{
									runId: `eval-${item.id}`,
									taskId: `eval-${item.id}`,
									stage: "asr",
									engine: "whisper",
									model: "large-v3",
									inputHash: "h",
									startedAt: 42,
									sampleId: String(item.id),
								},
							],
						}),
					{ discard: true },
				),
		});
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		let progress = null;
		for (let i = 0; i < 50; i++) {
			progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (progress?.status === "done") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(progress?.status).toBe("done");
		const records = await db.select().from(evalRunRecord);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			runId,
			itemId: itemIds[0],
			stage: "asr",
			engine: "whisper",
			model: "large-v3",
			startedAt: 42,
		});
		expect(JSON.parse(records[0]!.payload)).toMatchObject({ sampleId: String(itemIds[0]) });
		const [row] = await db.select().from(evalRun);
		const experiment = JSON.parse(row?.experiment ?? "{}") as {
			id: string;
			kind: string;
			dataset: { id: string; version: string };
			summary: { ok: number };
		};
		expect(experiment.id).toBe(`eval-run-${runId}`);
		expect(experiment.kind).toBe("run");
		// seedCohort writes no manifest → deterministic unknown-version pin.
		expect(experiment.dataset).toEqual({
			id: `eval-instance-${instanceId}`,
			version: "unknown",
		});
		expect(experiment.summary.ok).toBe(1);
		await rt.dispose();
	});

	it("WS-F: reject deletes the item's consultations row; an ok sample writes pipeline outputs back", async () => {
		const { rt, run, db } = make();
		const { instanceId, itemIds } = await seedCohort(db, { count: 2 });
		for (const [i, id] of itemIds.entries()) {
			await db.insert(consultations).values({
				userId: `syn-${id}`,
				transcript: `gold ${i}`,
				source: "eval",
				synthetic: true,
				evalItemId: id,
				createdAt: new Date(),
			});
		}
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[1]!, decision: "rejected" })),
		);
		// Rejection removed the second item's synthetic consultation.
		let rows = await db.select().from(consultations);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.evalItemId).toBe(itemIds[0]);

		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		for (let i = 0; i < 50; i++) {
			const p = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (p?.status === "done") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		// The surviving row carries the pipeline outputs — the default
		// runner reports asrText = the gold script.
		const [c] = await db.select().from(consultations);
		expect(c?.audioStatus).toBe("done");
		expect(c?.serverTranscript).toBe("script 0");
		await rt.dispose();
	});

	it("a stored instance manifest becomes the experiment's dataset pin", async () => {
		const { rt, run, db } = make();
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		const { eq } = await import("drizzle-orm");
		await db
			.update(evalInstance)
			.set({
				manifest: JSON.stringify({
					id: `eval-instance-${instanceId}`,
					version: "v1-abcdef12",
				}),
			})
			.where(eq(evalInstance.id, instanceId));
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		for (let i = 0; i < 50; i++) {
			const p = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (p?.status === "done") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		const [row] = await db.select().from(evalRun);
		const experiment = JSON.parse(row?.experiment ?? "{}") as {
			dataset: { id: string; version: string };
		};
		expect(experiment.dataset).toEqual({
			id: `eval-instance-${instanceId}`,
			version: "v1-abcdef12",
		});
		await rt.dispose();
	});

	it("an instance without generated items rolls up as empty", async () => {
		const { rt, run, db } = make({ runner: "none" });
		// The cohort rollup counts only generated items — a pending or
		// errored slot isn't reviewable, so this instance is `empty`.
		await seedCohort(db, {
			count: 2,
			items: [{ status: "pending" }, { status: "error" }],
		});
		const [c] = await run(Effect.flatMap(EvalValidator, (v) => v.listCohorts()));
		expect(c?.count).toBe(0);
		expect(c?.approved).toBe(0);
		expect(c?.state).toBe("empty");
		await rt.dispose();
	});

	it("review without feedback stores nulls, reviewer falls back when no email", async () => {
		const { rt, db } = make({ runner: "none" });
		const { itemIds } = await seedCohort(db, { count: 1 });
		// Principal without email → reviewedBy null (the ?? branch).
		await rt.runPromise(
			Effect.provideService(
				Effect.flatMap(EvalValidator, (v) =>
					v.review({ itemId: itemIds[0]!, decision: "rejected" }),
				),
				Principal,
				{ userId: "u2" } as never,
			) as Effect.Effect<unknown>,
		);
		const [item] = await db.select().from(evalInstanceItem);
		expect(item?.state).toBe("rejected");
		expect(item?.feedback).toBeNull();
		expect(item?.reviewedBy).toBeNull();
		await rt.dispose();
	});

	it("mixed review lands as mixed; a fully approved cohort lands as approved", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { instanceId, itemIds } = await seedCohort(db, { count: 2 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[1]!, decision: "rejected" })),
		);
		const [c] = await run(Effect.flatMap(EvalValidator, (v) => v.listCohorts()));
		expect(c?.state).toBe("mixed");
		const second = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) =>
				v.review({ itemId: second.itemIds[0]!, decision: "approved" }),
			),
		);
		const cs = await run(Effect.flatMap(EvalValidator, (v) => v.listCohorts()));
		expect(cs.find((x) => x.id === second.instanceId)?.state).toBe("approved");
		expect(cs.find((x) => x.id === instanceId)?.state).toBe("mixed");
		await rt.dispose();
	});

	it("an all-rejected cohort lands as rejected; a total-0 run has pct 0", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "rejected" })),
		);
		const [c] = await run(Effect.flatMap(EvalValidator, (v) => v.listCohorts()));
		expect(c?.state).toBe("rejected");
		const [r] = await db
			.insert(evalRun)
			.values({ instanceId, total: 0, createdAt: new Date() })
			.returning();
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(r!.id)));
		expect(progress?.pct).toBe(0);
		await rt.dispose();
	});

	it("rejecting an item deletes its synthetic entities, approving keeps them", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { instanceId, itemIds } = await seedCohort(db, {
			count: 2,
			items: [{ withEntities: true }, { withEntities: true }],
		});
		const items = await run(Effect.flatMap(EvalValidator, (v) => v.listItems(instanceId)));
		expect(items[0]?.patientId).not.toBeNull();
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[1]!, decision: "rejected" })),
		);
		// Rejected: patient + backing doctor user gone (doctor row
		// cascades from user). Approved: entities stay for the run.
		expect(await db.select().from(patients)).toHaveLength(1);
		expect(await db.select().from(userTable)).toHaveLength(1);
		expect(await db.select().from(doctors)).toHaveLength(1);
		const after = await run(Effect.flatMap(EvalValidator, (v) => v.listItems(instanceId)));
		expect(after[1]?.state).toBe("rejected");
		// FK set null released the links — the review row itself stays.
		expect(after[1]?.patientId).toBeNull();
		expect(after[1]?.doctorId).toBeNull();
		await rt.dispose();
	});

	it("startRun records the reviewer email and params; ungenerated items are excluded", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { instanceId, itemIds } = await seedCohort(db, {
			count: 3,
			items: [
				{ state: "approved" },
				// Approved but generation never finished — the run gate
				// composes review AND corpus presence, never picks it.
				{ state: "approved", status: "pending", script: null },
				{ state: "approved", status: "error", script: null },
			],
		});
		void itemIds;
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		const [runRow] = await db.select().from(evalRun);
		expect(runRow?.createdBy).toBe("v@x.com");
		expect(runRow?.total).toBe(1);
		const samples = await db.select().from(evalRunSample);
		expect(samples).toHaveLength(1);
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
		expect(progress?.total).toBe(1);
		await rt.dispose();
	});

	it("progress aggregates slices by axis and degrades missing keys to '—'", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { instanceId, itemIds } = await seedCohort(db, { count: 2 });
		const { eq } = await import("drizzle-orm");
		// Persona JSON missing most axes → the "—" bucket.
		await db
			.update(evalInstanceItem)
			.set({ persona: JSON.stringify({ region: "north" }) })
			.where(eq(evalInstanceItem.id, itemIds[1]!));
		const [r] = await db
			.insert(evalRun)
			.values({ instanceId, total: 2, createdAt: new Date() })
			.returning();
		await db.insert(evalRunSample).values({
			runId: r!.id,
			itemId: itemIds[0]!,
			status: "ok",
			result: JSON.stringify({ wer: 0.2 }),
			createdAt: new Date(),
		});
		await db.insert(evalRunSample).values({
			runId: r!.id,
			itemId: itemIds[1]!,
			status: "pending",
			createdAt: new Date(),
		});
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(r!.id)));
		const gender = progress?.aggregates.find((a) => a.axis === "gender");
		expect(gender?.slices.some((s) => s.key === "—")).toBe(true);
		const region = progress?.aggregates.find((a) => a.axis === "region");
		const north = region?.slices.find((s) => s.key === "north");
		expect(north).toMatchObject({ samples: 1, ok: 0, meanWer: null });
		const okSlice = region?.slices.find((s) => s.ok === 1);
		expect(okSlice?.meanWer).toBe(0.2);
		await rt.dispose();
	});

	it("parseJson falls back on malformed stored JSON", async () => {
		const { rt, run, db } = make({ runner: "none" });
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		// Corrupt the persona JSON in place — the card read must
		// degrade, not throw.
		const { eq } = await import("drizzle-orm");
		await db
			.update(evalInstanceItem)
			.set({ persona: "{broken json" })
			.where(eq(evalInstanceItem.id, itemIds[0]!));
		const cards = await run(Effect.flatMap(EvalValidator, (v) => v.listItems(instanceId)));
		expect(cards[0]?.persona).toEqual({});
		await rt.dispose();
	});

	it("sampleAudio streams bytes through EvalArtifacts, null without it", async () => {
		const seedRun = async (db: DbClient) => {
			const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
			const [r] = await db
				.insert(evalRun)
				.values({ instanceId, createdAt: new Date() })
				.returning();
			const [s] = await db
				.insert(evalRunSample)
				.values({
					runId: r!.id,
					itemId: itemIds[0]!,
					status: "ok",
					result: JSON.stringify({ audioUri: "file:///work/tts/audio/a.wav" }),
					createdAt: new Date(),
				})
				.returning();
			return s!.id;
		};

		const withDriver = make({ runner: "none", artifacts: new Uint8Array([1, 2, 3]) });
		const sampleId = await seedRun(withDriver.db);
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
		const sampleId2 = await seedRun(noDriver.db);
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
		const sampleId3 = await seedRun(failing.db);
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

	it("a null persona cards as null and an unreviewed cohort stays queued", async () => {
		// Default runner IS bound — but nothing is approved, so the
		// runnable pick is empty and the runner block is skipped: the
		// run row keeps status "queued" with total 0.
		const { rt, run, db } = make();
		const { instanceId } = await seedCohort(db, {
			count: 1,
			items: [{ persona: null }],
		});
		const cards = await run(Effect.flatMap(EvalValidator, (v) => v.listItems(instanceId)));
		expect(cards[0]?.persona).toBeNull();
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		const [runRow] = await db.select().from(evalRun);
		expect(runRow?.status).toBe("queued");
		expect(runRow?.total).toBe(0);
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
		expect(progress?.status).toBe("queued");
		expect(progress?.total).toBe(0);
		await rt.dispose();
	});

	it("startRun without an email records null createdBy; a null-persona item runs", async () => {
		const { rt, run, db } = make();
		const { instanceId } = await seedCohort(db, {
			count: 1,
			items: [{ state: "approved", persona: null }],
		});
		// Principal without email → createdBy null (the ?? branch).
		const { runId } = (await rt.runPromise(
			Effect.provideService(
				Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })),
				Principal,
				{ userId: "u2" } as never,
			) as Effect.Effect<{ runId: number }>,
		)) as { runId: number };
		const [runRow] = await db.select().from(evalRun);
		expect(runRow?.createdBy).toBeNull();
		// Null persona → the runner receives `patient: {}` (the other
		// arm of the ternary) and the default runner still finishes.
		let progress = null;
		for (let i = 0; i < 50; i++) {
			progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
			if (progress?.status === "done") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(progress?.status).toBe("done");
		expect(progress?.samples[0]?.status).toBe("ok");
		await rt.dispose();
	});

	it("panel guard follows the permission, loader yields the cohort list or []", async () => {
		const allow = make();
		const page = evalValidatorPanelPlugin.panel!.pages[0]!;
		const guardOk = await allow.rt.runPromise(
			Effect.provideService(page.guard!(), Principal, {
				userId: "u",
				email: "e",
			}) as Effect.Effect<boolean>,
		);
		expect(guardOk).toBe(true);
		const cohorts = await allow.rt.runPromise(
			Effect.provideService(page.loader!(), Principal, {
				userId: "u",
				email: "e",
			}) as Effect.Effect<readonly CohortSummary[]>,
		);
		expect(Array.isArray(cohorts)).toBe(true);
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
			}) as Effect.Effect<readonly CohortSummary[]>,
		);
		expect(loaderFallback).toEqual([]);
		await deny.rt.dispose();
	});
});

describe("EvalValidator — run CRUD + patient context", () => {
	it("hands persona demographics to the runner as patient context", async () => {
		const seen: { patient?: { sex?: string; age?: number } }[] = [];
		const { rt, run, db } = make({
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
		const { instanceId, itemIds } = await seedCohort(db, {
			count: 3,
			items: [
				{ persona: JSON.stringify({ gender: "f", ageBand: "child" }) },
				{ persona: JSON.stringify({ gender: "m", ageBand: "adult" }) },
				{ persona: JSON.stringify({ gender: "f", ageBand: "elderly" }) },
			],
		});
		for (const id of itemIds) {
			await run(
				Effect.flatMap(EvalValidator, (v) => v.review({ itemId: id, decision: "approved" })),
			);
		}
		await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		await new Promise((r) => setTimeout(r, 300));
		const ages = new Set(seen.map((i) => i.patient?.age));
		expect([...ages].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([8, 40, 70]);
		for (const i of seen) {
			expect(i.patient?.sex === "male" || i.patient?.sex === "female").toBe(true);
		}
		await rt.dispose();
	});

	it("run summary carries per-stage means when samples report them", async () => {
		const { rt, run, db } = make({
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
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
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
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
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

describe("EvalValidator — WS-E jobs dispatch", () => {
	const stubJobs = (sent: { kind: string; payload: unknown }[], fail?: Error): JobsEnqueuer => ({
		enqueue: async (kind, payload) => {
			if (fail !== undefined) throw fail;
			sent.push({ kind, payload });
			return { id: `job-${sent.length}`, kind, payload };
		},
	});

	it("jobs bound → startRun enqueues eval.run and the run stays queued", async () => {
		const sent: { kind: string; payload: unknown }[] = [];
		const { rt, run, db } = make({ jobs: stubJobs(sent) });
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		const { runId } = await run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId })));
		expect(sent).toEqual([{ kind: "eval.run", payload: { runId } }]);
		// The consumer owns execution now — nothing ran inline: the
		// sample is still pending and the run still queued.
		const samples = await db.select().from(evalRunSample);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.status).toBe("pending");
		const progress = await run(Effect.flatMap(EvalValidator, (v) => v.progress(runId)));
		expect(progress?.status).toBe("queued");
		expect(progress?.runnerBound).toBe(true);
		expect(progress?.queueBound).toBe(true);
		await rt.dispose();
	});

	it("an enqueue failure marks the run failed and propagates", async () => {
		const { rt, run, db } = make({ jobs: stubJobs([], new Error("queue down")) });
		const { instanceId, itemIds } = await seedCohort(db, { count: 1 });
		await run(
			Effect.flatMap(EvalValidator, (v) => v.review({ itemId: itemIds[0]!, decision: "approved" })),
		);
		await expect(
			run(Effect.flatMap(EvalValidator, (v) => v.startRun({ instanceId }))),
		).rejects.toThrow(/queue down|enqueue failed/);
		// No zombie "queued" row — the failure is on the record.
		const [row] = await db.select().from(evalRun);
		expect(row?.status).toBe("failed");
		expect(row?.summary).toContain("enqueue failed");
		await rt.dispose();
	});

	it("progress reports runnerBound/queueBound for each layer combination", async () => {
		const seedQueuedRun = async (db: DbClient) => {
			const { instanceId } = await seedCohort(db, { count: 1 });
			const [r] = await db
				.insert(evalRun)
				.values({ instanceId, createdAt: new Date() })
				.returning();
			return r!.id;
		};

		// Neither bound → honest false/false.
		const none = make({ runner: "none" });
		const noneRunId = await seedQueuedRun(none.db);
		const p1 = await none.run(Effect.flatMap(EvalValidator, (v) => v.progress(noneRunId)));
		expect(p1?.runnerBound).toBe(false);
		expect(p1?.queueBound).toBe(false);
		await none.rt.dispose();

		// Runner only → the inline fork path, queueBound false.
		const inline = make();
		const inlineRunId = await seedQueuedRun(inline.db);
		const p2 = await inline.run(Effect.flatMap(EvalValidator, (v) => v.progress(inlineRunId)));
		expect(p2?.runnerBound).toBe(true);
		expect(p2?.queueBound).toBe(false);
		await inline.rt.dispose();

		// Queue only (no runner) → the run still enqueues; the consumer
		// reports the missing runner honestly downstream.
		const queued = make({ runner: "none", jobs: stubJobs([]) });
		const queuedRunId = await seedQueuedRun(queued.db);
		const p3 = await queued.run(Effect.flatMap(EvalValidator, (v) => v.progress(queuedRunId)));
		expect(p3?.runnerBound).toBe(false);
		expect(p3?.queueBound).toBe(true);
		await queued.rt.dispose();
	});
});
