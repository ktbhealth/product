import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { consultations } from "../../consultations/src/schema.ts";
import { groups } from "../../groups/src/schema.ts";
import { patients } from "../../patients/src/schema.ts";
import { appointments } from "./schema.ts";

describe("agenda schema", () => {
	it("appointments carries the expected columns", () => {
		const cfg = getTableConfig(appointments);
		expect(cfg.name).toBe("appointments");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"owner_id",
			"patient_id",
			"tenant_id",
			"status",
			"starts_at",
			"duration_min",
			"consultation_id",
			"note",
			"reminder_sent_at",
			"external_provider",
			"external_calendar_id",
			"external_event_id",
			"external_etag",
			"sync_state",
			"created_at",
			"updated_at",
		]);
	});

	it("lazy reference callbacks resolve to their FK target tables", () => {
		const cfg = getTableConfig(appointments);
		// reference() evaluates each `() => <table>.id` callback — the
		// drizzle-kit CJS path never runs them, so the test does.
		const refs = cfg.foreignKeys.map((fk) => ({ fk, ref: fk.reference() }));
		const fkTo = (table: unknown) => refs.find((r) => r.ref.foreignTable === table);

		const patient = fkTo(patients);
		expect(patient?.ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);

		// Clinic groups delete → tenant link clears, the row survives.
		const tenant = fkTo(groups);
		expect(tenant?.fk.onDelete).toBe("set null");

		const consultation = fkTo(consultations);
		expect(consultation?.ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
	});

	it("updated_at onUpdate callback returns a fresh timestamp", () => {
		const cfg = getTableConfig(appointments);
		const updatedAt = cfg.columns.find((c) => c.name === "updated_at");
		expect(updatedAt?.onUpdateFn).toBeTypeOf("function");
		expect(updatedAt?.onUpdateFn?.()).toBeInstanceOf(Date);
	});
});
