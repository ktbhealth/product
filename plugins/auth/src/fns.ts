import { createServerFn } from "@tanstack/react-start";
import { Effect, Option } from "effect";

import { Email } from "@ktb/email";
import { PlatformAdmin } from "@ktb/platform";
import { getLocale, optionalSessionHandler, run } from "@ktb/server-fns";

/** Active UI locale for the current request — route loaders attach it
 * to their data so plugin views never import the host's i18n runtime. */
export const localeFn = createServerFn({ method: "GET" }).handler(() => getLocale());

/**
 * True when this deployment can send email (an Email driver other than
 * the disabled one is bound). The login view uses it to skip the
 * post-sign-up verification step when no message could ever arrive —
 * mirrors the host's emailEnabledFn, which plugins cannot import.
 */
export const emailEnabledFn = createServerFn({ method: "GET" }).handler(() =>
	run(Effect.map(Effect.service(Email), (sender) => sender !== null)),
);

/**
 * Whether the SESSION user satisfies the platform-admin gate (email
 * allowlist or RBAC admin grant) — the /login/admin post-sign-in check.
 * UX gate only: /platform and every admin service re-check
 * `PlatformAdmin` server-side. Anonymous → false; a deployment without
 * the gate service → false (fail closed).
 */
export const platformAdminAccessFn = createServerFn({ method: "GET" }).handler(
	optionalSessionHandler(
		() => false,
		async ({ user, run }) => {
			return run(
				Effect.gen(function* () {
					const platformAdmin = yield* Effect.serviceOption(PlatformAdmin);
					if (Option.isNone(platformAdmin)) return false;
					return yield* platformAdmin.value.isAdmin({
						email: user.email,
						userId: user.id,
					});
				}),
			);
		},
	),
);
