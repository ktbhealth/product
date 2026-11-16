import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { doctors, patients } from "@ktb/db/schema";

import { evalPersona, evalPersonaBatch, evalRun, evalRunSample } from "./schema.ts";

describe("eval validator schema", () => {
	it("eval_persona FKs to its batch and indexes batch/state", () => {
		const cfg = getTableConfig(evalPersona);
		expect(cfg.name).toBe("eval_persona");
		// batchId cascades with its batch; patient/doctor links only
		// release the persona row (set null) when the synthetic entity
		// is deleted — the review row stays for audit.
		const byTable = new Map(
			cfg.foreignKeys.map((fk) => [fk.reference().foreignTable, fk.onDelete] as const),
		);
		expect(byTable.get(evalPersonaBatch)).toBe("cascade");
		expect(byTable.get(patients)).toBe("set null");
		expect(byTable.get(doctors)).toBe("set null");
		expect(cfg.indexes.map((i) => i.config.name)).toEqual([
			"eval_persona_batch_idx",
			"eval_persona_state_idx",
		]);
	});

	it("eval_run FKs to the batch and indexes it", () => {
		const cfg = getTableConfig(evalRun);
		expect(cfg.name).toBe("eval_run");
		for (const fk of cfg.foreignKeys) {
			expect(fk.onDelete).toBe("cascade");
			const ref = fk.reference();
			expect(ref.foreignTable).toBe(evalPersonaBatch);
		}
		expect(cfg.indexes).toHaveLength(1);
	});

	it("eval_run_sample FKs to run + persona and uniques the pair", () => {
		const cfg = getTableConfig(evalRunSample);
		expect(cfg.name).toBe("eval_run_sample");
		const tables = cfg.foreignKeys.map((fk) => {
			expect(fk.onDelete).toBe("cascade");
			return fk.reference().foreignTable;
		});
		expect(tables).toContain(evalRun);
		expect(tables).toContain(evalPersona);
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["eval_run_sample_run_persona_idx"]);
	});

	it("eval_persona_batch indexes created_at", () => {
		const cfg = getTableConfig(evalPersonaBatch);
		expect(cfg.name).toBe("eval_persona_batch");
		expect(cfg.indexes.map((i) => i.config.name)).toEqual(["eval_persona_batch_created_at_idx"]);
	});
});
