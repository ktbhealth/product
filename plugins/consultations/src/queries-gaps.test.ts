import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import type { DbClient } from "@ktb/db";

import { countPendingReview } from "./queries.ts";

describe("countPendingReview", () => {
	it("falls back to 0 when the count query yields no rows", async () => {
		// count(*) always returns a row in practice — the ?? 0 guard only
		// fires on a stubbed/empty result, so feed a minimal db double.
		const emptyDb = {
			select: () => ({ from: () => ({ where: async () => [] }) }),
		} as unknown as DbClient;
		await expect(countPendingReview(emptyDb, sql`1 = 1`)).resolves.toBe(0);
	});
});
