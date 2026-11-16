import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { evalPersona, evalPersonaBatch } from "@ktb/eval-validator";

import { evalInstance, evalInstanceItem, evalLlmEndpoint, evalPersonaDef } from "./schema.ts";

describe("eval-persona schema", () => {
	it("eval_llm_endpoint indexes enabled and keeps provider fields", () => {
		const cfg = getTableConfig(evalLlmEndpoint);
		expect(cfg.name).toBe("eval_llm_endpoint");
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["eval_llm_endpoint_enabled_idx"]);
		expect(cfg.columns.map((c) => c.name)).toEqual(
			expect.arrayContaining(["kind", "base_url", "model", "secret_ref", "timeout_ms", "enabled"]),
		);
		// secret_ref stores an env var NAME — never the credential.
		expect(cfg.columns.find((c) => c.name === "secret_ref")?.notNull).toBe(false);
	});

	it("eval_persona_def carries the persona JSON with no FKs", () => {
		const cfg = getTableConfig(evalPersonaDef);
		expect(cfg.name).toBe("eval_persona_def");
		expect(cfg.foreignKeys).toHaveLength(0);
		expect(cfg.columns.find((c) => c.name === "persona")?.notNull).toBe(true);
	});

	it("eval_instance links endpoint + batch with set-null release", () => {
		const cfg = getTableConfig(evalInstance);
		expect(cfg.name).toBe("eval_instance");
		const byTable = new Map(
			cfg.foreignKeys.map((fk) => [fk.reference().foreignTable, fk.onDelete] as const),
		);
		// Deleting an endpoint or a batch never destroys the instance
		// record — the lab audit trail survives.
		expect(byTable.get(evalLlmEndpoint)).toBe("set null");
		expect(byTable.get(evalPersonaBatch)).toBe("set null");
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
		expect(byTable.get(evalPersona)).toBe("set null");
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["eval_instance_item_instance_idx"]);
	});
});
