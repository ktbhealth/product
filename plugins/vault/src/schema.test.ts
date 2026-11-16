import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { clinicKeys, entityDeks, groups } from "@ktb/db/schema";

describe("vault schema", () => {
	it("exposes clinic_keys columns and unique device index", () => {
		const cfg = getTableConfig(clinicKeys);
		expect(cfg.name).toBe("clinic_keys");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"tenant_id",
			"user_id",
			"wrap_public_key",
			"sign_public_key",
			"wrapped_master_key",
			"status",
			"approved_by_user_id",
			"approved_at",
			"created_at",
		]);
		const unique = cfg.indexes.find((i) => i.config.unique);
		expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
			"tenant_id",
			"wrap_public_key",
		]);
		const fk = cfg.foreignKeys[0]!;
		expect(fk.reference().foreignColumns[0]!.name).toBe("id");
		expect(fk.onDelete).toBe("cascade");
	});

	it("exposes entity_deks columns and record-reader unique index", () => {
		const cfg = getTableConfig(entityDeks);
		expect(cfg.name).toBe("entity_deks");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"tenant_id",
			"entity_type",
			"entity_id",
			"reader_kind",
			"reader_pubkey",
			"reader_id",
			"wrapped_dek",
			"granted_by_user_id",
			"created_at",
		]);
		const unique = cfg.indexes.find((i) => i.config.unique);
		expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
			"entity_type",
			"entity_id",
			"reader_pubkey",
		]);
		const fk = cfg.foreignKeys[0]!;
		expect(fk.reference().foreignTable).toBe(groups);
		expect(fk.reference().foreignColumns[0]!.name).toBe("id");
		expect(fk.onDelete).toBe("cascade");
	});
});
