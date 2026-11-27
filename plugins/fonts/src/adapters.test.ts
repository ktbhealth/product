import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { Db, makeDb, type SqlDatabase } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import {
	googleFontCssHref,
	GOOGLE_FONTS_CATALOG,
	googleFontsAdapter,
} from "./adapters/googlefonts.ts";
import { localFontProviderAdapter } from "./adapters/local.ts";

const makeTestDb = () => {
	const d1 = makeTestD1();
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
			googleFontsAdapter.list().pipe(Effect.provideService(Db, makeDb(makeTestD1()))),
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

	it("reads weights from catalog variants (explicit array, then face fallback)", async () => {
		const { db, d1 } = makeTestDb();
		const addAsset = (variants: string) =>
			run(
				d1,
				`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
				 VALUES (NULL, 'font', 'ready', ?, 0)`,
				[variants],
			);
		// Multi-weight catalog upload: explicit weights array wins.
		await addAsset(
			'{"family":"Inter","weights":[700,400],"fontAsset":{"faces":[{"url":"u","weight":400},{"url":"u","weight":700}],"fallback":null}}',
		);
		// Pre-weights row: the per-face descriptors still report weights.
		await addAsset(
			'{"family":"Legacy","fontAsset":{"faces":[{"url":"u","weight":600}],"fallback":null}}',
		);
		// Weightless row stays weightless.
		await addAsset('{"family":"Plain","fontAsset":{"faces":[{"url":"u"}],"fallback":null}}');
		// Malformed weights array falls back to the faces.
		await addAsset(
			'{"family":"Odd","weights":"nope","fontAsset":{"faces":[{"url":"u","weight":300}],"fallback":null}}',
		);
		// Malformed weights + weightless faces → no weights.
		await addAsset('{"family":"Bare","weights":["x"],"fontAsset":{"faces":[{"url":"u"}]}}');

		const entries = await Effect.runPromise(
			localFontProviderAdapter.list().pipe(Effect.provideService(Db, db)),
		);
		const byFamily = new Map(entries.map((e) => [e.family, e]));
		expect(byFamily.get("Inter")?.weights).toEqual([400, 700]);
		expect(byFamily.get("Legacy")?.weights).toEqual([600]);
		expect(byFamily.get("Plain")?.weights).toBeUndefined();
		expect(byFamily.get("Odd")?.weights).toEqual([300]);
		expect(byFamily.get("Bare")?.weights).toBeUndefined();
	});

	it("reports variable fonts: axis endpoints as weights + meta fields", async () => {
		const { db, d1 } = makeTestDb();
		const addAsset = (variants: string) =>
			run(
				d1,
				`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
				 VALUES (NULL, 'font', 'ready', ?, 0)`,
				[variants],
			);
		// Pure variable upload: no discrete weights — the wght axis
		// endpoints stand in and ride meta for consumers.
		await addAsset(
			'{"family":"VarSans","variable":true,"weightAxis":{"min":100,"default":400,"max":900},"unicodeRange":"U+0020-007E","fontAsset":{"faces":[{"url":"u","weightRange":[100,900]}],"fallback":null}}',
		);
		// Explicit weights still win over the axis endpoints.
		await addAsset(
			'{"family":"VarExplicit","weights":[400],"weightAxis":{"min":100,"default":400,"max":900},"fontAsset":{"faces":[]}}',
		);
		// Malformed axis → no variable flags, face-weight fallback.
		await addAsset(
			'{"family":"BadAxis","variable":"yes","weightAxis":{"min":9,"default":1,"max":2},"unicodeRange":"  ","fontAsset":{"faces":[{"url":"u","weight":300}]}}',
		);

		const entries = await Effect.runPromise(
			localFontProviderAdapter.list().pipe(Effect.provideService(Db, db)),
		);
		const byFamily = new Map(entries.map((e) => [e.family, e]));
		const variable = byFamily.get("VarSans");
		expect(variable?.weights).toEqual([100, 900]);
		expect(variable?.meta).toMatchObject({
			source: "local",
			variable: true,
			weightAxis: { min: 100, default: 400, max: 900 },
			unicodeRange: "U+0020-007E",
		});
		expect(byFamily.get("VarExplicit")?.weights).toEqual([400]);
		expect(byFamily.get("VarExplicit")?.meta).toMatchObject({
			variable: true,
			weightAxis: { min: 100, default: 400, max: 900 },
		});
		const bad = byFamily.get("BadAxis");
		expect(bad?.weights).toEqual([300]);
		expect(bad?.meta).toEqual({ source: "local", assetId: bad?.meta?.["assetId"] });
		expect(bad?.meta?.["variable"]).toBeUndefined();
		expect(bad?.meta?.["weightAxis"]).toBeUndefined();
	});

	it("propagates non-wght fvar axes into meta; axes imply variable", async () => {
		const { db, d1 } = makeTestDb();
		const addAsset = (variants: string) =>
			run(
				d1,
				`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
				 VALUES (NULL, 'font', 'ready', ?, 0)`,
				[variants],
			);
		// wdth + opsz axes, no wght/weightAxis — still variable.
		await addAsset(
			'{"family":"Wide","axes":[{"tag":"wdth","min":75,"default":100,"max":125},{"tag":"opsz","min":6,"default":14,"max":72}],"fontAsset":{"faces":[]}}',
		);
		// Explicit variable:false does not veto axis-implied variability.
		await addAsset(
			'{"family":"AxesOnly","variable":false,"axes":[{"tag":"slnt","min":-12,"default":0,"max":0}],"fontAsset":{"faces":[]}}',
		);
		// Every malformed axis is dropped → no axes, no variable flag.
		await addAsset(
			'{"family":"BadAxes","axes":[{"tag":"wght","min":1,"default":2,"max":3},{"tag":"bad","min":1,"default":2,"max":3},{"tag":"wdth","min":9,"default":1,"max":2},5,"x",{"tag":"opsz","min":"s","default":1,"max":2},{"tag":"ital","min":0,"default":1,"max":0}],"fontAsset":{"faces":[]}}',
		);
		// Non-array axes value is ignored.
		await addAsset('{"family":"AxesStr","axes":"nope","fontAsset":{"faces":[]}}');
		// Axis list is capped at 32 entries.
		const many = JSON.stringify({
			family: "Many",
			axes: Array.from({ length: 40 }, (_, i) => ({
				tag: `A${i.toString(16).padStart(3, "0")}`,
				min: 0,
				default: 1,
				max: 2,
			})),
			fontAsset: { faces: [] },
		});
		await addAsset(many);

		const entries = await Effect.runPromise(
			localFontProviderAdapter.list().pipe(Effect.provideService(Db, db)),
		);
		const byFamily = new Map(entries.map((e) => [e.family, e]));
		expect(byFamily.get("Wide")?.meta).toMatchObject({
			variable: true,
			axes: [
				{ tag: "wdth", min: 75, default: 100, max: 125 },
				{ tag: "opsz", min: 6, default: 14, max: 72 },
			],
		});
		expect(byFamily.get("AxesOnly")?.meta).toMatchObject({
			variable: true,
			axes: [{ tag: "slnt", min: -12, default: 0, max: 0 }],
		});
		const bad = byFamily.get("BadAxes");
		expect(bad?.meta?.["axes"]).toBeUndefined();
		expect(bad?.meta?.["variable"]).toBeUndefined();
		expect(byFamily.get("AxesStr")?.meta?.["axes"]).toBeUndefined();
		expect(byFamily.get("AxesStr")?.meta?.["variable"]).toBeUndefined();
		const capped = byFamily.get("Many")?.meta?.["axes"];
		expect(Array.isArray(capped)).toBe(true);
		expect((capped as unknown[]).length).toBe(32);
	});

	it("skips corrupt/blank rows and falls back to theme fonts (slots, assets, weights)", async () => {
		const { db, d1 } = makeTestDb();
		// theme_definitions has UNIQUE(scope, scope_id) — scope_id must
		// differ per seeded theme.
		let themeSeq = 0;
		const insertTheme = async (fonts: string | null) =>
			(
				await d1
					.prepare(
						`INSERT INTO theme_definitions (scope, scope_id, seeds, tokens, fonts, created_at)
						 VALUES ('platform', ?, '{}', '{}', ?, 0) RETURNING id`,
					)
					.bind(`seed-${themeSeq++}`, fonts)
					.all<{ id: number }>()
			).results[0]!.id;
		const addAsset = (themeId: number, variants: string | null) =>
			run(
				d1,
				`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
				 VALUES (?, 'font', 'ready', ?, 0)`,
				[themeId, variants],
			);

		// Corrupt fonts JSON → parseJson catch → fontFamiliesOf returns [].
		const themeA = await insertTheme("{bad");
		// Slot families + blank slots + assets keys (incl. a blank key) +
		// non-array weights → weights stay off the entry.
		const themeB = await insertTheme(
			'{"families":{"sans":"Kit Sans","heading":"  ","mono":""},"weights":"nope","assets":{"Cousine":{}," ":{}}}',
		);
		// NULL fonts → fontFamiliesOf returns [].
		const themeC = await insertTheme(null);

		await addAsset(themeA, "{bad"); // corrupt variants → fallback → corrupt fonts
		await addAsset(themeB, null); // variants absent → theme-fonts path
		await addAsset(themeC, '{"family":42}'); // non-string family → fallback → null fonts
		await addAsset(themeB, '{"family":"  "}'); // blank family → fallback → dedupe

		const entries = await Effect.runPromise(
			localFontProviderAdapter.list().pipe(Effect.provideService(Db, db)),
		);
		expect(entries.map((e) => e.family).sort()).toEqual(["Cousine", "Kit Sans"]);
		expect(entries.every((e) => e.weights === undefined)).toBe(true);
	});
});
