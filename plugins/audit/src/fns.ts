import { createServerFn } from "@tanstack/react-start";

import { getSessionUser, runAs } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Audit, type AuditVerifyResult } from "./index.ts";

// Audit plugin server functions: route/view modules under src/** reach
// the app runtime through @ktb/server-fns — no host imports. The
// /platform/audit "Verify chain" action calls auditVerifyFn; the
// PlatformAdmin gate re-runs inside Audit.adminVerify (defense in
// depth, same contract as the page guard).

/**
 * On-demand tamper-evident chain walk (T-139): platform admins only.
 * `null` for anonymous callers, non-admins (Forbidden → null, same
 * "not visible" contract as the other admin fns) and when the Audit
 * service is absent from the runtime.
 */
export const auditVerifyFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<AuditVerifyResult | null> => {
		const user = await getSessionUser();
		if (!user) return null;
		return runAs(
			user,
			Effect.gen(function* () {
				const audit = yield* Effect.serviceOption(Audit);
				if (Option.isNone(audit)) return null;
				return yield* audit.value
					.adminVerify()
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
			}),
		);
	},
);
