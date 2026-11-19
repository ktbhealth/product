// @ts-nocheck
import { describe, expect, it } from "vitest";

import { makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { apikey as apikeyTable } from "@ktb/db/schema";

import { makeApiKeysAdapter, makeAuth } from "./index.ts";

const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE session (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES "user"(id));
CREATE TABLE account (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES "user"(id), access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER);
CREATE TABLE apikey (id TEXT PRIMARY KEY NOT NULL, config_id TEXT DEFAULT 'default' NOT NULL, name TEXT, start TEXT, reference_id TEXT NOT NULL, prefix TEXT, key TEXT NOT NULL, refill_interval INTEGER, refill_amount INTEGER, last_refill_at INTEGER, enabled INTEGER DEFAULT true, rate_limit_enabled INTEGER DEFAULT false, rate_limit_time_window INTEGER, rate_limit_max INTEGER, request_count INTEGER DEFAULT 0, remaining INTEGER, last_request INTEGER, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, permissions TEXT, metadata TEXT);
`;

const SECRET = "test-secret-at-least-32-characters-long";
const BASE_URL = "http://localhost:3000";
const PASSWORD = "senha-forte-123";

const setup = () => {
	const db = makeDb(makeD1(DDL));
	const auth = makeAuth(db, { secret: SECRET, baseURL: BASE_URL });
	return { db, auth, keys: makeApiKeysAdapter(auth, db) };
};

const signUp = async (auth: ReturnType<typeof makeAuth>, email: string) => {
	const res = await auth.api.signUpEmail({
		body: { email, name: "Dra Ana", password: PASSWORD },
	});
	return res.user.id;
};

describe("apiKey plugin wiring", () => {
	it("exposes createApiKey on the auth api", () => {
		const { auth } = setup();
		expect(typeof auth.api.createApiKey).toBe("function");
	});
});

describe("makeApiKeysAdapter", () => {
	it("round-trips create → list → getSecret → remove", async () => {
		const { auth, keys } = setup();
		const userId = await signUp(auth, "ana@x.com");

		const { id } = await keys.create({
			name: "prod key",
			referenceId: userId,
			metadata: { provider: "openai", secret: "sk-live-1234" },
		});
		expect(typeof id).toBe("string");

		const listed = await keys.list(userId);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.name).toBe("prod key");
		expect(listed[0]?.referenceId).toBe(userId);
		// `list` never carries the plaintext secret — other metadata
		// keys survive, plus the non-sensitive `secretLast4` hint;
		// `getSecret` is the only read-back.
		const meta = JSON.parse(listed[0]?.metadata ?? "") as Record<string, unknown>;
		expect(meta).toEqual({ provider: "openai", secretLast4: "1234" });
		expect(meta).not.toHaveProperty("secret");
		expect(listed[0]?.metadata).not.toContain("sk-live-1234");
		expect(listed[0]?.rateLimitEnabled).toBe(false);

		expect(await keys.getSecret(id, userId)).toBe("sk-live-1234");

		await keys.remove(id, userId);
		expect(await keys.list(userId)).toHaveLength(0);
	});

	it("getSecret and remove cannot reach another referenceId's key", async () => {
		const { db, auth, keys } = setup();
		const a = await signUp(auth, "owner@x.com");
		const b = await signUp(auth, "other@x.com");
		const { id } = await keys.create({
			name: "k",
			referenceId: a,
			metadata: { secret: "sk-owner" },
		});
		// Another referenceId sees nothing and deletes nothing.
		expect(await keys.getSecret(id, b)).toBeNull();
		await keys.remove(id, b);
		expect(await keys.getSecret(id, a)).toBe("sk-owner");
		expect((await db.select().from(apikeyTable)).filter((r) => r.id === id)).toHaveLength(1);
	});

	it("scopes list to the referenceId", async () => {
		const { auth, keys } = setup();
		const a = await signUp(auth, "a@x.com");
		const b = await signUp(auth, "b@x.com");
		await keys.create({ name: "k", referenceId: a, metadata: { secret: "s1" } });
		expect(await keys.list(b)).toHaveLength(0);
		expect(await keys.list(a)).toHaveLength(1);
	});

	it("list strips secret from metadata but keeps other keys", async () => {
		const { auth, keys } = setup();
		const userId = await signUp(auth, "strip@x.com");
		await keys.create({
			name: "k",
			referenceId: userId,
			metadata: { kind: "credential", provider: "openai", secret: "sk-strip-me", note: "prod" },
		});
		const [row] = await keys.list(userId);
		const meta = JSON.parse(row?.metadata ?? "") as Record<string, unknown>;
		expect(meta).toEqual({
			kind: "credential",
			provider: "openai",
			note: "prod",
			secretLast4: "p-me",
		});
	});

	it("create only hints secretLast4 for secrets longer than 4 chars", async () => {
		const { auth, keys } = setup();
		const userId = await signUp(auth, "hint@x.com");
		await keys.create({
			name: "short",
			referenceId: userId,
			metadata: { secret: "abc" },
		});
		await keys.create({
			name: "non-string",
			referenceId: userId,
			metadata: { secret: 42 },
		});
		await keys.create({
			name: "edge-4",
			referenceId: userId,
			metadata: { secret: "abcd" },
		});
		await keys.create({
			name: "edge-5",
			referenceId: userId,
			metadata: { secret: "abcde" },
		});
		const byName = new Map((await keys.list(userId)).map((r) => [r.name, r.metadata]));
		// A ≤4-char secret would be revealed whole by its own "last 4".
		expect(JSON.parse(byName.get("short") ?? "{}")).toEqual({});
		// `list` drops the `secret` key whatever its type; only the
		// string-secret rows above could ever grow a `secretLast4`.
		expect(JSON.parse(byName.get("non-string") ?? "{}")).toEqual({});
		// Exactly 4 chars is still the whole secret — no hint at all.
		expect(JSON.parse(byName.get("edge-4") ?? "{}")).toEqual({});
		expect(JSON.parse(byName.get("edge-5") ?? "{}")).toEqual({ secretLast4: "bcde" });
	});

	it("list survives unparseable or non-object metadata", async () => {
		const { db, keys } = setup();
		const insert = (id: string, metadata: string | null) =>
			db.insert(apikeyTable).values({
				id,
				referenceId: "u1",
				key: `key-${id}`,
				metadata,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
		await insert("l-null", null);
		await insert("l-bad", "not-json");
		await insert("l-num", "42");
		await insert("l-arr", '["a","b"]');
		await insert("l-jsonnull", "null");
		await insert("l-str", '"abc"');
		await insert("l-secret", '{"secret":"s","keep":true}');
		const rows = await keys.list("u1");
		expect(rows).toHaveLength(7);
		const byId = new Map(rows.map((r) => [r.id, r.metadata]));
		expect(byId.get("l-null")).toBeNull();
		expect(byId.get("l-bad")).toBe("{}");
		expect(byId.get("l-num")).toBe("{}");
		expect(byId.get("l-arr")).toBe("{}");
		expect(byId.get("l-jsonnull")).toBe("{}");
		expect(byId.get("l-str")).toBe("{}");
		expect(JSON.parse(byId.get("l-secret") ?? "")).toEqual({ keep: true });
	});

	it("getSecret returns null for unknown, bare or malformed rows", async () => {
		const { db, keys } = setup();
		expect(await keys.getSecret("nope", "u1")).toBeNull();
		const insert = (id: string, metadata: string | null) =>
			db.insert(apikeyTable).values({
				id,
				referenceId: "u1",
				key: `key-${id}`,
				metadata,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
		await insert("m-null", null);
		await insert("m-bad", "not-json");
		await insert("m-odd", '{"secret":42}');
		expect(await keys.getSecret("m-null", "u1")).toBeNull();
		expect(await keys.getSecret("m-bad", "u1")).toBeNull();
		expect(await keys.getSecret("m-odd", "u1")).toBeNull();
	});

	it("remove falls back to a direct delete when the endpoint rejects", async () => {
		const { db, keys } = setup();
		// Server-side deleteApiKey calls carry no session — the adapter
		// recovers through the table row either way.
		await db.insert(apikeyTable).values({
			id: "k-x",
			referenceId: "u1",
			key: "key-k-x",
			metadata: '{"secret":"s"}',
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await keys.remove("k-x", "u1");
		expect(await keys.getSecret("k-x", "u1")).toBeNull();
	});

	it("remove never reaches the endpoint for a key the caller does not own", async () => {
		const { db } = setup();
		await db.insert(apikeyTable).values({
			id: "k-z",
			referenceId: "u1",
			key: "key-k-z",
			metadata: '{"secret":"s"}',
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		// An endpoint that would happily delete by keyId alone — the
		// ownership guard must stop the call before it gets there.
		let calls = 0;
		const auth = {
			api: {
				deleteApiKey: async () => {
					calls++;
					return {};
				},
			},
		};
		const keys = makeApiKeysAdapter(auth as never, db);
		await keys.remove("k-z", "u2");
		expect(calls).toBe(0);
		expect(await keys.getSecret("k-z", "u1")).toBe("s");
	});

	it("remove prefers the plugin endpoint when it accepts the call", async () => {
		const { db } = setup();
		// The ownership check hits the real table first — the endpoint
		// is only reached for rows the caller actually owns.
		await db.insert(apikeyTable).values({
			id: "k-y",
			referenceId: "u1",
			key: "key-k-y",
			metadata: '{"secret":"s"}',
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		let seen = "";
		const auth = {
			api: {
				deleteApiKey: async ({ body }: { body: { keyId: string } }) => {
					seen = body.keyId;
					return {};
				},
			},
		};
		const keys = makeApiKeysAdapter(auth as never, db);
		await keys.remove("k-y", "u1");
		expect(seen).toBe("k-y");
	});
});
