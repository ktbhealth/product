import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { apikey } from "./auth.ts";
import { makeDb } from "./index.ts";
import { makeD1 } from "./testing.ts";

describe("apikey table", () => {
	it("$onUpdate stamps updated_at on update", async () => {
		const db = makeDb(
			makeD1(`CREATE TABLE apikey (
				id TEXT PRIMARY KEY NOT NULL,
				config_id TEXT DEFAULT 'default' NOT NULL,
				name TEXT,
				start TEXT,
				reference_id TEXT NOT NULL,
				prefix TEXT,
				key TEXT NOT NULL,
				refill_interval INTEGER,
				refill_amount INTEGER,
				last_refill_at INTEGER,
				enabled INTEGER DEFAULT true,
				rate_limit_enabled INTEGER DEFAULT false,
				rate_limit_time_window INTEGER,
				rate_limit_max INTEGER,
				request_count INTEGER DEFAULT 0,
				remaining INTEGER,
				last_request INTEGER,
				expires_at INTEGER,
				created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
				updated_at INTEGER NOT NULL,
				permissions TEXT,
				metadata TEXT
			);`),
		);
		await db.insert(apikey).values({
			id: "k1",
			referenceId: "u1",
			key: "sk-x",
			createdAt: new Date(1000),
			updatedAt: new Date(1000),
		});
		await db.update(apikey).set({ name: "renamed" }).where(eq(apikey.id, "k1"));
		const [row] = await db.select().from(apikey);
		expect(row?.name).toBe("renamed");
		expect(row?.updatedAt.getTime()).toBeGreaterThan(1000);
	});
});
