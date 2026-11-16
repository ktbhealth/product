import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { applyMigrations } from "./migrate.ts";

// The identifier columns of `patients` move into `patient_documents`
// in three steps (create table → copy → drop columns). The copy cannot
// be redone once the columns are gone, so this runs the real migration
// files over a database that already holds patients.

const MIGRATIONS = fileURLToPath(new URL("../../db/drizzle", import.meta.url));
const FIRST_NEW = "0016_patient_documents.sql";

describe("patient documents migration", () => {
	const dir = mkdtempSync(join(tmpdir(), "ktb-patient-documents-"));
	const sqlite = new Database(":memory:");
	const files = readdirSync(MIGRATIONS)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	const stage = (wanted: (name: string) => boolean) => {
		for (const name of files.filter(wanted)) copyFileSync(join(MIGRATIONS, name), join(dir, name));
	};

	afterAll(() => {
		sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const columnsOf = (table: string) =>
		(sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

	it("moves every identifier into a document row and drops the columns", () => {
		// The schema as it was before this change, with data in it.
		stage((name) => name < FIRST_NEW);
		applyMigrations(sqlite, dir);
		expect(columnsOf("patients")).toEqual(expect.arrayContaining(["cpf", "cns", "passport"]));
		sqlite
			.prepare(
				`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('doc', 'Dra', 'd@x.com', 1, 0, 0)`,
			)
			.run();
		const insert = sqlite.prepare(
			`INSERT INTO patients (id, owner_id, name, email, cpf, cns, passport, created_at) VALUES (?, 'doc', ?, ?, ?, ?, ?, 0)`,
		);
		insert.run(1, "Todos", "todos@x.com", "52998224725", "100000000000007", "FX123456");
		insert.run(2, "So CPF", null, "11144477735", null, null);
		insert.run(3, "Nenhum", "nenhum@x.com", null, null, null);
		insert.run(4, "Vazios", null, "", "", "");
		insert.run(5, "So passaporte", null, null, null, "ZZ998877");

		// The new migrations, applied on top — everything staged at or
		// after FIRST_NEW, so later migrations don't go stale here.
		stage((name) => name >= FIRST_NEW);
		expect(applyMigrations(sqlite, dir)).toEqual(files.filter((name) => name >= FIRST_NEW));

		expect(
			sqlite
				.prepare(
					"SELECT patient_id, type, country, number FROM patient_documents ORDER BY patient_id, type",
				)
				.all(),
		).toEqual([
			{ patient_id: 1, type: "cns", country: "BR", number: "100000000000007" },
			{ patient_id: 1, type: "cpf", country: "BR", number: "52998224725" },
			{ patient_id: 1, type: "passport", country: null, number: "FX123456" },
			{ patient_id: 2, type: "cpf", country: "BR", number: "11144477735" },
			{ patient_id: 5, type: "passport", country: null, number: "ZZ998877" },
		]);

		// The columns are gone; the rest of every record is untouched.
		const columns = columnsOf("patients");
		for (const gone of ["cpf", "cns", "passport"]) expect(columns).not.toContain(gone);
		expect(sqlite.prepare("SELECT id, name, email FROM patients ORDER BY id").all()).toEqual([
			{ id: 1, name: "Todos", email: "todos@x.com" },
			{ id: 2, name: "So CPF", email: null },
			{ id: 3, name: "Nenhum", email: "nenhum@x.com" },
			{ id: 4, name: "Vazios", email: null },
			{ id: 5, name: "So passaporte", email: null },
		]);
	});

	it("drops a patient's documents with the patient", () => {
		sqlite.pragma("foreign_keys = ON");
		sqlite.prepare("DELETE FROM patients WHERE id = 1").run();
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM patient_documents WHERE patient_id = 1").get(),
		).toEqual({ n: 0 });
		expect(sqlite.prepare("SELECT count(*) AS n FROM patient_documents").get()).toEqual({ n: 2 });
	});
});
