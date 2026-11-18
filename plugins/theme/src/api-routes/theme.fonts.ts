import { Effect } from "effect";
import * as Schema from "effect/Schema";

import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";
import { createPluginApiRoute, getDoctorUser, getServerRuntime, runAs } from "@ktb/server-fns";

import {
	THEME_ASSETS_PREFIX,
	THEME_FONT_JOB_KIND,
	decodeThemeFontJob,
	insertThemeAsset,
} from "../assets.ts";
import { getThemeById } from "../theme.ts";
import type { ThemeFontSlot } from "../types.ts";

/**
 * POST /api/theme/fonts — enqueue a `theme.font` job with
 * source:"google": the consumer downloads the family's woff2 files
 * (plus a TTF metrics probe) from Google Fonts into
 * THEME_ASSETS_BUCKET and writes the self-host @font-face manifest.
 * PlatformAdmin only; no bytes cross this route — the worker fetches
 * fonts.googleapis.com server-side in the queue consumer.
 *
 * Body (JSON): { themeId, family, slot?, weights? }.
 */

const BodySchema = Schema.Struct({
	themeId: Schema.Number,
	family: Schema.String,
	slot: Schema.optional(Schema.String),
	weights: Schema.optional(Schema.Array(Schema.Number)),
});
const decodeBody = Schema.decodeUnknownSync(BodySchema);

const FONT_SLOTS: readonly ThemeFontSlot[] = ["sans", "heading", "mono"];

export const Route = createPluginApiRoute("theme.routes")("/api/theme/fonts")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const user = await getDoctorUser();
				if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
				const isAdmin = await runAs(
					user,
					Effect.gen(function* () {
						const gate = yield* PlatformAdmin;
						return yield* gate.isAdmin({ email: user.email, userId: user.actorId });
					}),
				).catch(() => false);
				if (!isAdmin) return Response.json({ error: "forbidden" }, { status: 403 });

				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ error: "invalid JSON body" }, { status: 400 });
				}
				const parsed = (() => {
					try {
						return decodeBody(body);
					} catch {
						return null;
					}
				})();
				if (parsed === null) return Response.json({ error: "invalid body" }, { status: 400 });
				const themeId = parsed.themeId;
				const family = parsed.family.trim();
				if (!Number.isInteger(themeId) || themeId <= 0 || family === "") {
					return Response.json({ error: "invalid themeId or family" }, { status: 400 });
				}
				const slotRaw = parsed.slot ?? "sans";
				const slot = (FONT_SLOTS as readonly string[]).includes(slotRaw)
					? (slotRaw as ThemeFontSlot)
					: null;
				if (slot === null) return Response.json({ error: "invalid slot" }, { status: 400 });
				const weights = parsed.weights ?? [400, 500, 600, 700];
				if (
					weights.length === 0 ||
					weights.some((w) => !Number.isInteger(w) || w < 100 || w > 900)
				) {
					return Response.json({ error: "invalid weights" }, { status: 400 });
				}

				const theme = await runAs(
					user,
					Effect.gen(function* () {
						const db = yield* Db;
						return yield* Effect.promise(() => getThemeById(db, themeId));
					}),
				).catch(() => null);
				if (theme === null) return Response.json({ error: "theme not found" }, { status: 404 });

				const { themeJobs } = getServerRuntime();
				if (!themeJobs) {
					return Response.json({ error: "theme job queue not configured" }, { status: 503 });
				}

				// Google-sourced fonts have no single original key — the row
				// tracks the family under the shared prefix for bookkeeping.
				const r2Key = `${THEME_ASSETS_PREFIX}${themeId}/font/${family.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
				const asset = await runAs(
					user,
					Effect.gen(function* () {
						const db = yield* Db;
						return yield* Effect.promise(() =>
							insertThemeAsset(db, { themeId, kind: "font", r2Key }),
						);
					}),
				).catch(() => null);
				if (asset === null) {
					return Response.json({ error: "failed to record asset" }, { status: 500 });
				}

				try {
					const payload = decodeThemeFontJob({
						assetId: asset.id,
						themeId,
						family,
						slot,
						source: "google",
						weights,
					});
					await themeJobs.enqueue(THEME_FONT_JOB_KIND, payload, {
						payloadRef: `theme-asset:${asset.id}`,
					});
				} catch {
					return Response.json({ error: "font job queue unavailable" }, { status: 502 });
				}
				return Response.json({ ok: true, assetId: asset.id, status: "queued" });
			},
		},
	},
});
