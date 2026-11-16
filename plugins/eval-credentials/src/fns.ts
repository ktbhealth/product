import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureSessionUser, runAs } from "@ktb/server-fns";

import { EvalCredentials, type CredentialCard } from "./index.ts";

const CreateInput = Schema.Struct({
	name: Schema.String,
	provider: Schema.String,
	secret: Schema.String,
});
const IdInput = Schema.Struct({ id: Schema.String });

const decodeCreate = Schema.decodeUnknownSync(CreateInput);
const decodeId = Schema.decodeUnknownSync(IdInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

const run = <A, E>(
	user: Awaited<ReturnType<typeof ensureSessionUser>>,
	eff: Effect.Effect<A, E, unknown>,
) => runAs(user, Effect.scoped(eff));

export const listCredentialsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<Result<readonly CredentialCard[]>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* EvalCredentials;
				const data = yield* s.list();
				return { ok: true as const, data };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	},
);

export const createCredentialFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(async ({ data }): Promise<Result<{ readonly id: string }>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* EvalCredentials;
				const r = yield* s.create(data);
				return { ok: true as const, data: r };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const removeCredentialFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* EvalCredentials;
				yield* s.remove(data.id);
				return { ok: true as const, data: null };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});
