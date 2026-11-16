import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { DoctorProfiles, type DoctorProfile } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin } from "@ktb/platform";

import { PORTAL_AUDIENCE } from "./rules.ts";

export { PORTAL_AUDIENCE, instanceAudience, portalAdmits } from "./rules.ts";

/**
 * Portal audience port: which audience RULES the current principal
 * satisfies (rule ids in `PORTAL_AUDIENCE` — see ./rules.ts). The
 * portal route gate and the shell's instance switcher both read it —
 * it is a UX gate only (hard authorization stays inside domain
 * services, exactly like `panel.pages[].guard`).
 */
export class PortalAudience extends Context.Service<
	PortalAudience,
	{
		/** Audience rule ids the bound principal satisfies; empty for
		 * anonymous/system contexts (no `member`). */
		readonly audiences: () => Effect.Effect<ReadonlySet<string>>;
	}
>()("@ktb/portal/PortalAudience") {}

/**
 * Rule resolution, all lookups per call so the service never depends
 * on plugin load order: the admin gate and the doctor-profile
 * directory are optional services — a deployment without them simply
 * never grants their rules.
 *
 * Delegated requests bind `Principal.userId` to the DOCTOR and
 * `actorId` to the signed-in account, so profile lookups use
 * `actorId ?? userId` — audiences describe who is signed in, not who
 * they act as. `email` always describes the signed-in user, so the
 * admin allowlist check is delegation-proof.
 */
export const PortalAudienceLive = Layer.succeed(
	PortalAudience,
	PortalAudience.of({
		audiences: Effect.fn("PortalAudience.audiences")(function* () {
			const principal = yield* Principal;
			const out = new Set<string>();
			if (principal === null) return out;
			out.add(PORTAL_AUDIENCE.member);
			const platformAdmin = yield* Effect.serviceOption(PlatformAdmin);
			if (Option.isSome(platformAdmin) && (yield* platformAdmin.value.isAdmin(principal.email))) {
				out.add(PORTAL_AUDIENCE.platformAdmin);
			}
			const profiles = yield* Effect.serviceOption(DoctorProfiles);
			if (Option.isSome(profiles)) {
				const accountId = principal.actorId ?? principal.userId;
				const list = yield* profiles.value
					.listFor(accountId)
					.pipe(Effect.orElseSucceed(() => [] as readonly DoctorProfile[]));
				if (list.some((p) => p.role === "owner")) out.add(PORTAL_AUDIENCE.doctor);
				if (list.some((p) => p.role === "secretary")) out.add(PORTAL_AUDIENCE.secretary);
				if (out.has(PORTAL_AUDIENCE.doctor) || out.has(PORTAL_AUDIENCE.secretary)) {
					out.add(PORTAL_AUDIENCE.clinician);
				}
			}
			return out;
		}),
	}),
);

/** Portal infrastructure services — system plugin: disabling it would
 * break every portal gate and shell, so it can never be turned off. */
export const portalServicesPlugin = definePlugin({
	id: "portal.services",
	system: true,
	services: PortalAudienceLive,
});

/** Dependency anchor for portal chrome contributions (`portal.*`
 * regions) — orders them after the audience service like the retired
 * console.* entries ordered after `platform.panel`. */
export const portalShellPlugin = definePlugin({
	id: "portal.shell",
	system: true,
	requiredDeps: [portalServicesPlugin.id],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [portalServicesPlugin, portalShellPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"portal.services": true;
		"portal.shell": true;
	}
}
