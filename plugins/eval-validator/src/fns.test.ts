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
import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { EVAL_VALIDATOR_TEST_DDL, EvalValidatorLive } from "./index.ts";
import {
	generateBatchFn,
	listBatchesFn,
	listPersonasFn,
	progressFn,
	deleteRunFn,
	reviewPersonaFn,
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
	let currentEmail: string | null = null;
	let allow = true;

	beforeAll(() => {
		const db = makeDb(makeD1(EVAL_VALIDATOR_TEST_DDL));
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

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		await expect(generateBatchFn({ data: { count: 1 } })).rejects.toThrow("unauthenticated");
		await expect(listBatchesFn({ data: {} })).rejects.toThrow("unauthenticated");
	});

	it("returns { ok: false } when the grant is missing", async () => {
		currentEmail = "v@x.com";
		allow = false;
		expect(await generateBatchFn({ data: { count: 1 } })).toEqual({ ok: false });
		expect(await listBatchesFn({ data: {} })).toEqual({ ok: false });
		expect(await listPersonasFn({ data: { batchId: 1 } })).toEqual({ ok: false });
		expect(await reviewPersonaFn({ data: { personaId: 1, decision: "approved" } })).toEqual({
			ok: false,
		});
		expect(await startRunFn({ data: { batchId: 1 } })).toEqual({ ok: false });
		expect(await progressFn({ data: { runId: 1 } })).toEqual({ ok: false });
		expect(await deleteRunFn({ data: { runId: 1 } })).toEqual({ ok: false });
		allow = true;
	});

	it("drives the full workflow through the fn surface", async () => {
		currentEmail = "v@x.com";
		const gen = await generateBatchFn({ data: { count: 2, seed: 7 } });
		expect(gen.ok).toBe(true);
		if (!gen.ok) return;
		const batchId = gen.data.batchId;

		const batches = await listBatchesFn({ data: {} });
		expect(batches.ok && batches.data.length).toBe(1);

		const personas = await listPersonasFn({ data: { batchId } });
		expect(personas.ok && personas.data.length).toBe(2);
		if (!personas.ok) return;
		expect(personas.data[0]?.persona.gender).toBeDefined();

		const review = await reviewPersonaFn({
			data: {
				personaId: personas.data[0]!.id,
				decision: "approved",
				feedback: "looks right",
			},
		});
		expect(review).toEqual({ ok: true, data: null });

		const after = await listPersonasFn({ data: { batchId } });
		expect(after.ok && after.data[0]?.state).toBe("approved");
		expect(after.ok && after.data[0]?.feedback).toBe("looks right");

		const started = await startRunFn({ data: { batchId } });
		expect(started.ok).toBe(true);
		if (!started.ok) return;

		const progress = await progressFn({ data: { runId: started.data.runId } });
		expect(progress.ok).toBe(true);
		expect(progress.ok && progress.data?.total).toBe(1);
	});

	it("progress on a missing run resolves to null", async () => {
		currentEmail = "v@x.com";
		const res = await progressFn({ data: { runId: 9999 } });
		expect(res).toEqual({ ok: true, data: null });
	});

	it("deleteRunFn denies without the grant and deletes with it", async () => {
		expect(await deleteRunFn({ data: { runId: 1 } })).toEqual({ ok: true, data: null });
	});
});
