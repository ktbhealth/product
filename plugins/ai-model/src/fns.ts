import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { ensureSessionUser, getSessionUser, runAs } from "@ktb/server-fns";

import { AiModels, type ModelCard } from "./models.ts";
import type { AiModelKind } from "./schema.ts";

// AI model catalog server functions (P-098 WS-B): platform-scope CRUD.
// Every fn calls the AiModels service, which enforces PlatformAdmin for
// platform scope — denials collapse to `{ ok: false }` / `[]` like the
// other admin surfaces.

const ModelKindSchema = Schema.Literals([
	"chat",
	"vision",
	"asr",
	"tts",
	"judge",
	"embed",
	"other",
]);
const Capabilities = Schema.optionalKey(Schema.Array(Schema.NonEmptyString));

const CreateInput = Schema.Struct({
	name: Schema.NonEmptyString,
	modelId: Schema.NonEmptyString,
	endpointId: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	kind: Schema.optionalKey(ModelKindSchema),
	capabilities: Capabilities,
	contextTokens: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	costTier: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	isDefault: Schema.optionalKey(Schema.Boolean),
});
const UpdateInput = Schema.Struct({
	id: Schema.Number,
	name: Schema.optionalKey(Schema.NonEmptyString),
	modelId: Schema.optionalKey(Schema.NonEmptyString),
	endpointId: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	kind: Schema.optionalKey(ModelKindSchema),
	capabilities: Capabilities,
	contextTokens: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	costTier: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	isDefault: Schema.optionalKey(Schema.Boolean),
	enabled: Schema.optionalKey(Schema.Boolean),
});
const IdInput = Schema.Struct({ id: Schema.Number });

const decodeCreate = Schema.decodeUnknownSync(CreateInput);
const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);
const decodeId = Schema.decodeUnknownSync(IdInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

/** Denials collapse to `{ ok: false }` / empty list — same convention
 * as the vault/machines fns; unexpected errors still propagate. */
const denyToFalse = <A>(fallback: A) =>
	Effect.catchTags({
		ModelError: () => Effect.succeed(fallback),
		/* v8 ignore next -- platform-scope fns never reach the tenant gate */
		TenantForbidden: () => Effect.succeed(fallback),
		Forbidden: () => Effect.succeed(fallback),
	});

const toCreateInput = (data: typeof CreateInput.Type) => ({
	scope: "platform" as const,
	name: data.name,
	modelId: data.modelId,
	...(data.endpointId !== undefined ? { endpointId: data.endpointId } : {}),
	...(data.kind !== undefined ? { kind: data.kind as AiModelKind } : {}),
	...(data.capabilities !== undefined ? { capabilities: data.capabilities } : {}),
	...(data.contextTokens !== undefined ? { contextTokens: data.contextTokens } : {}),
	...(data.costTier !== undefined ? { costTier: data.costTier } : {}),
	...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
});

/** Platform model list — admin-only; denials degrade to []. */
export const modelsListFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly ModelCard[]> => {
		const user = await getSessionUser();
		if (!user) return [];
		return runAs(
			user,
			Effect.gen(function* () {
				const models = yield* AiModels;
				return yield* models.list({ scope: "platform" }).pipe(denyToFalse([] as ModelCard[]));
			}),
		);
	},
);

export const modelsCreateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(async ({ data }): Promise<Result<ModelCard>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const models = yield* AiModels;
				return yield* models.create(toCreateInput(data)).pipe(
					Effect.map((card) => ({ ok: true as const, data: card })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

export const modelsUpdateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(async ({ data }): Promise<Result<ModelCard>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const models = yield* AiModels;
				return yield* models
					.update({
						id: data.id,
						...(data.name !== undefined ? { name: data.name } : {}),
						...(data.modelId !== undefined ? { modelId: data.modelId } : {}),
						...(data.endpointId !== undefined ? { endpointId: data.endpointId } : {}),
						...(data.kind !== undefined ? { kind: data.kind as AiModelKind } : {}),
						...(data.capabilities !== undefined ? { capabilities: data.capabilities } : {}),
						...(data.contextTokens !== undefined ? { contextTokens: data.contextTokens } : {}),
						...(data.costTier !== undefined ? { costTier: data.costTier } : {}),
						...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
						...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
					})
					.pipe(
						Effect.map((card) => ({ ok: true as const, data: card })),
						denyToFalse({ ok: false as const }),
					);
			}),
		);
	});

export const modelsRemoveFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const models = yield* AiModels;
				return yield* models.remove(data.id).pipe(
					Effect.map(() => ({ ok: true as const, data: null })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});
