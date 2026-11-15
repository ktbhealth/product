import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { getLocale, run } from "@ktb/server-fns";

import { Invites, type InviteErrorCode, type InviteKind } from "./index.ts";

// Invites plugin server functions: the route modules under src/routes/**
// are owned by this package and reach the app runtime through
// @ktb/server-fns — no host imports. Both are public on purpose: the
// caller is whoever holds the link, and the token is the credential.

const decodeToken = Schema.decodeUnknownSync(Schema.String);
const decodeAccept = Schema.decodeUnknownSync(
	Schema.Struct({ token: Schema.String, name: Schema.String, password: Schema.String }),
);

/** Active UI locale for the current request — route loaders attach it
 * to their data so plugin views never import the host's i18n runtime. */
export const localeFn = createServerFn({ method: "GET" }).handler(() => getLocale());

/**
 * What an accept link opens — null for an unknown, used or expired one.
 * A POST although it only reads: a GET server fn carries its input in
 * the query string, and the token should not sit in request URLs.
 */
export const invitePreviewFn = createServerFn({ method: "POST" })
	.validator((token: unknown) => decodeToken(token))
	.handler(({ data: token }) =>
		run(
			Effect.gen(function* () {
				const invites = yield* Invites;
				return yield* invites.preview(token);
			}),
		),
	);

export type AcceptInviteResult =
	| { readonly ok: true; readonly email: string; readonly kind: InviteKind }
	| { readonly ok: false; readonly error: InviteErrorCode };

/**
 * Create the invitee's account from an accept link. Does not sign in:
 * the page signs in right after, with the password the person just
 * chose, through the regular (bot-checked) credential endpoint.
 */
export const acceptInviteFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeAccept(input))
	.handler(({ data }): Promise<AcceptInviteResult> =>
		run(
			Effect.gen(function* () {
				const invites = yield* Invites;
				const accepted = yield* invites.accept(data);
				return { ok: true as const, ...accepted };
			}).pipe(
				Effect.catchTag("InviteRejected", (e) =>
					Effect.succeed({ ok: false as const, error: e.code }),
				),
			),
		),
	);
