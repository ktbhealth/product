import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import { FontCatalog, FontCatalogLive, listCatalogRows } from "./catalog.ts";
import { insertFamilyRow, insertProviderRow, setProviderEnabledRow } from "./service.ts";

const DDL = `
CREATE TABLE font_providers (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	kind text NOT NULL,
	name text NOT NULL,
	config text,
	enabled integer DEFAULT true NOT NULL,
	created_at integer NOT NULL,
	updated_at integer
);
CREATE TABLE font_families (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	provider_id integer NOT NULL REFERENCES font_providers(id) ON DELETE CASCADE,
	family text NOT NULL,
	weights text,
	status text DEFAULT 'pending' NOT NULL,
	meta text,
	created_at integer NOT NULL
);
CREATE UNIQUE INDEX font_families_provider_family_idx ON font_families(provider_id, family);
`;

const makeTestDb = () => {
	const d1 = makeD1(DDL);
	return { db: makeDb(d1), d1 };
};

const seed = async (db: DbClient) => {
	const google = await insertProviderRow(db, { kind: "googlefonts", name: "Google", config: null });
	const local = await insertProviderRow(db, { kind: "local", name: "Local", config: null });
	const disabled = await insertProviderRow(db, { kind: "googlefonts", name: "Off", config: null });
	await setProviderEnabledRow(db, disabled!.id, false);
	await insertFamilyRow(db, {
		providerId: google!.id,
		family: "Inter",
		weights: [400, 700],
		meta: { source: "googlefonts" },
	});
	await insertFamilyRow(db, {
		providerId: local!.id,
		family: "Brand Sans",
		weights: null,
		meta: { source: "local", assetId: 42 },
	});
	await insertFamilyRow(db, {
		providerId: disabled!.id,
		family: "Hidden",
		weights: [400],
		meta: null,
	});
	return { google: google!, local: local!, disabled: disabled! };
};

describe("listCatalogRows", () => {
	it("lists enabled-provider families with kind, weights and meta", async () => {
		const { db } = makeTestDb();
		const { google, local } = await seed(db);
		const rows = await listCatalogRows(db);
		expect(rows.map((r) => r.family)).toEqual(["Brand Sans", "Inter"]);
		const inter = rows.find((r) => r.family === "Inter")!;
		expect(inter).toMatchObject({
			providerId: google.id,
			providerName: "Google",
			kind: "googlefonts",
			weights: [400, 700],
			status: "ready",
			meta: { source: "googlefonts" },
		});
		const brand = rows.find((r) => r.family === "Brand Sans")!;
		expect(brand).toMatchObject({
			providerId: local.id,
			providerName: "Local",
			kind: "local",
			weights: [],
		});
		expect(brand.meta).toEqual({ source: "local", assetId: 42 });
	});

	it("returns an empty list on an empty catalog", async () => {
		const { db } = makeTestDb();
		expect(await listCatalogRows(db)).toEqual([]);
	});

	it("degrades malformed weights/meta JSON to empty values", async () => {
		const { db, d1 } = makeTestDb();
		const google = await insertProviderRow(db, {
			kind: "googlefonts",
			name: "Google",
			config: null,
		});
		// insertFamilyRow always JSON.stringifies — malformed payloads
		// can only arrive via a hand-edited row, so insert raw.
		await d1
			.prepare(
				`INSERT INTO font_families (provider_id, family, weights, status, meta, created_at)
				 VALUES (?, 'Broken', 'not json{', 'ready', '{oops', 0)`,
			)
			.bind(google!.id)
			.run();
		const rows = await listCatalogRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			family: "Broken",
			weights: [],
			meta: null,
			status: "ready",
		});
	});
});

describe("FontCatalogLive", () => {
	it("serves list() through the Db port", async () => {
		const { db } = makeTestDb();
		await seed(db);
		const runtime = ManagedRuntime.make(
			FontCatalogLive.pipe(Layer.provide(Layer.succeed(Db, db))) as Layer.Layer<unknown>,
		);
		try {
			const rows = await runtime.runPromise(
				Effect.gen(function* () {
					const catalog = yield* FontCatalog;
					return yield* catalog.list();
				}),
			);
			expect(rows.map((r) => r.family)).toEqual(["Brand Sans", "Inter"]);
		} finally {
			await runtime.dispose();
		}
	});
});
