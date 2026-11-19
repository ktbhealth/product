import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { Db, makeDb, type SqlDatabase } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import {
	googleFontCssHref,
	GOOGLE_FONTS_CATALOG,
	googleFontsAdapter,
} from "./adapters/googlefonts.ts";
import { localFontProviderAdapter } from "./adapters/local.ts";

const DDL = `
CREATE TABLE theme_definitions (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	scope text NOT NULL,
	scope_id text DEFAULT '' NOT NULL,
	app_name text,
	seeds text NOT NULL,
	tokens text NOT NULL,
	fonts text,
	brand text,
	enabled integer DEFAULT true NOT NULL,
	version integer DEFAULT 1 NOT NULL,
	created_at integer NOT NULL,
	updated_at integer
);
CREATE TABLE theme_assets (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	theme_id integer REFERENCES theme_definitions(id) ON DELETE SET NULL,
	kind text NOT NULL,
	r2_key text,
	status text DEFAULT 'pending' NOT NULL,
	variants text,
	created_at integer NOT NULL
);
`;

const makeTestDb = () => {
	const d1 = makeD1(DDL);
	return { db: makeDb(d1), d1 };
};

const run = (d1: SqlDatabase, query: string, params: unknown[] = []) =>
	d1
		.prepare(query)
		.bind(...params)
		.run();

describe("googlefonts adapter", () => {
	it("exposes a static catalog of common families with weights", async () => {
		expect(googleFontsAdapter.kind).toBe("googlefonts");
		const entries = await Effect.runPromise(
			googleFontsAdapter.list().pipe(Effect.provideService(Db, makeDb(makeD1()))),
		);
		expect(entries).toEqual(GOOGLE_FONTS_CATALOG);
		expect(entries.length).toBeGreaterThanOrEqual(40);
		const inter = entries.find((e) => e.family === "Inter");
		expect(inter?.weights).toContain(400);
		expect(inter?.meta).toEqual({ source: "googlefonts" });
		expect(new Set(entries.map((e) => e.family)).size).toBe(entries.length);
	});

	it("googleFontCssHref builds the css2 URL", () => {
		expect(googleFontCssHref("Inter", [700, 400, 400])).toBe(
			"https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
		);
		expect(googleFontCssHref("Open Sans", [400])).toContain("family=Open+Sans");
	});
});

describe("local adapter", () => {
	it("lists families from ready font theme_assets", async () => {
		const { db, d1 } = makeTestDb();
		const themeId = (
			await d1
				.prepare(
					`INSERT INTO theme_definitions (scope, scope_id, seeds, tokens, fonts, created_at)
					 VALUES ('platform', '', '{}', '{}',
					 '{"families":{"sans":"Inter","heading":"Playfair Display"},"weights":[400,700]}', 0)
					 RETURNING id`,
				)
				.all<{ id: number }>()
		).results[0]!.id;
		await run(
			d1,
			`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
			 VALUES (?, 'font', 'ready', '{"family":"Inter"}', 0)`,
			[themeId],
		);
		await run(
			d1,
			`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
			 VALUES (?, 'font', 'ready', '{"family":"Inter"}', 0)`,
			[themeId],
		); // duplicate family dedupes
		await run(
			d1,
			`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
			 VALUES (?, 'font', 'ready', NULL, 0)`,
			[themeId],
		); // no variants → theme fonts fallback
		await run(
			d1,
			`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
			 VALUES (?, 'font', 'pending', '{"family":"Skipped"}', 0)`,
			[themeId],
		);
		await run(
			d1,
			`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
			 VALUES (?, 'logo', 'ready', '{"family":"NotAFont"}', 0)`,
			[themeId],
		);

		const entries = await Effect.runPromise(
			localFontProviderAdapter.list().pipe(Effect.provideService(Db, db)),
		);
		const names = entries.map((e) => e.family).sort();
		// Inter (explicit) + Playfair Display (theme-fonts fallback).
		expect(names).toEqual(["Inter", "Playfair Display"]);
		const inter = entries.find((e) => e.family === "Inter");
		expect(inter?.meta).toMatchObject({ source: "local" });
	});

	it("returns [] on an empty store", async () => {
		const { db } = makeTestDb();
		const entries = await Effect.runPromise(
			localFontProviderAdapter.list().pipe(Effect.provideService(Db, db)),
		);
		expect(entries).toEqual([]);
	});
});
