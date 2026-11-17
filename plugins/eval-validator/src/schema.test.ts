import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { evalInstance, evalInstanceItem } from "@ktb/eval-persona";

import { evalRun, evalRunSample } from "./schema.ts";

describe("eval validator schema", () => {
	it("eval_run set-nulls the cohort link and indexes it", () => {
		const cfg = getTableConfig(evalRun);
		expect(cfg.name).toBe("eval_run");
		for (const fk of cfg.foreignKeys) {
			// Deleting the generation instance keeps the run record —
			// params already holds the exact input set for audit.
			expect(fk.onDelete).toBe("set null");
			const ref = fk.reference();
			expect(ref.foreignTable).toBe(evalInstance);
		}
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["eval_run_instance_idx"]);
	});

	it("eval_run_sample FKs to run + item and uniques the pair", () => {
		const cfg = getTableConfig(evalRunSample);
		expect(cfg.name).toBe("eval_run_sample");
		const tables = cfg.foreignKeys.map((fk) => {
			expect(fk.onDelete).toBe("cascade");
			return fk.reference().foreignTable;
		});
		expect(tables).toContain(evalRun);
		expect(tables).toContain(evalInstanceItem);
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["eval_run_sample_run_item_idx"]);
	});
});
