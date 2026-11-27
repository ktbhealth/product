import { describe, expect, it } from "vitest";

import { makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import {
	account as accountTable,
	apikey as apikeyTable,
	session as sessionTable,
	user as userTable,
	verification as verificationTable,
} from "@ktb/db/schema";
import { eq } from "drizzle-orm";

import { makeAuth, makeAuthService } from "./index.ts";

const SECRET = "test-secret-at-least-32-characters-long";
const BASE_URL = "http://localhost:3000";

const makeStack = () => {
	const db = makeDb(makeTestD1());
	const auth = makeAuth(db, { secret: SECRET, baseURL: BASE_URL });
	return { db, auth, service: makeAuthService(auth, db) };
};

const signIn = async (auth: ReturnType<typeof makeAuth>, email: string): Promise<string> => {
	const res = await auth.handler(
		new Request(`${BASE_URL}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password: "senha-forte-123" }),
		}),
	);
	const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
	expect(cookie).toContain("=");
	return cookie;
};

/** Sign up + sign in through the real better-auth handler; returns the
 * session cookie pair and the user id. */
const signUpAndSignIn = async (
	auth: ReturnType<typeof makeAuth>,
	email: string,
): Promise<{ cookie: string; userId: string }> => {
	const signUp = await auth.api.signUpEmail({
		body: { email, password: "senha-forte-123", name: "Dra Ana" },
	});
	const userId = (signUp as { user?: { id?: string } }).user?.id;
	expect(userId).toBeTruthy();
	return { cookie: await signIn(auth, email), userId: userId! };
};

describe("makeAuthService", () => {
	it("getSession returns null without a session", async () => {
		const { service } = makeStack();
		expect(await service.getSession(new Headers())).toBeNull();
		expect(
			await service.getSession(new Headers({ cookie: "better-auth.session_token=bogus" })),
		).toBeNull();
	});

	it("round-trips a session for an active user", async () => {
		const { auth, service } = makeStack();
		const { cookie } = await signUpAndSignIn(auth, "ana@x.com");
		const s = await service.getSession(new Headers({ cookie }));
		expect(s?.user.email).toBe("ana@x.com");
		expect(s?.sessionId).toBeTruthy();
	});

	it("getSession returns null for a banned user even with a live session", async () => {
		const { db, auth, service } = makeStack();
		const { cookie, userId } = await signUpAndSignIn(auth, "flagged@x.com");
		// Flip the flag directly — the session row stays alive, so only
		// the banned check in getSession can reject it.
		await db.update(userTable).set({ banned: true }).where(eq(userTable.id, userId));
		expect(await service.getSession(new Headers({ cookie }))).toBeNull();
	});

	it("setUserBanned(true) revokes sessions and getSession returns null", async () => {
		const { db, auth, service } = makeStack();
		const { cookie, userId } = await signUpAndSignIn(auth, "banned@x.com");
		expect(await service.getSession(new Headers({ cookie }))).not.toBeNull();

		await service.setUserBanned(userId, true);

		expect(await service.getSession(new Headers({ cookie }))).toBeNull();
		const sessions = await db.select().from(sessionTable).where(eq(sessionTable.userId, userId));
		expect(sessions).toHaveLength(0);
		const [u] = await db.select().from(userTable).where(eq(userTable.id, userId));
		expect(u?.banned).toBe(true);
	});

	it("setUserBanned(false) keeps live sessions", async () => {
		const { auth, service } = makeStack();
		const { cookie, userId } = await signUpAndSignIn(auth, "still@x.com");
		expect(await service.getSession(new Headers({ cookie }))).not.toBeNull();

		// Unbanning an account that was never banned must not touch its
		// sessions — only the banned→true transition revokes them.
		await service.setUserBanned(userId, false);

		expect(await service.getSession(new Headers({ cookie }))).not.toBeNull();
	});

	it("setUserBanned(false) reactivates the user", async () => {
		const { db, auth, service } = makeStack();
		const { cookie, userId } = await signUpAndSignIn(auth, "back@x.com");
		await service.setUserBanned(userId, true);
		await service.setUserBanned(userId, false);

		const [u] = await db.select().from(userTable).where(eq(userTable.id, userId));
		expect(u?.banned).toBe(false);
		// Old sessions were revoked on ban — sign in again.
		const fresh = await signIn(auth, "back@x.com");
		const s = await service.getSession(new Headers({ cookie: fresh }));
		expect(s?.user.email).toBe("back@x.com");
		// The revoked cookie stays dead.
		expect(await service.getSession(new Headers({ cookie }))).toBeNull();
	});

	it("getSession resolves the session when the banned lookup finds no user row", async () => {
		const db = makeDb(makeTestD1());
		// A session that outlived its user row (no FK cascade enforced)
		// still resolves — the banned check only rejects on an explicit
		// `banned === true`, never on a missing row.
		const auth = {
			api: {
				getSession: async () => ({
					user: { id: "u-ghost", email: "ghost@x.com", name: "Ghost" },
					session: { id: "s-1", expiresAt: new Date(Date.now() + 3600_000) },
				}),
			},
		};
		const service = makeAuthService(auth as never, db);
		const s = await service.getSession(new Headers());
		expect(s?.user.email).toBe("ghost@x.com");
		expect(s?.sessionId).toBe("s-1");
	});

	it("updateUser patches name and normalizes the email", async () => {
		const { db, auth, service } = makeStack();
		const { userId } = await signUpAndSignIn(auth, "ana@x.com");

		const res = await service.updateUser(userId, { name: "Ana Souza", email: "  Ana@X.com " });

		expect(res).toEqual({ ok: true });
		const [u] = await db.select().from(userTable).where(eq(userTable.id, userId));
		expect(u).toMatchObject({ name: "Ana Souza", email: "ana@x.com" });
	});

	it("updateUser resets emailVerified only when the email changes", async () => {
		const { db, auth, service } = makeStack();
		const { userId } = await signUpAndSignIn(auth, "verified@x.com");
		await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, userId));

		// A name-only save (same email) keeps the flag.
		expect(await service.updateUser(userId, { email: "verified@x.com" })).toEqual({ ok: true });
		let [u] = await db.select().from(userTable).where(eq(userTable.id, userId));
		expect(u?.emailVerified).toBe(true);

		// A new address was never verified — the flag resets with it.
		expect(await service.updateUser(userId, { email: "moved@x.com" })).toEqual({ ok: true });
		[u] = await db.select().from(userTable).where(eq(userTable.id, userId));
		expect(u).toMatchObject({ email: "moved@x.com", emailVerified: false });
	});

	it("updateUser reports exists when another account holds the email", async () => {
		const { auth, service } = makeStack();
		const { userId } = await signUpAndSignIn(auth, "one@x.com");
		await signUpAndSignIn(auth, "two@x.com");

		expect(await service.updateUser(userId, { email: "two@x.com" })).toEqual({
			ok: false,
			error: "exists",
		});
		// Keeping the same email is not a conflict.
		expect(await service.updateUser(userId, { email: "one@x.com" })).toEqual({ ok: true });
	});

	it("updateUser treats an empty patch and a missing user as success", async () => {
		const { auth, service } = makeStack();
		const { userId } = await signUpAndSignIn(auth, "solo@x.com");

		expect(await service.updateUser(userId, {})).toEqual({ ok: true });
		expect(await service.updateUser("ghost", { name: "Nobody" })).toEqual({ ok: true });
	});

	it("deleteUser removes the account and every auth-owned row", async () => {
		const { db, auth, service } = makeStack();
		const { cookie, userId } = await signUpAndSignIn(auth, "gone@x.com");
		const userEmail = "gone@x.com";
		await db.insert(apikeyTable).values({
			id: "k1",
			referenceId: userId,
			key: "ktb_test_key",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await db.insert(verificationTable).values({
			id: "v1",
			identifier: userEmail,
			value: "token",
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		await service.deleteUser(userId);

		expect(await service.getSession(new Headers({ cookie }))).toBeNull();
		expect(await db.select().from(userTable).where(eq(userTable.id, userId))).toHaveLength(0);
		expect(
			await db.select().from(sessionTable).where(eq(sessionTable.userId, userId)),
		).toHaveLength(0);
		expect(
			await db.select().from(accountTable).where(eq(accountTable.userId, userId)),
		).toHaveLength(0);
		expect(
			await db.select().from(apikeyTable).where(eq(apikeyTable.referenceId, userId)),
		).toHaveLength(0);
		expect(
			await db.select().from(verificationTable).where(eq(verificationTable.identifier, userEmail)),
		).toHaveLength(0);
	});

	it("deleteUser on a missing user skips the verification cleanup", async () => {
		const { db, service } = makeStack();
		await db.insert(verificationTable).values({
			id: "v-keep",
			identifier: "keep@x.com",
			value: "token",
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		// No user row → no email → the verification delete is skipped;
		// the call still resolves without throwing and leaves other
		// addresses' verification rows alone.
		await expect(service.deleteUser("ghost")).resolves.toBeUndefined();
		expect(
			await db
				.select()
				.from(verificationTable)
				.where(eq(verificationTable.identifier, "keep@x.com")),
		).toHaveLength(1);
	});
});
