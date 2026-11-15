import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { patientDocuments, patients } from "@ktb/db/schema";

describe("patients schema", () => {
	it("exposes table config with owner FK", () => {
		const cfg = getTableConfig(patients);
		expect(cfg.name).toBe("patients");
		expect(cfg.columns.map((c) => c.name)).toContain("owner_id");
		for (const fk of cfg.foreignKeys) {
			expect(fk.reference().foreignColumns.length).toBeGreaterThan(0);
		}
	});
});

describe("patient_documents schema", () => {
	const cfg = getTableConfig(patientDocuments);

	it("no longer keeps identifiers as columns of the record", () => {
		const columns = getTableConfig(patients).columns.map((c) => c.name);
		for (const gone of ["cpf", "cns", "passport"]) expect(columns).not.toContain(gone);
	});

	it("belongs to a patient and goes away with it", () => {
		expect(cfg.name).toBe("patient_documents");
		expect(cfg.foreignKeys).toHaveLength(1);
		const fk = cfg.foreignKeys[0]!;
		expect(fk.reference().foreignTable).toBe(patients);
		expect(fk.onDelete).toBe("cascade");
	});

	it("allows one document of each type per patient", () => {
		const unique = cfg.indexes.find((i) => i.config.unique);
		expect(unique?.config.name).toBe("patient_documents_patient_type_idx");
		expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
			"patient_id",
			"type",
		]);
	});

	it("requires a type and a number; the issuing country is optional", () => {
		const column = (name: string) => cfg.columns.find((c) => c.name === name)!;
		expect(column("type").notNull).toBe(true);
		expect(column("number").notNull).toBe(true);
		expect(column("country").notNull).toBe(false);
	});
});
