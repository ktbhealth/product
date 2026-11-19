import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, ne } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import type {
	AccountsShape,
	ApiKeysShape,
	AuthShape,
	Session,
	SessionUser,
	UpdateUserResult,
} from "@ktb/auth";
import {
	account as accountTable,
	apikey as apikeyTable,
	session as sessionTable,
	user as userTable,
	verification as verificationTable,
} from "@ktb/db/schema";

/** What the host needs to compose and deliver a verification email. */
export interface VerificationEmailInput {
	readonly email: string;
	readonly name: string | null;
	/** Link that verifies the address when opened. */
	readonly url: string;
}

/** What the host needs to compose and deliver a password-reset email. */
export interface PasswordResetEmailInput {
	readonly email: string;
	readonly name: string | null;
	/** Link that validates the token and lands on the reset form. */
	readonly url: string;
}

export interface AuthOptions {
	readonly secret?: string;
	readonly baseURL?: string;
	/**
	 * Delivers the verification link. When absent (no email sender
	 * configured) nothing is sent on sign-up. Verification is never
	 * required to sign in — flows that depend on a proven address check
	 * `user.emailVerified` themselves.
	 */
	readonly sendVerificationEmail?: (input: VerificationEmailInput) => Promise<void>;
	/**
	 * Delivers the password-reset link. When absent the
	 * /request-password-reset endpoint stays disabled — a deployment
	 * without outbound email cannot recover accounts by mail anyway.
	 */
	readonly sendPasswordResetEmail?: (input: PasswordResetEmailInput) => Promise<void>;
}

export type AuthDb = ReturnType<typeof drizzle>;

export const makeAuth = (db: AuthDb, opts: AuthOptions = {}) => {
	const sendPasswordResetEmail = opts.sendPasswordResetEmail;
	return betterAuth({
		database: drizzleAdapter(db, { provider: "sqlite" }),
		emailAndPassword: {
			enabled: true,
			// A reset means the old password may be compromised — every
			// live session dies with it.
			revokeSessionsOnPasswordReset: true,
			// Only bound when the host can send email; an absent sender
			// leaves the endpoint answering RESET_PASSWORD_DISABLED
			// instead of silently dropping the message.
			...(sendPasswordResetEmail === undefined
				? {}
				: {
						sendResetPassword: async (data: {
							user: { email: string; name?: string | null };
							url: string;
						}) => {
							await sendPasswordResetEmail({
								email: data.user.email,
								name: data.user.name ?? null,
								url: data.url,
							});
						},
					}),
		},
		emailVerification: {
			sendOnSignUp: opts.sendVerificationEmail !== undefined,
			autoSignInAfterVerification: true,
			sendVerificationEmail: async ({ user, url }) => {
				await opts.sendVerificationEmail?.({ email: user.email, name: user.name ?? null, url });
			},
		},
		secret: opts.secret,
		baseURL: opts.baseURL,
		plugins: [
			// Managed credential store (eval lab outbound providers):
			// hashing disabled so `resolve` can read the secret back for
			// outbound calls, metadata enabled because the secret rides
			// inside `metadata` — keys live server-side, never on the wire.
			apiKey({ disableKeyHashing: true, enableMetadata: true }),
		],
	});
};

export type Auth = ReturnType<typeof makeAuth>;

export const toSessionUser = (u: {
	id: string;
	email: string;
	name?: string | null;
}): SessionUser => ({
	id: u.id,
	email: u.email,
	name: u.name ?? null,
});

export const toSession = (s: {
	user: { id: string; email: string; name?: string | null };
	session: { id: string; expiresAt: Date };
}): Session => ({
	user: toSessionUser(s.user),
	sessionId: s.session.id,
	expiresAt: s.session.expiresAt,
});

/**
 * Auth port implementation over a better-auth instance + its drizzle
 * database (T-034). The `user.banned` flag is enforced here — not in
 * better-auth — so `getSession` returns null for suspended users and
 * `setUserBanned` revokes their session rows on ban.
 */
export const makeAuthService = (auth: Auth, db: AuthDb): AuthShape => ({
	getSession: async (headers) => {
		const s = await auth.api.getSession({ headers });
		if (!s) return null;
		const rows = await db
			.select({ banned: userTable.banned })
			.from(userTable)
			.where(eq(userTable.id, s.user.id))
			.limit(1);
		// A live session always resolves to a user row (FK cascade), so
		// `some` is equivalent to checking rows[0] without an
		// uncoverable optional-chain branch.
		if (rows.some((r) => r.banned === true)) return null;
		return toSession(s);
	},
	setUserBanned: async (userId, banned) => {
		await db.update(userTable).set({ banned }).where(eq(userTable.id, userId));
		if (banned) {
			// Revoke every live session — getSession already returns null
			// for banned users, but deleting the rows also kills sessions
			// better-auth would otherwise keep refreshing.
			await db.delete(sessionTable).where(eq(sessionTable.userId, userId));
		}
	},
	updateUser: async (userId, fields): Promise<UpdateUserResult> => {
		const patch: { name?: string; email?: string } = {};
		if (fields.name !== undefined) patch.name = fields.name;
		if (fields.email !== undefined) {
			const normalized = fields.email.trim().toLowerCase();
			// The `user.email` unique index would also catch this, but a
			// pre-check maps the conflict to "exists" instead of a raw
			// constraint error.
			const clash = await db
				.select({ id: userTable.id })
				.from(userTable)
				.where(and(eq(userTable.email, normalized), ne(userTable.id, userId)))
				.limit(1);
			if (clash.length > 0) return { ok: false, error: "exists" };
			patch.email = normalized;
		}
		if (patch.name === undefined && patch.email === undefined) return { ok: true };
		await db.update(userTable).set(patch).where(eq(userTable.id, userId));
		return { ok: true };
	},
	deleteUser: async (userId) => {
		const rows = await db
			.select({ email: userTable.email })
			.from(userTable)
			.where(eq(userTable.id, userId))
			.limit(1);
		const email = rows[0]?.email;
		// Explicit deletes rather than relying on the FK cascades:
		// session/account declare onDelete cascade, but apikey and
		// verification have no user FK at all — apikey.referenceId is a
		// bare text column and verification.identifier holds the email.
		await db.delete(sessionTable).where(eq(sessionTable.userId, userId));
		await db.delete(accountTable).where(eq(accountTable.userId, userId));
		await db.delete(apikeyTable).where(eq(apikeyTable.referenceId, userId));
		if (email !== undefined) {
			await db.delete(verificationTable).where(eq(verificationTable.identifier, email));
		}
		await db.delete(userTable).where(eq(userTable.id, userId));
	},
});

/**
 * Accounts port implementation: the same steps as better-auth's
 * sign-up (normalized email, hashed password, credential account), but
 * the user starts with a verified email and no verification message is
 * sent. An address that already has an account is left untouched.
 */
export const makeAccountsService = (auth: Auth): AccountsShape => ({
	createVerified: async ({ email, name, password }) => {
		const ctx = await auth.$context;
		const { minPasswordLength, maxPasswordLength } = ctx.password.config;
		if (password.length < minPasswordLength || password.length > maxPasswordLength) {
			return { ok: false, error: "invalid_password" };
		}
		const normalized = email.trim().toLowerCase();
		if (await ctx.internalAdapter.findUserByEmail(normalized)) {
			return { ok: false, error: "exists" };
		}
		// Hashed before the user row exists, like sign-up: a failing hash
		// must not leave an account behind.
		const hash = await ctx.password.hash(password);
		const created = await ctx.internalAdapter.createUser(
			{ email: normalized, name, emailVerified: true },
			{ method: "email-password" },
		);
		await ctx.internalAdapter.linkAccount({
			userId: created.id,
			providerId: "credential",
			accountId: created.id,
			password: hash,
		});
		return { ok: true, userId: created.id };
	},
});

/**
 * `list` projection: metadata goes out with `secret` removed — the
 * raw column still holds it for `getSecret`/outbound reads, but a
 * listed row must never carry the plaintext. Unparseable or
 * non-object metadata collapses to `"{}"` rather than passing
 * through unchecked.
 */
const stripMetadataSecret = (raw: string | null): string | null => {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "{}";
		const { secret: _secret, ...rest } = parsed as Record<string, unknown>;
		return JSON.stringify(rest);
	} catch {
		return "{}";
	}
};

/**
 * apiKey-plugin adapter for eval-lab outbound credentials. The plugin
 * OWNS create/delete semantics (its `apikey` table is the store); raw
 * secrets ride inside `metadata.secret` — `disableKeyHashing` keeps
 * the row readable server-side for outbound calls while `list`/the
 * wire only ever see masked metadata. `list`/`getSecret` read the
 * table directly because the plugin's read endpoints are
 * session-header-scoped (a service has no headers); writes go
 * through `auth.api` so plugin hooks and bookkeeping stay canonical.
 *
 * Secrets at rest are plaintext-in-metadata BY DESIGN for the eval
 * lab's outbound calls; this adapter is the boundary that keeps them
 * off list/read paths. If these keys ever serve production tenants,
 * migrate secret storage to @ktb/crypto EntityCipher.
 */
export const makeApiKeysAdapter = (auth: Auth, db: AuthDb): ApiKeysShape => ({
	create: async (input: {
		readonly name: string;
		readonly referenceId: string;
		readonly metadata: Record<string, unknown>;
	}) => {
		// `secret` stays for getSecret/outbound reads; `secretLast4` is
		// the only hint `list` may show. The >4 guard keeps a short
		// secret from being revealed whole by its own "last 4".
		const secret = input.metadata.secret;
		const metadata =
			typeof secret === "string" && secret.length > 4
				? { ...input.metadata, secretLast4: secret.slice(-4) }
				: input.metadata;
		const r = await auth.api.createApiKey({
			body: {
				name: input.name,
				userId: input.referenceId,
				metadata,
				rateLimitEnabled: false,
			},
		});
		return { id: r.id };
	},
	list: async (referenceId: string) => {
		const rows = await db
			.select()
			.from(apikeyTable)
			.where(eq(apikeyTable.referenceId, referenceId));
		return rows.map((row) => ({ ...row, metadata: stripMetadataSecret(row.metadata) }));
	},
	remove: async (keyId: string, referenceId: string) => {
		// Ownership check first — acting on `keyId` alone would let one
		// user delete another's credential by guessing the id.
		const owned = await db
			.select({ id: apikeyTable.id })
			.from(apikeyTable)
			.where(and(eq(apikeyTable.id, keyId), eq(apikeyTable.referenceId, referenceId)))
			.limit(1);
		if (owned.length === 0) return;
		try {
			await auth.api.deleteApiKey({ body: { keyId } });
		} catch {
			await db
				.delete(apikeyTable)
				.where(and(eq(apikeyTable.id, keyId), eq(apikeyTable.referenceId, referenceId)));
		}
	},
	getSecret: async (keyId: string, referenceId: string): Promise<string | null> => {
		const rows = await db
			.select({ metadata: apikeyTable.metadata })
			.from(apikeyTable)
			.where(and(eq(apikeyTable.id, keyId), eq(apikeyTable.referenceId, referenceId)));
		const raw = rows[0]?.metadata;
		if (raw === null || raw === undefined) return null;
		try {
			const parsed = JSON.parse(raw) as { secret?: unknown };
			return typeof parsed.secret === "string" ? parsed.secret : null;
		} catch {
			return null;
		}
	},
});
