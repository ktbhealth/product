import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const headers = { current: new Headers() };

vi.mock("@tanstack/react-start/server", () => ({
	// Fresh Headers per call: @ktb/server-fns memoizes session lookups
	// per request keyed on the Headers identity.
	getRequestHeaders: () => new Headers(headers.current),
}));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const chain = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return chain;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (arg?: { data?: unknown }) =>
				h(arg === undefined ? {} : { ...arg, data: validate ? validate(arg.data) : arg.data }),
		};
		return chain;
	},
}));

import { Auth } from "@ktb/auth";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Principal } from "@ktb/authz";
import { Permissions } from "@ktb/rbac";
import { EvalRunner } from "@ktb/eval-consultation";
import { evalInstance, evalInstanceItem } from "@ktb/eval-persona";
import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { EvalValidatorLive } from "./index.ts";
import { EVAL_VALIDATOR_TEST_DDL } from "./test-ddl.ts";
import {
	listCohortItemsFn,
	listCohortsFn,
	listRunsFn,
	progressFn,
	deleteRunFn,
	reviewItemFn,
	startRunFn,
} from "./fns.ts";

const sessionFor = (email: string | null) =>
	email === null
		? null
		: {
				user: { id: `id-${email}`, email, name: email },
				sessionId: "s1",
				expiresAt: new Date(Date.now() + 3600_000),
			};

describe("eval validator fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let db: ReturnType<typeof makeDb>;
	let currentEmail: string | null = null;
	let allow = true;

	beforeAll(() => {
		db = makeDb(makeD1(EVAL_VALIDATOR_TEST_DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(
				Permissions,
				Permissions.of({
					permissionsFor: () => Effect.succeed(new Map()),
					canFor: () => Effect.succeed(allow),
					can: () => Effect.succeed(allow),
					requirePermissionFor: () =>
						allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
					requirePermission: () =>
						allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
					invalidate: () => Effect.void,
				} as never),
			),
			// No EvalRunner bound: startRun leaves the run queued — the fn
			// surface is exercised either way.
			Layer.succeed(EvalRunner, EvalRunner.of({ run: () => Effect.void })),
		);
		runtime = ManagedRuntime.make(
			Layer.merge(EvalValidatorLive.pipe(Layer.provide(env)), env) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		const auth = Auth.of({
			setUserBanned: async () => {},
			getSession: async () => sessionFor(currentEmail) as never,
		});
		setServerRuntime({
			run: ((effect: Effect.Effect<unknown, unknown, unknown>) =>
				runtime.runPromise(effect.pipe(Effect.provideService(Auth, auth)))) as ServerRuntime["run"],
			runAs: ((
				user: { id: string; email: string },
				effect: Effect.Effect<unknown, unknown, unknown>,
			) =>
				runtime.runPromise(
					effect.pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
						}),
					),
				)) as ServerRuntime["runAs"],
			audioTranscribeModel: "test-model",
			getLocale: () => "en",
		});
	});

	afterAll(() => {
		resetServerRuntime();
		return runtime.dispose();
	});

	/** A ready cohort with N generated items — the step-2 output the
	 * validator consumes (the fn tests don't exercise generation). */
	const seedCohort = async (count: number) => {
		const [inst] = await db
			.insert(evalInstance)
			.values({
				name: "cohort",
				mode: "selected",
				params: "{}",
				status: "ready",
				total: count,
				done: count,
				createdAt: new Date(),
			})
			.returning();
		const items = await db
			.insert(evalInstanceItem)
			.values(
				Array.from({ length: count }, (_, i) => ({
					instanceId: inst!.id,
					persona: JSON.stringify({ name: `p${i}`, gender: "f", ageBand: "adult" }),
					script: `script ${i}`,
					turns: "[]",
					voices: "{}",
					scriptMode: "template",
					status: "done",
					state: "under_review",
					createdAt: new Date(),
				})),
			)
			.returning({ id: evalInstanceItem.id });
		return { instanceId: inst!.id, items };
	};

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		await expect(listCohortsFn({ data: {} })).rejects.toThrow("unauthenticated");
		await expect(startRunFn({ data: { instanceId: 1 } })).rejects.toThrow("unauthenticated");
	});

	it("returns { ok: false } when the grant is missing", async () => {
		currentEmail = "v@x.com";
		allow = false;
		expect(await listCohortsFn({ data: {} })).toEqual({ ok: false });
		expect(await listCohortItemsFn({ data: { cohortId: 1 } })).toEqual({ ok: false });
		expect(await reviewItemFn({ data: { itemId: 1, decision: "approved" } })).toEqual({
			ok: false,
		});
		expect(await startRunFn({ data: { instanceId: 1 } })).toEqual({ ok: false });
		expect(await listRunsFn({ data: { cohortId: 1 } })).toEqual({ ok: false });
		expect(await progressFn({ data: { runId: 1 } })).toEqual({ ok: false });
		expect(await deleteRunFn({ data: { runId: 1 } })).toEqual({ ok: false });
		allow = true;
	});

	it("drives the review → run workflow through the fn surface", async () => {
		currentEmail = "v@x.com";
		const { instanceId, items } = await seedCohort(2);

		const cohorts = await listCohortsFn({ data: {} });
		expect(cohorts.ok && cohorts.data.some((c) => c.id === instanceId)).toBe(true);

		const listed = await listCohortItemsFn({ data: { cohortId: instanceId } });
		expect(listed.ok && listed.data.length).toBe(2);
		if (!listed.ok) return;
		expect(listed.data[0]?.persona?.gender).toBe("f");

		const review = await reviewItemFn({
			data: {
				itemId: items[0]!.id,
				decision: "approved",
				feedback: "looks right",
			},
		});
		expect(review).toEqual({ ok: true, data: null });

		const after = await listCohortItemsFn({ data: { cohortId: instanceId } });
		expect(after.ok && after.data[0]?.state).toBe("approved");
		expect(after.ok && after.data[0]?.feedback).toBe("looks right");

		const started = await startRunFn({ data: { instanceId } });
		expect(started.ok).toBe(true);
		if (!started.ok) return;

		const runs = await listRunsFn({ data: { cohortId: instanceId } });
		expect(runs.ok && runs.data.some((r) => r.id === started.data.runId)).toBe(true);

		const progress = await progressFn({ data: { runId: started.data.runId } });
		expect(progress.ok).toBe(true);
		expect(progress.ok && progress.data?.total).toBe(1);
	});

	it("progress on a missing run resolves to null", async () => {
		currentEmail = "v@x.com";
		const res = await progressFn({ data: { runId: 9999 } });
		expect(res).toEqual({ ok: true, data: null });
	});

	it("deleteRunFn deletes with the grant", async () => {
		expect(await deleteRunFn({ data: { runId: 1 } })).toEqual({ ok: true, data: null });
	});
});
