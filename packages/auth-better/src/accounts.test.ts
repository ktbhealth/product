import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { makeDb } from "@ktb/db";
import { account, user } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";

import { makeAccountsService, makeAuth } from "./index.ts";

const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE session (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL);
CREATE TABLE account (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

const setup = () => {
	const db = makeDb(makeD1(DDL));
	const sendVerificationEmail = vi.fn(async () => {});
	const auth = makeAuth(db, {
		secret: "test-secret-at-least-32-characters-long",
		baseURL: "http://localhost:3000",
		sendVerificationEmail,
	});
	return { db, auth, sendVerificationEmail, accounts: makeAccountsService(auth) };
};

const PASSWORD = "senha-forte-123";

describe("makeAccountsService", () => {
	it("creates a verified credential account without sending a verification email", async () => {
		const { db, auth, accounts, sendVerificationEmail } = setup();
		const result = await accounts.createVerified({
			email: "  Ana@KTB.test ",
			name: "Ana",
			password: PASSWORD,
		});
		expect(result.ok).toBe(true);
		const [row] = await db.select().from(user).where(eq(user.email, "ana@ktb.test"));
		expect(row).toMatchObject({ name: "Ana", email: "ana@ktb.test", emailVerified: true });
		expect(result).toEqual({ ok: true, userId: row!.id });
		expect(sendVerificationEmail).not.toHaveBeenCalled();

		// Stored like a sign-up: a hashed password on a credential account.
		const [credential] = await db.select().from(account).where(eq(account.userId, row!.id));
		expect(credential).toMatchObject({ providerId: "credential", accountId: row!.id });
		expect(credential!.password).not.toContain(PASSWORD);

		// …so the regular sign-in accepts it, and rejects anything else.
		const signedIn = await auth.api.signInEmail({
			body: { email: "ana@ktb.test", password: PASSWORD },
		});
		expect(signedIn.user.id).toBe(row!.id);
		await expect(
			auth.api.signInEmail({ body: { email: "ana@ktb.test", password: "outra-senha-123" } }),
		).rejects.toThrow();
	});

	it("leaves an address that already has an account untouched", async () => {
		const { db, auth, accounts } = setup();
		const original = await auth.api.signUpEmail({
			body: { email: "ana@ktb.test", name: "Ana", password: PASSWORD },
		});
		expect(
			await accounts.createVerified({
				email: "ANA@ktb.test",
				name: "Impostor",
				password: "outra-senha-123",
			}),
		).toEqual({ ok: false, error: "exists" });
		const rows = await db.select().from(user);
		expect(rows).toHaveLength(1);
		// Not renamed, not verified, and the original password still works.
		expect(rows[0]).toMatchObject({ id: original.user.id, name: "Ana", emailVerified: false });
		await expect(
			auth.api.signInEmail({ body: { email: "ana@ktb.test", password: "outra-senha-123" } }),
		).rejects.toThrow();
		expect(await db.select().from(account)).toHaveLength(1);
	});

	it.each([
		["too short", "1234567"],
		["too long", "x".repeat(129)],
	])("creates nothing for a password that is %s", async (_label, password) => {
		const { db, accounts } = setup();
		expect(await accounts.createVerified({ email: "ana@ktb.test", name: "Ana", password })).toEqual(
			{
				ok: false,
				error: "invalid_password",
			},
		);
		expect(await db.select().from(user)).toHaveLength(0);
	});

	it("accepts the shortest and the longest allowed passwords", async () => {
		const { accounts } = setup();
		expect(
			(await accounts.createVerified({ email: "a@ktb.test", name: "A", password: "12345678" })).ok,
		).toBe(true);
		expect(
			(await accounts.createVerified({ email: "b@ktb.test", name: "B", password: "x".repeat(128) }))
				.ok,
		).toBe(true);
	});
});
