import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import type { WizardDefinition } from "./definition.ts";
import { WizardDefinitions } from "./definition.ts";
import { WizardHooks } from "./hooks.ts";
import { Permissions, type PermissionsShape } from "@ktb/rbac";
import {
	MAX_ANSWERS_BYTES,
	MAX_STEP_VALUE_BYTES,
	WIZARDS_TEST_DDL,
	Wizards,
	WizardsServicesLive,
	type UpsertDefInput,
} from "./service.ts";
import { wizardDefs, wizardRuns } from "./schema.ts";

const FORM_SCHEMA = { type: "object", properties: { name: { type: "string" } } } as const;

const twoStep: WizardDefinition = {
	id: "intake",
	title: "Intake",
	steps: [
		{ kind: "info", id: "welcome", title: "Welcome" },
		{ kind: "form", id: "details", schema: FORM_SCHEMA },
	],
};

const dbStep: WizardDefinition = { ...twoStep, id: "dbdef" };

const conditional: WizardDefinition = {
	id: "cond",
	steps: [
		{ kind: "form", id: "pick", schema: { type: "object" } },
		{
			kind: "info",
			id: "extra",
			when: { path: "pick.go", op: "eq", value: true },
		},
		{ kind: "info", id: "done" },
	],
};

const withCompletion: WizardDefinition = {
	id: "fin",
	steps: [{ kind: "info", id: "only" }],
	completion: { kind: "hook", hook: "test.done", data: { v: "$answers.only.note" } },
};

const retryDef: WizardDefinition = {
	...withCompletion,
	id: "retry",
	completion: { kind: "hook", hook: "test.retry" },
};

const retry2Def: WizardDefinition = {
	...withCompletion,
	id: "retry2",
	completion: { kind: "hook", hook: "test.retry2" },
};

const permDef: WizardDefinition = {
	...twoStep,
	id: "perm",
	permission: "wizards.run",
};

/** The contributed-def allowlist the service checks client-supplied
 * definitions against — every def the tests start runs with. */
const contributed: readonly WizardDefinition[] = [
	twoStep,
	conditional,
	withCompletion,
	retryDef,
	retry2Def,
	permDef,
];

const permissionsStub = (allowed: boolean): PermissionsShape =>
	({
		permissionsFor: () => Effect.succeed(new Map()),
		canFor: () => Effect.succeed(allowed),
		can: () => Effect.succeed(allowed),
		requirePermissionFor: () => (allowed ? Effect.void : Effect.die("forbidden")),
		requirePermission: () => (allowed ? Effect.void : Effect.die("forbidden")),
		invalidate: () => Effect.void,
	}) as unknown as PermissionsShape;

describe("WizardsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Wizards | WizardHooks, never>;
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(WIZARDS_TEST_DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			Layer.succeed(WizardDefinitions, { wizards: contributed }),
		);
		runtime = ManagedRuntime.make(WizardsServicesLive.pipe(Layer.provide(env)));
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Wizards | WizardHooks>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (w: Wizards["Service"]) => Effect.Effect<A, E, WizardHooks>) =>
		Effect.flatMap(Wizards, f);

	const user = <A, E>(f: (w: Wizards["Service"]) => Effect.Effect<A, E, WizardHooks>, id = "u1") =>
		asUser(id, call(f));

	const admin = <A, E>(f: (w: Wizards["Service"]) => Effect.Effect<A, E, WizardHooks>) =>
		asUser("admin-1", call(f), "admin@x.com");

	const upsert = (input: UpsertDefInput) => admin((w) => w.adminUpsert(input));

	describe("admin definitions", () => {
		it("rejects non-admins on every admin method", async () => {
			await expect(
				asUser(
					"u1",
					call((w) => w.adminList()),
					undefined,
				),
			).rejects.toThrow();
			await expect(
				user((w) => w.adminUpsert({ key: "x", title: "x", definition: twoStep })),
			).rejects.toThrow();
			await expect(user((w) => w.adminSetPublished("x", true))).rejects.toThrow();
			await expect(user((w) => w.adminRemove("x"))).rejects.toThrow();
		});

		it("upserts, lists, publishes and removes defs", async () => {
			const created = await upsert({
				key: "intake",
				title: "Intake",
				description: "desc",
				definition: twoStep,
			});
			expect(created).toMatchObject({
				key: "intake",
				title: "Intake",
				published: false,
			});
			expect(created.definition.id).toBe("intake");

			// draft is not in the public listing
			const drafts = await asUser(
				null,
				Effect.flatMap(Wizards, (w) => w.publishedDefs()),
			);
			expect(drafts).toEqual([]);

			await admin((w) => w.adminSetPublished("intake", true));
			const published = await asUser(
				null,
				Effect.flatMap(Wizards, (w) => w.publishedDefs()),
			);
			expect(published.map((d) => d.key)).toEqual(["intake"]);

			const all = await admin((w) => w.adminList());
			expect(all).toHaveLength(1);

			// upsert updates in place
			const updated = await upsert({
				key: "intake",
				title: "Intake v2",
				definition: twoStep,
				published: true,
			});
			expect(updated.title).toBe("Intake v2");
			expect(updated.published).toBe(true);

			// omitting `published` preserves the stored flag
			const kept = await upsert({
				key: "intake",
				title: "Intake v3",
				definition: twoStep,
			});
			expect(kept.published).toBe(true);

			await admin((w) => w.adminRemove("intake"));
			const after = await admin((w) => w.adminList());
			expect(after).toEqual([]);
		});

		it("rejects invalid upserts", async () => {
			await expect(upsert({ key: "Bad Key", title: "x", definition: twoStep })).rejects.toThrow();
			const mismatch = await upsert({ key: "other", title: "x", definition: twoStep }).catch(
				(e: unknown) => e,
			);
			expect(mismatch).toMatchObject({ _tag: "InvalidWizardDefinition" });
			expect((mismatch as { reason: string }).reason).toContain("does not match");
			await expect(upsert({ key: "bad", title: "x", definition: { id: "bad" } })).rejects.toThrow();
		});

		it("fails WizardDefNotFound on publish/remove of missing keys", async () => {
			const e1 = await asUser(
				"admin-1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.adminSetPublished("ghost", true))),
				"admin@x.com",
			);
			expect(Exit.isFailure(e1)).toBe(true);
			if (Exit.isFailure(e1)) expect(String(e1.cause)).toContain("WizardDefNotFound");
			const e2 = await asUser(
				"admin-1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.adminRemove("ghost"))),
				"admin@x.com",
			);
			expect(Exit.isFailure(e2)).toBe(true);
			if (Exit.isFailure(e2)) expect(String(e2.cause)).toContain("WizardDefNotFound");
		});
	});

	describe("runs", () => {
		it("starts a run from a client-supplied definition", async () => {
			const view = await user((w) => w.startRun({ key: "intake", definition: twoStep }));
			expect(view.status).toBe("active");
			expect(view.key).toBe("intake");
			expect(view.step?.id).toBe("welcome");
			expect(view.stepIndex).toBe(0);
			expect(view.canGoBack).toBe(false);
			expect(view.isLastStep).toBe(false);
		});

		it("rejects bad keys, defs and id mismatches", async () => {
			const e1 = await asUser(
				"u1",
				Effect.exit(call((w) => w.startRun({ key: "Bad", definition: twoStep }))),
			);
			expect(Exit.isFailure(e1)).toBe(true);
			const e2 = await asUser(
				"u1",
				Effect.exit(call((w) => w.startRun({ key: "x", definition: { nope: 1 } }))),
			);
			expect(Exit.isFailure(e2)).toBe(true);
			// def.id "cond" !== key "intake"
			const e3 = await asUser(
				"u1",
				Effect.exit(call((w) => w.startRun({ key: "intake", definition: conditional }))),
			);
			expect(Exit.isFailure(e3)).toBe(true);
			if (Exit.isFailure(e3)) expect(String(e3.cause)).toContain("InvalidWizardDefinition");
		});

		it("requires a principal", async () => {
			const exit = await asUser(
				null,
				Effect.exit(call((w) => w.startRun({ key: "intake", definition: twoStep }))),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("Forbidden");
		});

		it("rejects client defs that aren't contributed defs", async () => {
			// Well-formed, id matches the key, but nothing contributed it —
			// a forgery attempt (arbitrary hook completion).
			const forged: WizardDefinition = {
				id: "forged",
				steps: [{ kind: "info", id: "s" }],
				completion: { kind: "hook", hook: "evil.hook" },
			};
			const e1 = await asUser(
				"u1",
				Effect.exit(call((w) => w.startRun({ key: "forged", definition: forged }))),
			);
			expect(Exit.isFailure(e1)).toBe(true);
			if (Exit.isFailure(e1)) expect(String(e1.cause)).toContain("ForbiddenWizardDefinition");

			// id matches a contributed def but the content differs.
			const tampered: WizardDefinition = {
				...withCompletion,
				completion: { kind: "hook", hook: "attacker.hook" },
			};
			const e2 = await asUser(
				"u1",
				Effect.exit(call((w) => w.startRun({ key: "fin", definition: tampered }))),
			);
			expect(Exit.isFailure(e2)).toBe(true);
			if (Exit.isFailure(e2)) expect(String(e2.cause)).toContain("ForbiddenWizardDefinition");
		});

		it("accepts a contributed def regardless of key order", async () => {
			// Same def, different top-level key order — canonical JSON
			// comparison must still match the contributed registry entry.
			const shuffled: WizardDefinition = {
				steps: withCompletion.steps,
				completion: withCompletion.completion,
				id: "fin",
			};
			const view = await user((w) => w.startRun({ key: "fin", definition: shuffled }));
			expect(view.status).toBe("active");
			expect(view.definition.id).toBe("fin");
		});

		it("enforces def.permission through the optional Permissions port", async () => {
			// No Permissions service bound → declared permission fails closed.
			const e1 = await asUser(
				"u1",
				Effect.exit(call((w) => w.startRun({ key: "perm", definition: permDef }))),
			);
			expect(Exit.isFailure(e1)).toBe(true);
			if (Exit.isFailure(e1)) expect(String(e1.cause)).toContain("WizardPermissionDenied");

			// serviceOption(Permissions) is captured at layer build, so
			// allow/deny need their own runtimes.
			const startWith = (allowed: boolean) => {
				const rt = ManagedRuntime.make(
					WizardsServicesLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								Layer.succeed(Db, db),
								Layer.succeed(
									PlatformAdmin,
									makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
								),
								Layer.succeed(WizardDefinitions, { wizards: contributed }),
								Layer.succeed(Permissions, permissionsStub(allowed)),
							),
						),
					),
				);
				return rt
					.runPromise(
						Effect.exit(
							Effect.flatMap(Wizards, (w) => w.startRun({ key: "perm", definition: permDef })).pipe(
								Effect.provideService(Principal, { userId: "u1" }),
							),
						),
					)
					.finally(() => rt.dispose());
			};

			const granted = await startWith(true);
			expect(Exit.isSuccess(granted)).toBe(true);
			const denied = await startWith(false);
			expect(Exit.isFailure(denied)).toBe(true);
			if (Exit.isFailure(denied)) {
				expect(String(denied.cause)).toContain("WizardPermissionDenied");
			}
		});

		it("walks a run to completion through info + form steps", async () => {
			const started = await user((w) => w.startRun({ key: "intake", definition: twoStep }));
			const runId = started.id;

			// advance past the info step (no value submitted)
			const second = await user((w) => w.advance(runId, { stepId: "welcome" }));
			expect(second.step?.id).toBe("details");
			expect(second.stepIndex).toBe(1);
			expect(second.canGoBack).toBe(true);

			// stepId mismatch
			const mismatch = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.advance(runId, { stepId: "nope" }))),
			);
			expect(Exit.isFailure(mismatch)).toBe(true);
			if (Exit.isFailure(mismatch)) expect(String(mismatch.cause)).toContain("StepMismatch");

			// submit the form step → done → completed (no completion target)
			const done = await user((w) =>
				w.advance(runId, { stepId: "details", value: { name: "Ana" } }),
			);
			expect(done.status).toBe("completed");
			expect(done.step).toBeNull();
			expect(done.answers).toEqual({ details: { name: "Ana" } });

			// terminal runs reject further mutation
			const e = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.advance(runId, {}))),
			);
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("WizardNotActive");
		});

		it("validates form-step values against the step schema server-side", async () => {
			const started = await user((w) => w.startRun({ key: "intake", definition: twoStep }));
			const runId = started.id;
			await user((w) => w.advance(runId, { stepId: "welcome" }));
			// FORM_SCHEMA requires name to be a string when present.
			const e = await asUser(
				"u1",
				Effect.exit(
					Effect.flatMap(Wizards, (w) =>
						w.advance(runId, { stepId: "details", value: { name: 42 } }),
					),
				),
			);
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("InvalidStepValue");
			// the rejected value was NOT persisted — a valid resubmit works
			const done = await user((w) =>
				w.advance(runId, { stepId: "details", value: { name: "Ana" } }),
			);
			expect(done.status).toBe("completed");
			expect(done.answers).toEqual({ details: { name: "Ana" } });
		});

		it("rejects step values over the serialized cap", async () => {
			const started = await user((w) => w.startRun({ key: "intake", definition: twoStep }));
			const runId = started.id;
			await user((w) => w.advance(runId, { stepId: "welcome" }));
			const big = "x".repeat(MAX_STEP_VALUE_BYTES);
			const e = await asUser(
				"u1",
				Effect.exit(
					Effect.flatMap(Wizards, (w) => w.advance(runId, { stepId: "details", value: big })),
				),
			);
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("InvalidStepValue");
		});

		it("rejects unserializable step values", async () => {
			const started = await user((w) => w.startRun({ key: "intake", definition: twoStep }));
			const runId = started.id;
			await user((w) => w.advance(runId, { stepId: "welcome" }));
			// Circular refs can't cross the wire, but a direct service
			// caller could pass one — JSON.stringify throws → -1 → reject.
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			for (const bad of [circular, () => {}]) {
				const e = await asUser(
					"u1",
					Effect.exit(
						Effect.flatMap(Wizards, (w) => w.advance(runId, { stepId: "details", value: bad })),
					),
				);
				expect(Exit.isFailure(e)).toBe(true);
				if (Exit.isFailure(e)) expect(String(e.cause)).toContain("InvalidStepValue");
			}
		});

		it("resolves conditional steps against answers", async () => {
			const started = await user((w) => w.startRun({ key: "cond", definition: conditional }));
			const runId = started.id;
			// pick.go unset → "extra" hidden → next visible is "done"
			const second = await user((w) => w.advance(runId, { stepId: "pick", value: { go: false } }));
			expect(second.step?.id).toBe("done");
			const third = await user((w) => w.advance(runId, { stepId: "done" }));
			expect(third.status).toBe("completed");
		});

		it("shows the conditional step when the answer enables it", async () => {
			const started = await user((w) => w.startRun({ key: "cond", definition: conditional }));
			const second = await user((w) =>
				w.advance(started.id, { stepId: "pick", value: { go: true } }),
			);
			expect(second.step?.id).toBe("extra");
		});

		it("backs up to the previous visible step", async () => {
			const started = await user((w) => w.startRun({ key: "intake", definition: twoStep }));
			const runId = started.id;
			await user((w) => w.advance(runId, { stepId: "welcome" }));
			const back = await user((w) => w.back(runId));
			expect(back.step?.id).toBe("welcome");
			expect(back.stepIndex).toBe(0);
			// already first → stays
			const again = await user((w) => w.back(runId));
			expect(again.step?.id).toBe("welcome");
		});

		it("abandons a run", async () => {
			const started = await user((w) => w.startRun({ key: "intake", definition: twoStep }));
			await user((w) => w.abandon(started.id));
			const view = await user((w) => w.getRun(started.id));
			expect(view?.status).toBe("abandoned");
			expect(view?.step).toBeNull();
			const e = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.abandon(started.id))),
			);
			expect(Exit.isFailure(e)).toBe(true);
		});

		it("scopes runs to their owner", async () => {
			const started = await user((w) => w.startRun({ key: "intake", definition: twoStep }), "u1");
			// other user sees nothing
			const other = await user((w) => w.getRun(started.id), "u2");
			expect(other).toBeNull();
			// and cannot mutate
			const e = await asUser(
				"u2",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.advance(started.id, {}))),
			);
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("RunForbidden");
			// missing id → null
			const missing = await user((w) => w.getRun(99999));
			expect(missing).toBeNull();
		});

		it("fires a hook completion on the last step", async () => {
			const seen: unknown[] = [];
			await asUser(
				"u9",
				Effect.gen(function* () {
					const hooks = yield* WizardHooks;
					hooks.register("test.done", (run) =>
						Effect.sync(() => {
							seen.push(run.payload);
						}),
					);
					const wizards = yield* Wizards;
					const started = yield* wizards.startRun({
						key: "fin",
						definition: withCompletion,
					});
					const done = yield* wizards.advance(started.id, {
						stepId: "only",
						value: { note: "hi" },
					});
					expect(done.status).toBe("completed");
				}),
			);
			expect(seen).toEqual([{ v: "hi" }]);
		});

		it("keeps the run active when completion fails, then retries", async () => {
			// "test.retry" is registered only AFTER the first failure.
			const started = await user((w) => w.startRun({ key: "retry", definition: retryDef }));
			const runId = started.id;
			// unregistered hook → CompletionFailed; run stays active at done
			const e = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.advance(runId, { stepId: "only" }))),
			);
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("CompletionFailed");

			// parked at done: step is null but status still active
			const parked = await user((w) => w.getRun(runId));
			expect(parked?.status).toBe("active");
			expect(parked?.step).toBeNull();

			// advance while parked re-fires the completion (still fails)
			const retry = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.advance(runId, {}))),
			);
			expect(Exit.isFailure(retry)).toBe(true);

			// back from the done position returns to the last step
			const back = await user((w) => w.back(runId));
			expect(back.step?.id).toBe("only");

			// register the hook and re-advance → completes
			await asUser(
				"u1",
				Effect.gen(function* () {
					const hooks = yield* WizardHooks;
					hooks.register("test.retry", () => Effect.void);
				}),
			);
			const done = await user((w) => w.advance(runId, { stepId: "only" }));
			expect(done.status).toBe("completed");
		});

		it("completes a parked run via a bare advance once the hook exists", async () => {
			const started = await user((w) => w.startRun({ key: "retry2", definition: retry2Def }));
			const runId = started.id;
			// park at done with a failing completion
			await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.advance(runId, { stepId: "only" }))),
			);
			// register the hook, then a bare advance re-runs finalize → completed
			await asUser(
				"u1",
				Effect.gen(function* () {
					const hooks = yield* WizardHooks;
					hooks.register("test.retry2", () => Effect.void);
				}),
			);
			const done = await user((w) => w.advance(runId, {}));
			expect(done.status).toBe("completed");
		});

		it("force-completes via complete()", async () => {
			const started = await user((w) => w.startRun({ key: "intake", definition: twoStep }));
			const done = await user((w) => w.complete(started.id));
			expect(done.status).toBe("completed");
		});
	});

	describe("DB-authored definitions", () => {
		it("prefers the stored def and requires published", async () => {
			await upsert({
				key: "dbdef",
				title: "DB",
				definition: dbStep,
				published: false,
			});
			// unpublished DB def rejects even with a valid client def
			const e = await asUser(
				"u1",
				Effect.exit(call((w) => w.startRun({ key: "dbdef", definition: dbStep }))),
			);
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("WizardNotPublished");

			await admin((w) => w.adminSetPublished("dbdef", true));
			const view = await user((w) => w.startRun({ key: "dbdef", definition: conditional }));
			// stored def wins — step ids come from dbStep, not conditional
			expect(view.definition.id).toBe("dbdef");
			expect(view.step?.id).toBe("welcome");
		});
	});

	describe("corrupt state", () => {
		const insertRun = (over: Record<string, unknown>) =>
			db
				.insert(wizardRuns)
				.values({
					key: "intake",
					definitionJson: JSON.stringify(twoStep),
					status: "active",
					stepIndex: 0,
					answersJson: "{}",
					ownerId: "u1",
					createdAt: new Date(),
					updatedAt: new Date(),
					...over,
				} as never)
				.returning();

		it("fails CorruptWizardRun on unparseable stored state", async () => {
			const [badJson] = await insertRun({ definitionJson: "{not json" });
			const e1 = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.getRun(badJson!.id))),
			);
			expect(Exit.isFailure(e1)).toBe(true);
			if (Exit.isFailure(e1)) expect(String(e1.cause)).toContain("CorruptWizardRun");

			const [badDef] = await insertRun({ definitionJson: JSON.stringify({ id: "Bad Id" }) });
			const e2 = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.getRun(badDef!.id))),
			);
			expect(Exit.isFailure(e2)).toBe(true);
			if (Exit.isFailure(e2)) expect(String(e2.cause)).toContain("CorruptWizardRun");

			const [badPos] = await insertRun({ stepIndex: -1 });
			const e3 = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.getRun(badPos!.id))),
			);
			expect(Exit.isFailure(e3)).toBe(true);
			if (Exit.isFailure(e3)) expect(String(e3.cause)).toContain("CorruptWizardRun");
		});

		it("fails CorruptWizardRun on non-object or unparseable answers_json", async () => {
			for (const answersJson of ["[1,2,3]", '"str"', "{nope"]) {
				const [row] = await insertRun({ answersJson });
				const e = await asUser(
					"u1",
					Effect.exit(Effect.flatMap(Wizards, (w) => w.getRun(row!.id))),
				);
				expect(Exit.isFailure(e)).toBe(true);
				if (Exit.isFailure(e)) expect(String(e.cause)).toContain("CorruptWizardRun");
			}
		});

		it("rejects answer sets over the serialized cap", async () => {
			const [row] = await insertRun({
				answersJson: JSON.stringify({ welcome: "x".repeat(MAX_ANSWERS_BYTES) }),
			});
			const e = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.advance(row!.id, { stepId: "welcome" }))),
			);
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("InvalidStepValue");
		});

		it("recovers stale completing claims and rejects fresh ones", async () => {
			const [stale] = await insertRun({
				status: "completing",
				updatedAt: new Date(Date.now() - 10 * 60 * 1000),
			});
			const view = await user((w) => w.getRun(stale!.id));
			expect(view?.status).toBe("active");
			expect(view?.step?.id).toBe("welcome");

			const [fresh] = await insertRun({ status: "completing" });
			const e = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.advance(fresh!.id, {}))),
			);
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("WizardNotActive");
		});

		it("memoizes parsed definitions across ops and evicts past the cap", async () => {
			// >100 distinct snapshots force FIFO eviction; re-reads hit
			// the cache (correctness is what matters — the cache is an
			// optimization, so assert views resolve identically).
			const ids: number[] = [];
			for (let i = 0; i < 105; i += 1) {
				const [row] = await insertRun({
					definitionJson: JSON.stringify({ ...twoStep, title: `t${i}` }),
				});
				ids.push(row!.id);
			}
			for (const id of ids) {
				const view = await user((w) => w.getRun(id));
				expect(view?.status).toBe("active");
			}
			// second pass — every read is now a cache hit
			for (const id of ids.slice(0, 5)) {
				const view = await user((w) => w.getRun(id));
				expect(view?.step?.id).toBe("welcome");
			}
		});

		it("rejects mutations on missing runs", async () => {
			const e = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.advance(424242, {}))),
			);
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("WizardRunNotFound");
		});

		it("rejects back() on a terminal run", async () => {
			const started = await user((w) => w.startRun({ key: "intake", definition: twoStep }));
			await user((w) => w.abandon(started.id));
			const e = await asUser("u1", Effect.exit(Effect.flatMap(Wizards, (w) => w.back(started.id))));
			expect(Exit.isFailure(e)).toBe(true);
			if (Exit.isFailure(e)) expect(String(e.cause)).toContain("WizardNotActive");
		});

		it("surfaces corrupt DB defs as typed failures", async () => {
			await db.insert(wizardDefs).values({
				key: "corrupt",
				title: "Corrupt",
				description: "",
				definitionJson: "{oops",
				published: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
			// publishedDefs re-validates stored JSON → InvalidWizardDefinition
			const e1 = await asUser(null, Effect.exit(Effect.flatMap(Wizards, (w) => w.publishedDefs())));
			expect(Exit.isFailure(e1)).toBe(true);
			if (Exit.isFailure(e1)) expect(String(e1.cause)).toContain("InvalidWizardDefinition");

			// startRun against the corrupt published row → InvalidWizardDefinition
			const e2 = await asUser(
				"u1",
				Effect.exit(Effect.flatMap(Wizards, (w) => w.startRun({ key: "corrupt" }))),
			);
			expect(Exit.isFailure(e2)).toBe(true);
			if (Exit.isFailure(e2)) expect(String(e2.cause)).toContain("InvalidWizardDefinition");

			await admin((w) => w.adminRemove("corrupt"));
		});
	});
});
