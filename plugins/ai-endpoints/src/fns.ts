import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureSessionUser, runAs } from "@ktb/server-fns";
import type { LlmEndpointPreset } from "@ktb/eval-consultation";

import { AiEndpoints, type EndpointCard, type EndpointInput } from "./index.ts";

// AI endpoint server fns: the /platform/ai/endpoints surface mutates
// through these. The service re-checks the eval.validator grant inside
// runAs; `Forbidden` collapses to `{ ok: false }` like the other
// admin fns. Wire inputs tolerate undefined/null keys the same way
// eval-validator's ReviewInput does.

const optStr = Schema.optional(Schema.Union([Schema.String, Schema.Null]));
const optNum = Schema.optional(Schema.Union([Schema.Number, Schema.Null]));

const IdInput = Schema.Struct({ id: Schema.Number });
const EndpointSaveInput = Schema.Struct({
	id: optNum,
	name: Schema.String,
	kind: Schema.Literals(["acp", "openai"]),
	baseUrl: Schema.String,
	model: optStr,
	sessionId: optStr,
	secretRef: optStr,
	transport: Schema.optional(Schema.Union([Schema.Literals(["ws", "child", "ssh"]), Schema.Null])),
	agentCmd: optStr,
	sshHost: optStr,
	scope: optStr,
	isDefault: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])),
	timeoutMs: optNum,
	enabled: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])),
});

const decodeId = Schema.decodeUnknownSync(IdInput);
const decodeEndpoint = Schema.decodeUnknownSync(EndpointSaveInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

const run = <A, E>(
	user: Awaited<ReturnType<typeof ensureSessionUser>>,
	eff: Effect.Effect<A, E, unknown>,
) => runAs(user, Effect.scoped(eff));

const endpointFrom = (d: Schema.Schema.Type<typeof EndpointSaveInput>): EndpointInput => ({
	name: d.name,
	kind: d.kind,
	baseUrl: d.baseUrl,
	...(d.model != null ? { model: d.model } : {}),
	...(d.sessionId != null ? { sessionId: d.sessionId } : {}),
	...(d.secretRef != null ? { secretRef: d.secretRef } : {}),
	...(d.transport != null ? { transport: d.transport } : {}),
	...(d.agentCmd != null ? { agentCmd: d.agentCmd } : {}),
	...(d.sshHost != null ? { sshHost: d.sshHost } : {}),
	...(d.scope != null ? { scope: d.scope } : {}),
	...(d.isDefault != null ? { isDefault: d.isDefault } : {}),
	...(d.timeoutMs != null ? { timeoutMs: d.timeoutMs } : {}),
	...(d.enabled != null ? { enabled: d.enabled } : {}),
});

export const listEndpointsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<Result<readonly EndpointCard[]>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				const data = yield* s.list();
				return { ok: true as const, data };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	},
);

export const listEndpointPresetsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<Result<readonly LlmEndpointPreset[]>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				const data = yield* s.presets();
				return { ok: true as const, data };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	},
);

export const saveEndpointFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeEndpoint(input))
	.handler(async ({ data }): Promise<Result<{ id: number }>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				const input = endpointFrom(data);
				const r =
					data.id != null
						? yield* s.update({ id: data.id, ...input }).pipe(Effect.map(() => ({ id: data.id! })))
						: yield* s.create(input);
				return { ok: true as const, data: r };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const deleteEndpointFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				yield* s.remove(data.id);
				return { ok: true as const, data: null };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const setPlatformDefaultEndpointFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				yield* s.setPlatformDefault(data.id);
				return { ok: true as const, data: null };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const testEndpointFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<{ message?: string }>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				yield* s.test(data.id);
				return { ok: true as const, data: {} };
			}).pipe(
				Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
				Effect.catch((e) =>
					Effect.succeed({
						ok: false as const,
						data: {
							message:
								typeof e === "object" && e !== null && "message" in e
									? String((e as { message: unknown }).message)
									: String(e),
						},
					}),
				),
			),
		);
	});
