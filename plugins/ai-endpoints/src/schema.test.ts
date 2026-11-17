import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { aiAgentLink, aiEndpoint } from "./schema.ts";

describe("ai-endpoints schema", () => {
	it("ai_endpoint indexes enabled, carries provider fields + scope/default", () => {
		const cfg = getTableConfig(aiEndpoint);
		expect(cfg.name).toBe("ai_endpoint");
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["ai_endpoint_enabled_idx"]);
		expect(cfg.columns.map((c) => c.name)).toEqual(
			expect.arrayContaining([
				"kind",
				"base_url",
				"model",
				"secret_ref",
				"transport",
				"scope",
				"is_default",
				"timeout_ms",
				"enabled",
			]),
		);
		// secret_ref stores an env var NAME or credential:<id> — never
		// the credential.
		expect(cfg.columns.find((c) => c.name === "secret_ref")?.notNull).toBe(false);
		expect(cfg.columns.find((c) => c.name === "scope")?.notNull).toBe(true);
		expect(cfg.columns.find((c) => c.name === "is_default")?.notNull).toBe(true);
	});

	it("ai_agent_link keys by token hash, FKs endpoint_id with cascade", () => {
		const cfg = getTableConfig(aiAgentLink);
		expect(cfg.name).toBe("ai_agent_link");
		expect(cfg.columns.map((c) => c.name)).toEqual(
			expect.arrayContaining([
				"endpoint_id",
				"token_hash",
				"created_by",
				"expires_at",
				"used_at",
				"revoked_at",
			]),
		);
		// revoked_at stays nullable — unset rows are live links.
		expect(cfg.columns.find((c) => c.name === "revoked_at")?.notNull).toBe(false);
		for (const fk of cfg.foreignKeys) {
			expect(fk.onDelete).toBe("cascade");
			// reference() evaluates the lazy `() => aiEndpoint.id` callback.
			const ref = fk.reference();
			expect(ref.foreignTable).toBe(aiEndpoint);
			expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
		}
	});
});
