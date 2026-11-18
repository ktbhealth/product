import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { aiEndpoint } from "@ktb/ai-provider/schema";
import { doctors, patients } from "@ktb/db/schema";

import { evalInstance, evalInstanceItem, evalPersonaDef } from "./schema.ts";

describe("eval-persona schema", () => {
	it("eval_persona_def carries the persona JSON with no FKs", () => {
		const cfg = getTableConfig(evalPersonaDef);
		expect(cfg.name).toBe("eval_persona_def");
		expect(cfg.foreignKeys).toHaveLength(0);
		expect(cfg.columns.find((c) => c.name === "persona")?.notNull).toBe(true);
	});

	it("eval_instance links ai_endpoint with set-null release", () => {
		const cfg = getTableConfig(evalInstance);
		expect(cfg.name).toBe("eval_instance");
		const byTable = new Map(
			cfg.foreignKeys.map((fk) => [fk.reference().foreignTable, fk.onDelete] as const),
		);
		// Deleting an endpoint never destroys the instance record —
		// the lab audit trail survives.
		expect(byTable.get(aiEndpoint)).toBe("set null");
		expect(cfg.columns.find((c) => c.name === "params")?.notNull).toBe(true);
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["eval_instance_status_idx"]);
	});

	it("eval_instance_item cascades with its instance, set-nulls the rest", () => {
		const cfg = getTableConfig(evalInstanceItem);
		expect(cfg.name).toBe("eval_instance_item");
		const byTable = new Map(
			cfg.foreignKeys.map((fk) => [fk.reference().foreignTable, fk.onDelete] as const),
		);
		expect(byTable.get(evalInstance)).toBe("cascade");
		expect(byTable.get(evalPersonaDef)).toBe("set null");
		expect(byTable.get(patients)).toBe("set null");
		expect(byTable.get(doctors)).toBe("set null");
		// The item IS the corpus row — script/turns/voices plus the
		// review gate (state) live on the same record.
		expect(cfg.columns.map((c) => c.name)).toEqual(
			expect.arrayContaining([
				"persona",
				"script",
				"turns",
				"voices",
				"script_mode",
				"state",
				"claimed_at",
			]),
		);
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["eval_instance_item_instance_idx"]);
	});
});
