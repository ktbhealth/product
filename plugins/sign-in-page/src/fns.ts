import { createServerFn } from "@tanstack/react-start";
import { Effect, Option } from "effect";

import { PortalAudience } from "@ktb/portal";
import { optionalSessionHandler } from "@ktb/server-fns";

/**
 * Audience rule ids the session user satisfies — the patient sign-in
 * page's post-login funnel reads it to decide between /portal and the
 * doctor/secretary funnel. Mirrors the host's `portalAudiencesFn`
 * (apps/web/src/lib/fns.ts), which plugins cannot import: anonymous
 * callers get an empty list; sorted for stable wire output.
 */
export const portalAudiencesFn = createServerFn({ method: "GET" }).handler(
	optionalSessionHandler(
		() => [],
		async ({ run }): Promise<readonly string[]> => {
			return run(
				Effect.gen(function* () {
					const audience = yield* Effect.serviceOption(PortalAudience);
					if (Option.isNone(audience)) return [] as string[];
					return [...(yield* audience.value.audiences())].sort();
				}),
			);
		},
	),
);
