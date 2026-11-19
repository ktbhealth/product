import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { count, desc, eq } from "drizzle-orm";
import { UserCogIcon } from "lucide-react";

import { Accounts, Auth } from "@ktb/auth";
import { audit, auditServicesPlugin } from "@ktb/audit";
import { Db, type DbClient } from "@ktb/db";
import { consultations, doctors, patients, user as users } from "@ktb/db/schema";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import type { Forbidden } from "@ktb/authz";
import { Query } from "@effect-server-utils/cqrs";
import { UsersQueries } from "./api.ts";
import { UsersPlatformPage } from "./platform-page.tsx";

/** Repo-level user row: auth user fields plus aggregate counts. */
export type UserRow = typeof users.$inferSelect & {
	readonly patientCount: number;
	readonly consultationCount: number;
};

/** Console row: repo row plus the platform-admin flag resolved by the
 * gate. `banned` (from the auth-owned user table) is the suspension
 * flag — the console labels it "suspended". */
export interface AdminUserRow extends UserRow {
	readonly isAdmin: boolean;
}

/**
 * Cross-owner user listing for the /platform console. Callers MUST have
 * passed the `PlatformAdmin` gate first — this repo function itself is
 * unauthenticated, like the other `*Users` helpers.
 */
export async function listAllUsers(db: DbClient): Promise<UserRow[]> {
	const [rows, patientCounts, consultationCounts] = await Promise.all([
		// Left join doctors: synthetic backing users (eval validator
		// cohorts) are plumbing, not accounts — excluded from the
		// console listing entirely.
		db
			.select({ user: users, synthetic: doctors.synthetic })
			.from(users)
			.leftJoin(doctors, eq(doctors.userId, users.id))
			.orderBy(desc(users.createdAt))
			.then((joined) => joined.filter((r) => r.synthetic !== true).map((r) => r.user)),
		db.select({ ownerId: patients.ownerId, n: count() }).from(patients).groupBy(patients.ownerId),
		db
			.select({ userId: consultations.userId, n: count() })
			.from(consultations)
			.groupBy(consultations.userId),
	]);
	const patientsByOwner = new Map(patientCounts.map((r) => [r.ownerId, r.n]));
	const consultationsByUser = new Map(consultationCounts.map((r) => [r.userId, r.n]));
	return rows.map((u) => ({
		...u,
		patientCount: patientsByOwner.get(u.id) ?? 0,
		consultationCount: consultationsByUser.get(u.id) ?? 0,
	}));
}

/**
 * Users domain port — Effect service, swappable in tests. Today it only
 * exposes the admin-console listing; the `user` table itself is owned by
 * @ktb/auth (better-auth), so this plugin contributes no tables.
 */
export class Users extends Context.Service<
	Users,
	{
		/** Cross-owner listing for the /platform console — platform admins only. */
		readonly adminList: () => Effect.Effect<AdminUserRow[], Forbidden>;
		/**
		 * Suspend (`true`) or reactivate (`false`) a user's sign-in —
		 * platform admins only. Delegates to the Auth port, which revokes
		 * sessions on ban and makes `getSession` return null.
		 */
		readonly adminSetSuspended: (
			userId: string,
			suspended: boolean,
		) => Effect.Effect<void, Forbidden>;
		/**
		 * Create a credential account — platform admins only. The account
		 * starts email-verified (the admin vouches for the address) with
		 * the admin-chosen password; port rejections surface as
		 * "exists"/"invalid_password" for the form to render.
		 */
		readonly adminCreate: (input: {
			readonly email: string;
			readonly name: string;
			readonly password: string;
		}) => Effect.Effect<
			| { readonly ok: true; readonly userId: string }
			| { readonly ok: false; readonly error: "exists" | "invalid_password" },
			Forbidden
		>;
		/**
		 * Update a user's name/sign-in email — platform admins only.
		 * Delegates to the Auth port; "exists" means another account
		 * already holds the email.
		 */
		readonly adminUpdate: (
			userId: string,
			input: { readonly name: string; readonly email: string },
		) => Effect.Effect<
			{ readonly ok: true } | { readonly ok: false; readonly error: "exists" },
			Forbidden
		>;
		/**
		 * Permanently delete a user account — platform admins only.
		 * Refuses targets that currently hold the admin gate ("is_admin")
		 * so the console cannot lock itself out; deletes are otherwise
		 * idempotent (a missing user is a no-op success).
		 */
		readonly adminDelete: (
			userId: string,
		) => Effect.Effect<
			{ readonly ok: true } | { readonly ok: false; readonly error: "is_admin" },
			Forbidden
		>;
	}
>()("@ktb/users/Users") {}

export const UsersLive = Layer.effect(
	Users,
	Effect.gen(function* () {
		const db = yield* Db;
		const auth = yield* Auth;
		const accounts = yield* Accounts;
		const platformAdmin = yield* PlatformAdmin;
		return Users.of({
			adminList: Effect.fn("Users.adminList")(function* () {
				// Platform gate first — fails Forbidden for non-admins and
				// for system contexts (null principal) alike.
				yield* platformAdmin.requireAdmin();
				const rows = yield* Effect.promise(() => listAllUsers(db));
				return yield* Effect.forEach(rows, (row) =>
					Effect.map(platformAdmin.isAdmin({ email: row.email, userId: row.id }), (isAdmin) => ({
						...row,
						isAdmin,
					})),
				);
			}),
			adminSetSuspended: Effect.fn("Users.adminSetSuspended")(function* (userId, suspended) {
				// Same platform gate as adminList — suspension is a
				// cross-owner, platform-level action.
				yield* platformAdmin.requireAdmin();
				yield* Effect.promise(() => auth.setUserBanned(userId, suspended));
				// T-037: audit the admin action — record() never fails.
				yield* audit({
					action: suspended ? "users.suspend" : "users.reactivate",
					targetType: "user",
					targetId: userId,
				});
			}),
			adminCreate: Effect.fn("Users.adminCreate")(function* (input) {
				// Same platform gate as adminList — account creation is a
				// cross-owner, platform-level action.
				yield* platformAdmin.requireAdmin();
				const created = yield* Effect.promise(() => accounts.createVerified(input));
				if (!created.ok) return { ok: false as const, error: created.error };
				// T-037: ids only — the password never reaches the log.
				yield* audit({
					action: "users.create",
					targetType: "user",
					targetId: created.userId,
				});
				return { ok: true as const, userId: created.userId };
			}),
			adminUpdate: Effect.fn("Users.adminUpdate")(function* (userId, input) {
				// Same platform gate as adminList — profile edits are a
				// cross-owner, platform-level action.
				yield* platformAdmin.requireAdmin();
				const result = yield* Effect.promise(() => auth.updateUser(userId, input));
				if (!result.ok) return { ok: false as const, error: result.error };
				// T-037: ids only — the new email never reaches the log.
				yield* audit({
					action: "users.update",
					targetType: "user",
					targetId: userId,
				});
				return { ok: true as const };
			}),
			adminDelete: Effect.fn("Users.adminDelete")(function* (userId) {
				yield* platformAdmin.requireAdmin();
				// Admin targets are undeletable here: removing the last
				// admin (or your own account mid-session) would strand
				// the console. The gate check needs the target's email,
				// so look the row up first — a missing row skips the
				// check and the port delete no-ops.
				const rows = yield* Effect.promise(() =>
					db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1),
				);
				const target = rows[0];
				if (
					target !== undefined &&
					(yield* platformAdmin.isAdmin({ email: target.email, userId }))
				) {
					return { ok: false as const, error: "is_admin" as const };
				}
				yield* Effect.promise(() => auth.deleteUser(userId));
				yield* audit({
					action: "users.delete",
					targetType: "user",
					targetId: userId,
				});
				return { ok: true as const };
			}),
		});
	}),
);

/** Cross-plugin query surface — raw user lookup for other plugins. */
export const UsersQueriesLive = Query.handlersOf(UsersQueries, {
	"users.get": ({ id }) =>
		Effect.gen(function* () {
			const db = yield* Db;
			const rows = yield* Effect.promise(() =>
				db
					.select({ id: users.id, email: users.email, name: users.name })
					.from(users)
					.where(eq(users.id, id))
					.limit(1),
			);
			return rows[0] ?? null;
		}),
});

export const usersServicesPlugin = definePlugin({
	id: "users.services",
	meta: { keywords: ["users", "services"] },
	// adminList consumes the PlatformAdmin gate — the dep edge keeps the
	// platform module ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	// Audit writes resolve the Audit service via serviceOption — the dep
	// edge is an ordering hint only; absence is legal.
	optionalDeps: [auditServicesPlugin.id],
	services: Layer.mergeAll(UsersLive, UsersQueriesLive),
});

// Chrome contribution (P-060): the console sidebar entry lives in the
// `portal.sidebar` chrome region; the dep edge orders it after the
// shell like the retired panel entry.
export const usersChromePlugin = definePlugin({
	id: "users.chrome",
	meta: { keywords: ["users", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "users.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/users", label: "Users", icon: UserCogIcon, group: "Identity" },
			},
		},
	],
});

// Panel (system console) contribution: /platform/users is mounted by
// the platform plugin's physical route subtree; this plugin only
// declares the page descriptor. The dep edge orders it after the shell.
export const usersPanelPlugin = definePlugin({
	id: "users.panel",
	meta: { keywords: ["users", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	panel: {
		pages: [
			{
				id: "users.admin",
				path: "/platform/users",
				component: UsersPlatformPage,
				// Cross-owner listing for the console — the service
				// re-checks the PlatformAdmin gate; Forbidden collapses
				// to the same empty table the old server fn returned.
				loader: () =>
					Effect.gen(function* () {
						const users = yield* Users;
						return yield* users
							.adminList()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as AdminUserRow[])));
					}),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	usersServicesPlugin,
	usersChromePlugin,
	usersPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"users.services": true;
		"users.chrome": true;
		"users.panel": true;
	}
}
