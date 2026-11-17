import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { documentCollections, documentRecords } from "@ktb/db/schema";

describe("document_collections schema", () => {
	const cfg = getTableConfig(documentCollections);

	it("stores the collection registry row", () => {
		expect(cfg.name).toBe("document_collections");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"name",
			"owner_plugin_id",
			"schema_json",
			"version",
			"created_at",
			"updated_at",
		]);
	});

	it("keeps collection names unique", () => {
		const unique = cfg.indexes.find((i) => i.config.unique);
		expect(unique?.config.name).toBe("document_collections_name_idx");
	});
});

describe("document_records schema", () => {
	const cfg = getTableConfig(documentRecords);

	it("belongs to a collection and goes away with it", () => {
		expect(cfg.name).toBe("document_records");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"collection_id",
			"data",
			"schema_version",
			"version",
			"owner_id",
			"tenant_id",
			"idempotency_key",
			"created_at",
			"updated_at",
		]);
		const collectionFk = cfg.foreignKeys.find(
			(fk) => fk.reference().foreignTable === documentCollections,
		);
		expect(collectionFk).toBeDefined();
		expect(collectionFk?.onDelete).toBe("cascade");
	});

	it("tenant column points at groups and nullifies", () => {
		const tenantFk = cfg.foreignKeys.find(
			(fk) => fk.reference().foreignTable !== documentCollections,
		);
		expect(tenantFk).toBeDefined();
		expect(tenantFk?.onDelete).toBe("set null");
	});

	it("indexes collection lookups by owner and tenant", () => {
		const names = cfg.indexes.map((i) => i.config.name);
		expect(names).toEqual([
			"document_records_collection_idx",
			"document_records_collection_owner_idx",
			"document_records_collection_tenant_idx",
			"document_records_idempotency_idx",
		]);
	});

	it("keeps idempotency keys unique per collection", () => {
		const unique = cfg.indexes.find((i) => i.config.name === "document_records_idempotency_idx");
		expect(unique?.config.unique).toBe(true);
	});
});
