import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { eq } from "drizzle-orm";

import { INVITE_KINDS, inviteTokens } from "./schema.ts";

const DDL = `
CREATE TABLE invite_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL, email TEXT NOT NULL, kind TEXT NOT NULL, inviter_name TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL);
CREATE UNIQUE INDEX invite_tokens_token_hash_unique ON invite_tokens (token_hash);
CREATE INDEX invite_tokens_email_idx ON invite_tokens (email);
`;

const invite = {
	tokenHash: "a".repeat(64),
	email: "sec@ktb.test",
	kind: "secretary",
	inviterName: "Dra. Ana",
	expiresAt: new Date("2026-03-08T12:00:00.000Z"),
} as const;

describe("invites schema", () => {
	it("knows the two kinds of invitee", () => {
		expect(INVITE_KINDS).toEqual(["secretary", "patient"]);
	});

	it("exposes invite_tokens with a unique token hash and an email lookup index", () => {
		const cfg = getTableConfig(inviteTokens);
		expect(cfg.name).toBe("invite_tokens");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"token_hash",
			"email",
			"kind",
			"inviter_name",
			"expires_at",
			"consumed_at",
			"created_at",
		]);
		// The token itself has no column: only its hash is stored.
		expect(cfg.columns.map((c) => c.name)).not.toContain("token");
		expect(cfg.columns.filter((c) => c.isUnique).map((c) => c.name)).toEqual(["token_hash"]);
		expect(cfg.columns.filter((c) => !c.notNull).map((c) => c.name)).toEqual(["consumed_at"]);
		expect(cfg.foreignKeys).toEqual([]);
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["invite_tokens_email_idx"]);
		expect(cfg.indexes[0]!.config.columns.map((c) => (c as { name: string }).name)).toEqual([
			"email",
		]);
	});

	it("starts a link unconsumed, stamped with its creation time", async () => {
		const db = makeDb(makeD1(DDL));
		const before = Date.now();
		const [created] = await db.insert(inviteTokens).values(invite).returning();
		expect(created).toMatchObject({ ...invite, id: 1, consumedAt: null });
		expect(created!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1);
		expect(created!.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1);

		const consumedAt = new Date("2026-03-02T09:30:00.000Z");
		await db.update(inviteTokens).set({ consumedAt }).where(eq(inviteTokens.id, created!.id));
		const [row] = await db.select().from(inviteTokens);
		expect(row!.consumedAt).toEqual(consumedAt);
		expect(row!.expiresAt).toEqual(invite.expiresAt);
	});

	it("rejects a second row with the same token hash", async () => {
		const db = makeDb(makeD1(DDL));
		await db.insert(inviteTokens).values(invite);
		await expect(
			db.insert(inviteTokens).values({ ...invite, email: "other@ktb.test", kind: "patient" }),
		).rejects.toThrow(/Failed query/);
		// The same address may hold several links, one per hash.
		await db.insert(inviteTokens).values({ ...invite, tokenHash: "b".repeat(64) });
		expect(await db.select().from(inviteTokens)).toHaveLength(2);
	});
});
