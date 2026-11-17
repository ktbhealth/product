import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, eq, gt, isNull } from "drizzle-orm";
import { physical } from "@tanstack/virtual-file-routes";

import { Accounts, DoctorProfiles, PatientProfiles } from "@ktb/auth";
import { Db, type DbClient } from "@ktb/db";
import { user } from "@ktb/db/schema";
import { definePlugin, type Plugin } from "@ktb/kernel";

import { inviteTokens, type InviteKind, type InviteToken } from "./schema.ts";

export { INVITE_KINDS, type InviteKind, type InviteToken } from "./schema.ts";
export { INVITE_DESTINATIONS } from "./kinds.ts";

/** How long an accept link stays usable. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Emails are matched case-insensitively: stored and compared lowercased. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** A fresh link token: 256 bits from the platform CSPRNG, URL-safe. */
export const newInviteToken = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
};

/** What is stored for a token: its SHA-256, hex-encoded. */
export const hashInviteToken = async (token: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** True when `email` (already normalized) has an account. */
export async function accountExists(db: DbClient, email: string): Promise<boolean> {
	const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
	return rows.length > 0;
}

/**
 * Create the accept link token for an invite and return it — the only
 * moment the raw token exists server-side. A newer invite of the same
 * kind replaces the address's pending links, so one invite has one
 * live link.
 */
export async function issueInvite(
	db: DbClient,
	input: {
		readonly email: string;
		readonly kind: InviteKind;
		readonly inviterName: string;
	},
	now: Date,
): Promise<string> {
	const token = newInviteToken();
	await db
		.delete(inviteTokens)
		.where(
			and(
				eq(inviteTokens.email, input.email),
				eq(inviteTokens.kind, input.kind),
				isNull(inviteTokens.consumedAt),
			),
		);
	await db.insert(inviteTokens).values({
		tokenHash: await hashInviteToken(token),
		email: input.email,
		kind: input.kind,
		inviterName: input.inviterName,
		expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
		createdAt: now,
	});
	return token;
}

/** The invite `token` opens — null for an unknown, used or expired link. */
export async function findInvite(
	db: DbClient,
	token: string,
	now: Date,
): Promise<InviteToken | null> {
	const rows = await db
		.select()
		.from(inviteTokens)
		.where(
			and(
				eq(inviteTokens.tokenHash, await hashInviteToken(token)),
				isNull(inviteTokens.consumedAt),
				gt(inviteTokens.expiresAt, now),
			),
		);
	return rows[0] ?? null;
}

/** Mark a link used. */
export async function consumeInvite(db: DbClient, id: number, now: Date): Promise<void> {
	await db.update(inviteTokens).set({ consumedAt: now }).where(eq(inviteTokens.id, id));
}

/** What the accept screen shows for a live link. */
export interface InvitePreview {
	readonly email: string;
	readonly kind: InviteKind;
	readonly inviterName: string;
	/** The address got an account since the invite went out — the link
	 * creates nothing; the invitee signs in instead. */
	readonly accountExists: boolean;
}

/** Why a link could not be accepted — codes on the wire, copy in the view. */
export type InviteErrorCode = "invalid" | "account_exists" | "invalid_name" | "invalid_password";

export class InviteRejected extends Data.TaggedError("InviteRejected")<{
	readonly code: InviteErrorCode;
}> {}

/**
 * Invite links domain port. The invite itself — who may act for a
 * doctor, who may open a patient record — belongs to the plugin that
 * sends it and is keyed by email; this service only turns "the invitee
 * received our email" into an account for that address.
 */
export class Invites extends Context.Service<
	Invites,
	{
		/**
		 * A link token for an invite email — null when the address
		 * already has an account, which has nothing to create and just
		 * signs in.
		 */
		readonly issue: (input: {
			readonly email: string;
			readonly kind: InviteKind;
			readonly inviterName: string;
		}) => Effect.Effect<string | null>;
		/** What a link opens — null for an unknown, used or expired one. */
		readonly preview: (token: string) => Effect.Effect<InvitePreview | null>;
		/**
		 * Create the invitee's account — verified, since the link reached
		 * their address — and activate what that address was invited to.
		 * Never signs in and never touches an existing account.
		 */
		readonly accept: (input: {
			readonly token: string;
			readonly name: string;
			readonly password: string;
		}) => Effect.Effect<{ readonly email: string; readonly kind: InviteKind }, InviteRejected>;
	}
>()("@ktb/invites/Invites") {}

export const InvitesLive = Layer.effect(
	Invites,
	Effect.gen(function* () {
		const db = yield* Db;
		const accounts = yield* Accounts;
		return Invites.of({
			issue: Effect.fn("Invites.issue")(function* (input) {
				const email = normalizeEmail(input.email);
				if (yield* Effect.promise(() => accountExists(db, email))) return null;
				return yield* Effect.promise(() => issueInvite(db, { ...input, email }, new Date()));
			}),
			preview: Effect.fn("Invites.preview")(function* (token: string) {
				const invite = yield* Effect.promise(() => findInvite(db, token, new Date()));
				if (invite === null) return null;
				return {
					email: invite.email,
					kind: invite.kind,
					inviterName: invite.inviterName,
					accountExists: yield* Effect.promise(() => accountExists(db, invite.email)),
				};
			}),
			accept: Effect.fn("Invites.accept")(function* (input) {
				const name = input.name.trim();
				if (name === "") return yield* Effect.fail(new InviteRejected({ code: "invalid_name" }));
				const invite = yield* Effect.promise(() => findInvite(db, input.token, new Date()));
				if (invite === null) return yield* Effect.fail(new InviteRejected({ code: "invalid" }));
				const created = yield* Effect.promise(() =>
					accounts.createVerified({
						email: invite.email,
						name,
						password: input.password,
					}),
				);
				if (!created.ok) {
					return yield* Effect.fail(
						new InviteRejected({
							code: created.error === "exists" ? "account_exists" : "invalid_password",
						}),
					);
				}
				yield* Effect.promise(() => consumeInvite(db, invite.id, new Date()));
				// The new account's email is verified, so the directories can
				// activate whatever that address was invited to. Looked up per
				// call: either side may not be deployed.
				const doctors = yield* Effect.serviceOption(DoctorProfiles);
				if (Option.isSome(doctors)) yield* doctors.value.claimInvites(created.userId);
				const patients = yield* Effect.serviceOption(PatientProfiles);
				if (Option.isSome(patients)) yield* patients.value.syncLinks(created.userId);
				return { email: invite.email, kind: invite.kind };
			}),
		});
	}),
);

/**
 * The path an invite email should link to when the invitee still has
 * to create an account — null when the address already has one, or when
 * invite links are not deployed; the sender then links to its sign-in
 * screen instead.
 */
export const inviteAcceptPath = (input: {
	readonly email: string;
	readonly kind: InviteKind;
	readonly inviterName: string;
}): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		const invites = yield* Effect.serviceOption(Invites);
		if (Option.isNone(invites)) return null;
		const token = yield* invites.value.issue(input);
		// In the fragment, never the path: see the accept route.
		return token === null ? null : `/invite#${token}`;
	});

export const invitesTablesPlugin = definePlugin({
	id: "invites.tables",
	meta: { keywords: ["invites", "tables"] },
	tables: { inviteTokens },
});

export const invitesServicesPlugin = definePlugin({
	id: "invites.services",
	meta: { keywords: ["invites", "services"] },
	services: InvitesLive,
});

// Route subtree composed into the host's virtualRouteConfig: the route
// modules live in THIS package (src/routes/**), discovered by a
// physical() directory scan relative to the host's routes directory.
export const invitesRoutesPlugin = definePlugin({
	id: "invites.routes",
	meta: { keywords: ["invites", "routes"] },
	routes: [physical("/invite", "../../../../plugins/invites/src/routes")],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	invitesTablesPlugin,
	invitesServicesPlugin,
	invitesRoutesPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"invites.tables": true;
		"invites.services": true;
		"invites.routes": true;
	}
}
