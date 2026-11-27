import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { forbiddenTo, runAs, sessionHandler } from "@ktb/server-fns";

import {
	EvalValidator,
	type CohortItemCard,
	type CohortSummary,
	type RunListItem,
	type RunProgress,
} from "./index.ts";

// Eval validator server functions (P-081): the /platform/eval surface
// mutates through these. The service re-checks the eval.validator
// grant inside runAs; `Forbidden` collapses to `{ ok: false }` like
// the other admin fns.

const CohortIdInput = Schema.Struct({ cohortId: Schema.Number });
const ReviewInput = Schema.Struct({
	itemId: Schema.Number,
	decision: Schema.Literals(["approved", "rejected"]),
	// The client sends `feedback: undefined` when the textarea is
	// empty — the serializer keeps the key, so this must tolerate
	// undefined/null on the wire.
	feedback: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});
const StartRunInput = Schema.Struct({
	instanceId: Schema.Number,
	// Optional explicit subset — absent runs every runnable
	// (approved + generated) item of the cohort.
	itemIds: Schema.optional(Schema.Array(Schema.Number)),
});
const RunIdInput = Schema.Struct({ runId: Schema.Number });

const decodeCohortId = Schema.decodeUnknownSync(CohortIdInput);
const decodeReview = Schema.decodeUnknownSync(ReviewInput);
const decodeStartRun = Schema.decodeUnknownSync(StartRunInput);
const decodeRunId = Schema.decodeUnknownSync(RunIdInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

export const listCohortsFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => input)
	.handler(
		sessionHandler(async ({ run }): Promise<Result<readonly CohortSummary[]>> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const v = yield* EvalValidator;
						const r = yield* v.listCohorts();
						return { ok: true as const, data: r };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const listCohortItemsFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeCohortId(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<readonly CohortItemCard[]>> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const v = yield* EvalValidator;
						const r = yield* v.listItems(data.cohortId);
						return { ok: true as const, data: r };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const reviewItemFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeReview(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<null>> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const v = yield* EvalValidator;
						yield* v.review({ ...data, feedback: data.feedback ?? undefined });
						return { ok: true as const, data: null };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const startRunFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeStartRun(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<{ runId: number }>> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const v = yield* EvalValidator;
						const r = yield* v.startRun(data);
						return { ok: true as const, data: r };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const listRunsFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeCohortId(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<readonly RunListItem[]>> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const v = yield* EvalValidator;
						const r = yield* v.listRuns(data.cohortId);
						return { ok: true as const, data: r };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const progressFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeRunId(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<RunProgress | null>> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const v = yield* EvalValidator;
						const r = yield* v.progress(data.runId);
						return { ok: true as const, data: r };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const deleteRunFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRunId(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<null>> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const v = yield* EvalValidator;
						yield* v.deleteRun(data.runId);
						return { ok: true as const, data: null };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);
