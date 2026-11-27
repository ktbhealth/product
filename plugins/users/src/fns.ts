import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { forbiddenTo, sessionHandler } from "@ktb/server-fns";

import { Users } from "./index.ts";

// Users admin server functions: the /platform/users console mutates
// through these — every call re-checks the PlatformAdmin gate inside the
// Users service (defense in depth on top of the layout guard).
// `Forbidden` collapses to `{ ok: false }` like the other admin fns.

const SetSuspendedInput = Schema.Struct({
	userId: Schema.NonEmptyString,
	suspended: Schema.Boolean,
});

const decodeSetSuspended = Schema.decodeUnknownSync(SetSuspendedInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

/**
 * Suspend or reactivate a user (T-034). Suspension bans sign-in at the
 * Auth port — sessions are revoked and `getSession` returns null until
 * reactivated.
 */
export const setUserSuspendedFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeSetSuspended(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<null>> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const users = yield* Users;
						yield* users.adminSetSuspended(data.userId, data.suspended);
						return { ok: true as const, data: null };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

const CreateUserInput = Schema.Struct({
	email: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	password: Schema.NonEmptyString,
});

const decodeCreateUser = Schema.decodeUnknownSync(CreateUserInput);

type CreateUserResult =
	| { readonly ok: true; readonly data: { readonly userId: string } }
	| {
			readonly ok: false;
			readonly error?: "exists" | "invalid_password";
	  };

/**
 * Create a user account from the /platform console (platform admins
 * only — the service re-checks the gate). Account-port rejections map
 * to `error` codes the form renders; a denied gate collapses to the
 * bare `{ ok: false }` like the other admin fns.
 */
export const createUserFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreateUser(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<CreateUserResult> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const users = yield* Users;
						const created = yield* users.adminCreate(data);
						if (!created.ok) return { ok: false as const, error: created.error };
						return { ok: true as const, data: { userId: created.userId } };
					}),
				).pipe(forbiddenTo({ ok: false as const } as CreateUserResult)),
			);
		}),
	);

const UpdateUserInput = Schema.Struct({
	userId: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	email: Schema.NonEmptyString,
});

const decodeUpdateUser = Schema.decodeUnknownSync(UpdateUserInput);

type UpdateUserResult =
	| { readonly ok: true; readonly data: null }
	| { readonly ok: false; readonly error?: "exists" };

/**
 * Update a user's name and sign-in email (platform admins only — the
 * service re-checks the gate). "exists" means the email is already
 * taken; a denied gate collapses to the bare `{ ok: false }`.
 */
export const updateUserFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdateUser(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<UpdateUserResult> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const users = yield* Users;
						const res = yield* users.adminUpdate(data.userId, {
							name: data.name,
							email: data.email,
						});
						if (!res.ok) return { ok: false as const, error: res.error };
						return { ok: true as const, data: null };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

const DeleteUserInput = Schema.Struct({
	userId: Schema.NonEmptyString,
});

const decodeDeleteUser = Schema.decodeUnknownSync(DeleteUserInput);

type DeleteUserResult =
	| { readonly ok: true; readonly data: null }
	| { readonly ok: false; readonly error?: "is_admin" };

/**
 * Permanently delete a user account (platform admins only — the
 * service re-checks the gate). Admin targets are refused with
 * "is_admin" so the console cannot delete itself; a denied gate
 * collapses to the bare `{ ok: false }`.
 */
export const deleteUserFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeDeleteUser(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<DeleteUserResult> => {
			return run(
				Effect.scoped(
					Effect.gen(function* () {
						const users = yield* Users;
						const res = yield* users.adminDelete(data.userId);
						if (!res.ok) return { ok: false as const, error: res.error };
						return { ok: true as const, data: null };
					}),
				).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);
