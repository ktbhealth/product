import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Request-scoped principal — who the current effect runs as.
 *
 * Bound per request by the composition root (`runAs` in @ktb/app-host).
 * The default `null` marks a system context (webhooks, bot channels,
 * background jobs): services that need a user MUST treat null as
 * unauthenticated and fail `Forbidden`; system-only methods (bot-token
 * paths verified out-of-band) deliberately do not consult it.
 *
 * `email` is the session email when the caller has one — env-allowlist
 * gates (e.g. @ktb/platform `PlatformAdmin.requireAdmin`) check it
 * against the bound principal rather than a caller-supplied argument.
 *
 * `actorId` is the signed-in user when it differs from `userId` — a
 * secretary acting on a doctor's behalf: authorization and data scope
 * follow `userId` (the doctor), audit trails record `actorId`. Absent
 * means the principal acts for themselves.
 */
export const Principal = Context.Reference<{
	readonly userId: string;
	readonly email?: string;
	readonly actorId?: string;
} | null>("@ktb/authz/Principal", { defaultValue: () => null });

export class Forbidden extends Data.TaggedError("Forbidden")<{
	readonly path: string;
}> {}

/**
 * Assert the bound principal exists and acts as `userId` — guards
 * parameters that name an owner directly (create/list calls where the
 * permission layer has no entity to check). `path` is reported in the
 * `Forbidden` error.
 */
export const requirePrincipalUser = (userId: string, path = "principal") =>
	Effect.flatMap(Principal, (principal) =>
		principal !== null && principal.userId === userId
			? Effect.void
			: Effect.fail(new Forbidden({ path })),
	);
