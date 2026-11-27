import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureSessionUser, forbiddenTo, runAs, sessionHandler } from "@ktb/server-fns";

import { Credentials, type CredentialCard } from "./index.ts";

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
	sessionHandler(async ({ user }): Promise<Result<readonly CredentialCard[]>> => {
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* Credentials;
				const data = yield* s.list();
				return { ok: true as const, data };
			}).pipe(forbiddenTo({ ok: false as const })),
		);
	}),
);

export const createCredentialFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(
		sessionHandler(async ({ data, user }): Promise<Result<{ readonly id: string }>> => {
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* Credentials;
					const r = yield* s.create(data);
					return { ok: true as const, data: r };
				}).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const removeCredentialFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		sessionHandler(async ({ data, user }): Promise<Result<null>> => {
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* Credentials;
					yield* s.remove(data.id);
					return { ok: true as const, data: null };
				}).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);
