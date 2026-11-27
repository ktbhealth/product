import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Forbidden, Principal } from "@ktb/authz";
import { definePlugin, type PanelPage, type Plugin } from "@ktb/kernel";
import {
	eventTopicContribution,
	jobKindContribution,
	schedulableContribution,
} from "./capabilities.ts";

const normalizeEmail = (email: string | null | undefined): string =>
	(email ?? "").trim().toLowerCase();

/**
 * Parse `PLATFORM_ADMIN_EMAILS` (comma-separated) into a normalized
 * lookup set. Empty/unset input yields an empty set — the gate then
 * denies everyone (fail closed).
 */
export const parsePlatformAdminEmails = (raw: string | null | undefined): ReadonlySet<string> => {
	const emails = new Set<string>();
	for (const part of (raw ?? "").split(",")) {
		const email = normalizeEmail(part);
		if (email) emails.add(email);
	}
	return emails;
};

export interface PlatformAdminShape {
	/**
	 * Admin check. Accepts a bare email (legacy callers) or a subject
	 * `{ email, userId }` — `userId` is the SIGNED-IN account id (not a
	 * delegated acting id), which is what RBAC grant lookups key on.
	 */
	readonly isAdmin: (
		subject: string | PlatformAdminSubject | null | undefined,
	) => Effect.Effect<boolean>;
	/**
	 * Defense-in-depth check bound to the request `Principal`: fails
	 * `Forbidden` unless the principal is admin — email allowlisted or
	 * holding an admin grant. Domain services call this directly so
	 * admin paths stay closed even when reached without the route guard.
	 */
	readonly requireAdmin: () => Effect.Effect<void, Forbidden>;
}

/** Who `isAdmin` evaluates: the session email plus the account id
 * dynamic grants resolve against. */
export interface PlatformAdminSubject {
	readonly email?: string | null;
	readonly userId?: string | null;
}

/**
 * Platform admin gate (P-026 env-allowlist approach). Provided by the
 * composition root (`createApp` in @ktb/app-host) from
 * `PLATFORM_ADMIN_EMAILS` — it is host-composed config, not a plugin
 * layer, so `platform.admin` below is a marker plugin that exists for
 * `requiredDeps` ordering and the `PluginRegistry` id.
 */
export class PlatformAdmin extends Context.Service<PlatformAdmin, PlatformAdminShape>()(
	"@ktb/platform/PlatformAdmin",
) {}

const normalizeSubject = (
	subject: string | PlatformAdminSubject | null | undefined,
): PlatformAdminSubject => (typeof subject === "string" ? { email: subject } : (subject ?? {}));

/** Build the gate from a parsed allowlist. `opts.grantFor` is the
 * optional dynamic-grant hook (RBAC `platform.admin` allow): the
 * composition root wires it to the permissions resolver so role-based
 * superadmins pass the same gate as allowlisted emails. Absent →
 * email allowlist only, exactly the P-026 behaviour. */
export const makePlatformAdminGate = (
	emails: ReadonlySet<string>,
	opts?: {
		readonly grantFor?: (userId: string) => Effect.Effect<boolean>;
	},
): PlatformAdminShape => {
	const admits = (subject: PlatformAdminSubject): Effect.Effect<boolean> =>
		emails.has(normalizeEmail(subject.email))
			? Effect.succeed(true)
			: subject.userId != null && opts?.grantFor !== undefined
				? opts.grantFor(subject.userId)
				: Effect.succeed(false);
	return {
		isAdmin: (subject) => admits(normalizeSubject(subject)),
		requireAdmin: () =>
			Effect.flatMap(Principal, (principal) =>
				principal === null
					? Effect.fail(new Forbidden({ path: "platform.admin" }))
					: admits({
							email: principal.email,
							// Grants belong to the signed-in account — under a
							// delegated principal userId is the ACTING doctor.
							userId: principal.actorId ?? principal.userId,
						}).pipe(
							Effect.flatMap((ok) =>
								ok ? Effect.void : Effect.fail(new Forbidden({ path: "platform.admin" })),
							),
						),
			),
	};
};

/** Boolean form of `PlatformAdminShape.requireAdmin` for callers that
 * already hold the gate shape (CQRS checks, composite page guards):
 * `true` when the bound principal is admin, `false` on `Forbidden` —
 * never fails. */
export const platformAdminAdmits = (admin: PlatformAdminShape): Effect.Effect<boolean> =>
	admin.requireAdmin().pipe(
		Effect.as(true),
		Effect.catchTag("Forbidden", () => Effect.succeed(false)),
	);

/** Page `guard` shared by every /platform console page: resolves the
 * `PlatformAdmin` service and applies `platformAdminAdmits` — `false`
 * makes the host render not-found, the same hard-404 contract the
 * /platform gate produces. Assign directly (`guard: platformAdminGuard`)
 * or via `adminConsolePage`; the request path is ignored. */
export const platformAdminGuard = (
	_path?: string,
): Effect.Effect<boolean, never, PlatformAdmin> =>
	Effect.gen(function* () {
		const platformAdmin = yield* PlatformAdmin;
		return yield* platformAdminAdmits(platformAdmin);
	});

/** `panel.pages` descriptor factory: spreads the page fields and
 * defaults `guard` to `platformAdminGuard` — the hard-404 admin gate
 * every console page shares. Generic over the page literal so `loader`
 * keeps its precise signature; the returned `guard` is the concrete
 * zero-arg `platformAdminGuard` type. Pass `guard` explicitly (second
 * overload) for permission-scoped or composite gates (wildcard path
 * resolution, rbac-OR-admin checks); pages intentionally relying on the
 * host's /platform gate alone should stay plain object literals. */
export function adminConsolePage<
	P extends Omit<PanelPage, "guard">,
>(page: P): P & {
	readonly guard: (_path?: string) => Effect.Effect<boolean, never, PlatformAdmin>;
};
export function adminConsolePage(page: PanelPage): PanelPage;
export function adminConsolePage(
	page: Omit<PanelPage, "guard"> & { readonly guard?: PanelPage["guard"] },
): PanelPage {
	return { ...page, guard: page.guard ?? platformAdminGuard };
}

/** Marker plugin for the env-composed admin gate — see PlatformAdmin. */
export const platformAdminPlugin = definePlugin({
	id: "platform.admin",
	meta: { keywords: ["platform", "admin", "marker"] },
	system: true,
});

// Dep anchor for the console route surface. The /platform* subtree used
// to be a physical mount (platform.tsx layout + routes/platform/
// dispatchers); the route collapse moved console dispatch into the
// host's root `/$` splat, so this plugin now only orders dependents —
// feature plugins still contribute console pages via `panel.pages`
// descriptors plus `portal.sidebar` chrome entries.
export const platformRoutesPlugin = definePlugin({
	id: "platform.routes",
	meta: { keywords: ["platform", "routes"] },
	system: true,
});

export const platformPanelPlugin = definePlugin({
	id: "platform.panel",
	meta: { keywords: ["platform", "marker"] },
	system: true,
	requiredDeps: [platformRoutesPlugin.id],
	// No sidebar entry of its own — the dashboard plugin owns the
	// /platform landing item; this plugin is the dep anchor other
	// panel plugins order after.
});

/** The platform admin console as a portal instance (P-081): /platform
 * is the default portal — `portal`-less chrome contributions render
 * here. System plugin: the console is host infrastructure. */
export const platformPortalPlugin = definePlugin({
	id: "platform.portal",
	meta: { keywords: ["platform", "shell"] },
	system: true,
	requiredDeps: [platformPanelPlugin.id],
	portals: [
		{
			id: "platform",
			basePath: "/platform",
			label: "Platform",
			audience: "platform-admin",
		},
	],
});

/** Marker plugin anchoring the host-owned work-orchestration kinds
 * (P-094): `jobs.ping` is registered by the composition root, and
 * `cron.fires` is published by the cron run projection — both are
 * host infrastructure, so their capability declarations live here.
 * `jobs.ping.smoke` is the reference `jobs.schedulable` entry: it
 * makes the scheduler→queue→consumer path exercisable end-to-end
 * from /platform/cron without touching a domain plugin. */
export const platformJobsPlugin = definePlugin({
	id: "platform.jobs",
	meta: { keywords: ["platform", "jobs", "marker"] },
	system: true,
	contributions: [
		jobKindContribution("jobs.ping", {
			description:
				"Smoke-test job — no-op handler registered by the composition root on every jobs transport.",
		}),
		schedulableContribution("jobs.ping.smoke", {
			kind: "jobs.ping",
			description: "Ping sweep — verifies heartbeat/DO → queue → consumer → job_runs end to end.",
			paramsSchema: { type: "object" },
			suggestedCronExpr: "0 * * * *",
			suggestedParams: {},
		}),
		eventTopicContribution("cron.fires", {
			description:
				"Published by the cron run projection on every static-cron and scheduled-job fire.",
			payloadSchema: {
				type: "object",
				properties: {
					jobId: { type: "string" },
					ok: { type: "boolean" },
					summary: { type: ["string", "null"] },
				},
				required: ["jobId", "ok"],
			},
		}),
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	platformAdminPlugin,
	platformRoutesPlugin,
	platformPanelPlugin,
	platformPortalPlugin,
	platformJobsPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"platform.admin": true;
		"platform.routes": true;
		"platform.panel": true;
		"platform.portal": true;
		"platform.jobs": true;
	}
}
