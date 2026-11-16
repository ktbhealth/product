import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureSessionUser, runAs } from "@ktb/server-fns";

import { EvalValidator, type BatchSummary, type PersonaCard, type RunProgress } from "./index.ts";

// Eval validator server functions (P-081): the /platform/eval surface
// mutates through these. The service re-checks the eval.validator
// grant inside runAs; `Forbidden` collapses to `{ ok: false }` like
// the other admin fns.

const GenerateInput = Schema.Struct({
	count: Schema.Number,
	seed: Schema.optional(Schema.Number),
	// Target interview length — the script generator scales the beat
	// list to ~4 turns/minute; absent keeps the full anamnesis.
	minutes: Schema.optional(Schema.Number),
});
const BatchIdInput = Schema.Struct({ batchId: Schema.Number });
const ReviewInput = Schema.Struct({
	personaId: Schema.Number,
	decision: Schema.Literals(["approved", "rejected"]),
	// The client sends `feedback: undefined` when the textarea is
	// empty — the serializer keeps the key, so this must tolerate
	// undefined/null on the wire.
	feedback: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});
const RunIdInput = Schema.Struct({ runId: Schema.Number });

const decodeGenerate = Schema.decodeUnknownSync(GenerateInput);
const decodeBatchId = Schema.decodeUnknownSync(BatchIdInput);
const decodeReview = Schema.decodeUnknownSync(ReviewInput);
const decodeRunId = Schema.decodeUnknownSync(RunIdInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

export const generateBatchFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeGenerate(input))
	.handler(async ({ data }): Promise<Result<{ batchId: number }>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const v = yield* EvalValidator;
					const r = yield* v.generate(data);
					return { ok: true as const, data: r };
				}),
			).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const listBatchesFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => input)
	.handler(async (): Promise<Result<readonly BatchSummary[]>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const v = yield* EvalValidator;
					const r = yield* v.listBatches();
					return { ok: true as const, data: r };
				}),
			).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const listPersonasFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeBatchId(input))
	.handler(async ({ data }): Promise<Result<readonly PersonaCard[]>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const v = yield* EvalValidator;
					const r = yield* v.listPersonas(data.batchId);
					return { ok: true as const, data: r };
				}),
			).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const reviewPersonaFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeReview(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const v = yield* EvalValidator;
					yield* v.review({ ...data, feedback: data.feedback ?? undefined });
					return { ok: true as const, data: null };
				}),
			).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const startRunFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeBatchId(input))
	.handler(async ({ data }): Promise<Result<{ runId: number }>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const v = yield* EvalValidator;
					const r = yield* v.startRun(data.batchId);
					return { ok: true as const, data: r };
				}),
			).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const progressFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeRunId(input))
	.handler(async ({ data }): Promise<Result<RunProgress | null>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const v = yield* EvalValidator;
					const r = yield* v.progress(data.runId);
					return { ok: true as const, data: r };
				}),
			).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const deleteRunFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRunId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.scoped(
				Effect.gen(function* () {
					const v = yield* EvalValidator;
					yield* v.deleteRun(data.runId);
					return { ok: true as const, data: null };
				}),
			).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});
