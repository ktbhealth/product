// @ts-nocheck
import { describe, expect, it } from "vitest";

import { makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makeAuth, toSession, toSessionUser } from "./index.ts";

const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE session (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES "user"(id));
CREATE TABLE account (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES "user"(id), access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER);
CREATE TABLE apikey (id TEXT PRIMARY KEY, config_id TEXT NOT NULL DEFAULT 'default', name TEXT, start TEXT, reference_id TEXT NOT NULL, prefix TEXT, key TEXT NOT NULL, refill_interval INTEGER, refill_amount INTEGER, last_refill_at INTEGER, enabled INTEGER DEFAULT 1, rate_limit_enabled INTEGER DEFAULT 0, rate_limit_time_window INTEGER, rate_limit_max INTEGER, request_count INTEGER DEFAULT 0, remaining INTEGER, last_request INTEGER, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, permissions TEXT, metadata TEXT);
`;

describe("toSessionUser", () => {
	it("converts user record to SessionUser shape", () => {
		const u = toSessionUser({ id: "u-1", email: "dr@example.com", name: "Dra. Ana" });
		expect(u).toEqual({ id: "u-1", email: "dr@example.com", name: "Dra. Ana" });
	});

	it("normalizes null or undefined name to null", () => {
		const u = toSessionUser({ id: "u-2", email: "x@example.com" });
		expect(u.name).toBeNull();
	});
});

describe("toSession", () => {
	it("converts better-auth session output to Session port shape", () => {
		const exp = new Date(Date.now() + 3600_000);
		const s = toSession({
			user: { id: "u-1", email: "dr@example.com", name: "Dra. Ana" },
			session: { id: "sess-1", expiresAt: exp },
		});
		expect(s).toEqual({
			user: { id: "u-1", email: "dr@example.com", name: "Dra. Ana" },
			sessionId: "sess-1",
			expiresAt: exp,
		});
	});
});

describe("makeAuth", () => {
	it("constructs a betterAuth instance with drizzle adapter and options", () => {
		const db = makeDb(makeD1());
		const auth = makeAuth(db, {
			secret: "test-secret-at-least-32-characters-long",
			baseURL: "http://localhost:3000",
		});
		expect(auth).toBeDefined();
		expect(typeof auth.handler).toBe("function");
		expect(auth.api).toBeDefined();
	});

	it("sends no verification email when the host supplies no sender", async () => {
		const auth = makeAuth(makeDb(makeD1()));
		const { emailVerification } = auth.options;
		expect(emailVerification.sendOnSignUp).toBe(false);
		await expect(
			emailVerification.sendVerificationEmail({
				user: { id: "u1", email: "a@ktb.test", name: "Ana" } as never,
				url: "http://localhost:3000/verify",
				token: "t",
			}),
		).resolves.toBeUndefined();
	});

	it("delegates verification emails to the host sender on sign-up", async () => {
		const sent: unknown[] = [];
		const auth = makeAuth(makeDb(makeD1()), {
			sendVerificationEmail: async (input) => {
				sent.push(input);
			},
		});
		const { emailVerification } = auth.options;
		expect(emailVerification.sendOnSignUp).toBe(true);
		const url = "http://localhost:3000/verify";
		await emailVerification.sendVerificationEmail({
			user: { id: "u1", email: "a@ktb.test", name: "Ana" } as never,
			url,
			token: "t",
		});
		await emailVerification.sendVerificationEmail({
			user: { id: "u2", email: "b@ktb.test" } as never,
			url,
			token: "t",
		});
		expect(sent).toEqual([
			{ email: "a@ktb.test", name: "Ana", url },
			{ email: "b@ktb.test", name: null, url },
		]);
	});

	it("signs the user in when the verification link is opened", async () => {
		const sent: { url: string }[] = [];
		const auth = makeAuth(makeDb(makeD1(DDL)), {
			secret: "test-secret-at-least-32-characters-long",
			baseURL: "http://localhost:3000",
			sendVerificationEmail: async (input) => {
				sent.push(input);
			},
		});
		await auth.api.signUpEmail({
			body: { email: "verify@x.com", password: "senha-forte-123", name: "Vera" },
		});
		expect(sent).toHaveLength(1);

		const res = await auth.handler(new Request(sent[0]!.url));
		// autoSignInAfterVerification: the verify response carries a
		// fresh session cookie, not just a redirect.
		expect(res.headers.get("set-cookie") ?? "").toContain("session_token");
	});

	it("leaves password reset disabled when the host supplies no sender", () => {
		const auth = makeAuth(makeDb(makeD1()));
		expect(auth.options.emailAndPassword?.sendResetPassword).toBeUndefined();
	});

	it("delegates reset emails to the host sender and revokes sessions on reset", async () => {
		const sent: unknown[] = [];
		const auth = makeAuth(makeDb(makeD1()), {
			sendPasswordResetEmail: async (input) => {
				sent.push(input);
			},
		});
		const { emailAndPassword } = auth.options;
		expect(emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
		const sendReset = emailAndPassword?.sendResetPassword;
		expect(sendReset).toBeDefined();
		const url = "http://localhost:3000/api/auth/reset-password/t";
		await sendReset!({
			user: { id: "u1", email: "a@ktb.test", name: "Ana" } as never,
			url,
		});
		await sendReset!({
			user: { id: "u2", email: "b@ktb.test" } as never,
			url,
		});
		expect(sent).toEqual([
			{ email: "a@ktb.test", name: "Ana", url },
			{ email: "b@ktb.test", name: null, url },
		]);
	});
});
