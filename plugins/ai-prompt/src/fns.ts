import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { optionalSessionHandler, sessionHandler } from "@ktb/server-fns";

import { AiPrompts, type PromptCard, type PromptVariable } from "./prompts.ts";

// AI prompt registry server functions (P-098 WS-C): platform-scope
// CRUD over versioned prompt rows. Every fn calls the AiPrompts
// service, which enforces PlatformAdmin for platform scope — denials
// collapse to `{ ok: false }` / `[]` like the other admin surfaces.

const PromptVariableSchema = Schema.Struct({
	name: Schema.NonEmptyString,
	required: Schema.optionalKey(Schema.Boolean),
	description: Schema.optionalKey(Schema.String),
});
const Variables = Schema.optionalKey(Schema.Array(PromptVariableSchema));

const CreateInput = Schema.Struct({
	name: Schema.NonEmptyString,
	template: Schema.NonEmptyString,
	version: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	locale: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	variables: Variables,
	modelHint: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	isSystem: Schema.optionalKey(Schema.Boolean),
	isDefault: Schema.optionalKey(Schema.Boolean),
});
const UpdateInput = Schema.Struct({
	id: Schema.Number,
	template: Schema.optionalKey(Schema.NonEmptyString),
	variables: Variables,
	modelHint: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	isSystem: Schema.optionalKey(Schema.Boolean),
	isDefault: Schema.optionalKey(Schema.Boolean),
	enabled: Schema.optionalKey(Schema.Boolean),
});
const IdInput = Schema.Struct({ id: Schema.Number });
const ListInput = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
});

const decodeCreate = Schema.decodeUnknownSync(CreateInput);
const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);
const decodeId = Schema.decodeUnknownSync(IdInput);
const decodeList = Schema.decodeUnknownSync(ListInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

const denyToFalse = <A>(fallback: A) =>
	Effect.catchTags({
		PromptError: () => Effect.succeed(fallback),
		/* v8 ignore next -- platform-scope fns never reach the tenant gate */
		TenantForbidden: () => Effect.succeed(fallback),
		Forbidden: () => Effect.succeed(fallback),
	});

const toVariables = (
	vars: readonly { name: string; required?: boolean; description?: string }[] | undefined,
): readonly PromptVariable[] | undefined => vars;

/** Platform prompt list — admin-only; denials degrade to []. */
export const promptsListFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeList(input ?? {}))
	.handler(
		optionalSessionHandler(
			({ data }) => [],
			async ({ data, run }): Promise<readonly PromptCard[]> => {
				return run(
					Effect.gen(function* () {
						const prompts = yield* AiPrompts;
						return yield* prompts
							.list({
								scope: "platform",
								...(data.name !== undefined && data.name !== "" ? { name: data.name } : {}),
							})
							.pipe(denyToFalse([] as PromptCard[]));
					}),
				);
			},
		),
	);

export const promptsCreateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<PromptCard>> => {
			return run(
				Effect.gen(function* () {
					const prompts = yield* AiPrompts;
					return yield* prompts
						.create({
							scope: "platform",
							name: data.name,
							template: data.template,
							...(data.version !== undefined && data.version !== null
								? { version: data.version }
								: {}),
							...(data.locale !== undefined && data.locale !== null ? { locale: data.locale } : {}),
							...(toVariables(data.variables) !== undefined
								? { variables: toVariables(data.variables) }
								: {}),
							...(data.modelHint !== undefined && data.modelHint !== null
								? { modelHint: data.modelHint }
								: {}),
							...(data.isSystem !== undefined ? { isSystem: data.isSystem } : {}),
							...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
						})
						.pipe(
							Effect.map((card) => ({ ok: true as const, data: card })),
							denyToFalse({ ok: false as const }),
						);
				}),
			);
		}),
	);

export const promptsUpdateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<PromptCard>> => {
			return run(
				Effect.gen(function* () {
					const prompts = yield* AiPrompts;
					return yield* prompts
						.update({
							id: data.id,
							...(data.template !== undefined ? { template: data.template } : {}),
							...(toVariables(data.variables) !== undefined
								? { variables: toVariables(data.variables) }
								: {}),
							...(data.modelHint !== undefined ? { modelHint: data.modelHint } : {}),
							...(data.isSystem !== undefined ? { isSystem: data.isSystem } : {}),
							...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
							...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
						})
						.pipe(
							Effect.map((card) => ({ ok: true as const, data: card })),
							denyToFalse({ ok: false as const }),
						);
				}),
			);
		}),
	);

export const promptsRemoveFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<null>> => {
			return run(
				Effect.gen(function* () {
					const prompts = yield* AiPrompts;
					return yield* prompts.remove(data.id).pipe(
						Effect.map(() => ({ ok: true as const, data: null })),
						denyToFalse({ ok: false as const }),
					);
				}),
			);
		}),
	);
