import { Effect } from "effect";
import * as Option from "effect/Option";

import { Db } from "@ktb/db";
import { Fonts } from "@ktb/fonts";
import { PlatformAdmin } from "@ktb/platform";
import { createPluginApiRoute, getDoctorUser, getServerRuntime, runAs } from "@ktb/server-fns";

import {
	FONT_UPLOAD_EXTENSIONS,
	THEME_ASSETS_PREFIX,
	catalogFontFamilyOf,
	contentTypeForKey,
	deleteThemeAsset,
	fontFormatForExt,
	insertCatalogFontAsset,
	listUnownedFontAssets,
	parseFontWeightList,
	weightFromFileName,
} from "../assets.ts";

/**
 * POST /api/theme/catalog-fonts — fonts-catalog font upload.
 *
 * Unlike /api/theme/assets (which binds a file to ONE theme and runs
 * the theme.font job), this endpoint registers a font file in the
 * platform-wide fonts catalog: the bytes land in THEME_ASSETS_BUCKET
 * under the shared theme-assets/ prefix, a READY `theme_assets` row
 * with theme_id NULL records the family + self-host manifest in its
 * variants JSON, prior catalog rows for the same family are superseded
 * and the "local" font provider's catalog is re-synced through the
 * Fonts service — which fires the FontHooks fan-out that invalidates
 * theme font caches.
 *
 * The local adapter then catalogs the family (variants.family →
 * meta.assetId) and the managed-font cascade resolves faces from
 * variants.fontAsset — no owning theme required.
 *
 * Multipart fields: `file` (woff2/woff/ttf/otf, ≤10MB), `family`
 * (required), `weight`/`weights` (optional CSS font-weight list —
 * single value, comma/space separated list or inclusive range like
 * "400,700" or "400-700"; absent → filename hint like "Inter-Bold"/
 * "Inter_700", else 400 downstream), `providerId` (optional — must
 * name a "local" provider; absent = first enabled local provider,
 * auto-created as "Local" when none exists). The uploaded bytes are
 * probed for an `fvar` wght axis (variable fonts emit one ranged
 * @font-face) and a cmap (unicode-range download hint).
 *
 * PlatformAdmin only — same gate as every theme write.
 */

/** Same ceiling the theme asset upload route enforces. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Provider name used when the first catalog upload auto-provisions
 * the "local" adapter row. */
const LOCAL_PROVIDER_NAME = "Local";

/** Text field of a multipart form — non-string entries (e.g. a File
 * posted under a text field name) read as "". */
const formField = (form: FormData, name: string): string => {
	const value = form.get(name);
	return typeof value === "string" ? value.trim() : "";
};

const isAdmin = (user: { id: string; actorId: string; email?: string }) =>
	runAs(
		user,
		Effect.gen(function* () {
			const gate = yield* PlatformAdmin;
			return yield* gate.isAdmin({ email: user.email, userId: user.actorId });
		}),
	).catch(() => false);

type FontsService = Fonts["Service"];

type ProviderResolution =
	| { readonly ok: true; readonly providerId: number; readonly fonts: FontsService }
	| { readonly ok: false; readonly status: 400 | 404 | 500 | 503 };

/**
 * Resolve the target "local" provider inside the fonts service:
 * explicit providerId must reference a local-kind row; otherwise the
 * first enabled (then any) local provider wins, auto-created when the
 * catalog has none. Null Fonts service → 503 (fonts plugin disabled).
 */
const resolveLocalProvider = (
	user: { id: string },
	providerId: number | null,
): Promise<ProviderResolution> =>
	runAs(
		user,
		Effect.gen(function* () {
			const fontsOpt = yield* Effect.serviceOption(Fonts);
			if (Option.isNone(fontsOpt)) {
				return { ok: false, status: 503 } as const;
			}
			const fonts = fontsOpt.value;
			const providers = yield* fonts.listProviders();
			if (providerId !== null) {
				const found = providers.find((p) => p.id === providerId);
				if (found === undefined) return { ok: false, status: 404 } as const;
				if (found.kind !== "local") return { ok: false, status: 400 } as const;
				return { ok: true, providerId: found.id, fonts } as const;
			}
			const existing =
				providers.find((p) => p.kind === "local" && p.enabled) ??
				providers.find((p) => p.kind === "local");
			if (existing !== undefined) {
				return { ok: true, providerId: existing.id, fonts } as const;
			}
			const created = yield* fonts.createProvider({
				kind: "local",
				name: LOCAL_PROVIDER_NAME,
			});
			return { ok: true, providerId: created.id, fonts } as const;
		}),
	).catch(() => ({ ok: false, status: 500 }) as ProviderResolution);

export const Route = createPluginApiRoute("theme.routes")("/api/theme/catalog-fonts")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const user = await getDoctorUser();
				if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
				if (!(await isAdmin(user))) return Response.json({ error: "forbidden" }, { status: 403 });

				const contentType = request.headers.get("content-type") ?? "";
				if (!contentType.startsWith("multipart/form-data")) {
					return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
				}
				const form = await request.formData();
				const file = form.get("file");
				const family = formField(form, "family");
				if (!(file instanceof File)) {
					return Response.json({ error: "missing file" }, { status: 400 });
				}
				if (family === "") {
					return Response.json({ error: "font family required" }, { status: 400 });
				}
				// `weight` and `weights` are aliases; both accept the
				// list syntax ("400,700", "400-700") and merge.
				const weightFields = [formField(form, "weight"), formField(form, "weights")].filter(
					(v) => v !== "",
				);
				let weights: number[] | undefined;
				if (weightFields.length > 0) {
					const parsed = new Set<number>();
					for (const field of weightFields) {
						const list = parseFontWeightList(field);
						if (list === null) {
							return Response.json({ error: "invalid weight" }, { status: 400 });
						}
						for (const w of list) parsed.add(w);
					}
					weights = [...parsed].sort((a, b) => a - b);
				}
				const providerRaw = formField(form, "providerId");
				let providerId: number | null = null;
				if (providerRaw !== "") {
					const parsed = Number(providerRaw);
					if (!Number.isInteger(parsed) || parsed <= 0) {
						return Response.json({ error: "invalid providerId" }, { status: 400 });
					}
					providerId = parsed;
				}

				const bytes = await file.arrayBuffer();
				if (bytes.byteLength === 0) {
					return Response.json({ error: "empty file" }, { status: 400 });
				}
				if (bytes.byteLength > MAX_UPLOAD_BYTES) {
					return Response.json({ error: "file too large (max 10MB)" }, { status: 413 });
				}
				/* v8 ignore next -- parsed File.type is never empty */
				const mime = (file.type || "").split(";")[0]!.trim().toLowerCase();
				/* v8 ignore next -- unreachable via multipart */
				const name = file.name || "upload";
				const dot = name.lastIndexOf(".");
				const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
				if (!(FONT_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
					return Response.json({ error: "unsupported file type" }, { status: 415 });
				}
				if (mime !== "" && mime !== "application/octet-stream" && !mime.startsWith("font/")) {
					return Response.json({ error: "unsupported content type" }, { status: 415 });
				}

				// No explicit weight → filename hint ("Inter-Bold",
				// "Inter_700"); still nothing → single weightless face.
				const hinted = weights === undefined ? weightFromFileName(name) : undefined;
				const effectiveWeights = weights ?? (hinted === undefined ? undefined : [hinted]);

				// Probe the file itself: an `fvar` wght axis turns the
				// upload into a variable font (single ranged @font-face)
				// and the cmap yields a unicode-range download hint.
				// Never fatal — unparseable fonts keep discrete weights.
				// Lazy import: font-variations pulls font-metrics →
				// brotli-dec.wasm, whose eager instantiation breaks under
				// vite-plus's client-consumer test pipeline (apps/web).
				const { parseFontVariations } = await import("../font-variations.ts");
				const variation = await parseFontVariations(new Uint8Array(bytes), ext);

				const { themeAssets: bucket } = getServerRuntime();
				if (!bucket) {
					return Response.json({ error: "theme asset storage not configured" }, { status: 503 });
				}

				const provider = await resolveLocalProvider(user, providerId);
				if (!provider.ok) {
					const error =
						provider.status === 503
							? "fonts catalog not configured"
							: provider.status === 404
								? "font provider not found"
								: provider.status === 400
									? "provider is not a local font provider"
									: "font provider resolution failed";
					return Response.json({ error }, { status: provider.status });
				}

				const key = `${THEME_ASSETS_PREFIX}catalog/font/${crypto.randomUUID()}.${ext}`;
				await bucket.put(key, bytes, {
					httpMetadata: { contentType: contentTypeForKey(key) },
				});

				// One runAs: supersede prior catalog rows for this family
				// (R2 objects are content-unique — best-effort delete),
				// record the ready asset, then re-sync the provider so
				// the family lands in font_families with meta.assetId and
				// the FontHooks fan-out fires.
				const outcome = await runAs(
					user,
					Effect.gen(function* () {
						const db = yield* Db;
						const unowned = yield* Effect.promise(() => listUnownedFontAssets(db));
						for (const stale of unowned) {
							if (catalogFontFamilyOf(stale.variants) !== family) continue;
							const staleKey = stale.r2Key;
							if (staleKey !== null) {
								// R2 cleanup is best-effort — the row delete
								// below is the authoritative supersede.
								yield* Effect.promise(() => bucket.delete([staleKey]).catch(() => undefined));
							}
							yield* Effect.promise(() => deleteThemeAsset(db, stale.id));
						}
						const asset = yield* Effect.promise(() =>
							insertCatalogFontAsset(db, {
								family,
								weights: effectiveWeights,
								r2Key: key,
								format: fontFormatForExt(ext),
								weightAxis: variation?.weightAxis,
								unicodeRange: variation?.unicodeRange,
							}),
						);
						if (asset === null) {
							return yield* Effect.die(new Error("catalog font asset insert returned no row"));
						}
						const families = yield* provider.fonts.syncProvider(provider.providerId);
						const synced = families.find((f) => f.family === family);
						return { assetId: asset.id, family: synced ?? null };
					}),
				).catch(() => null);
				if (outcome === null) {
					return Response.json({ error: "font catalog sync failed" }, { status: 500 });
				}

				return Response.json({
					ok: true,
					assetId: outcome.assetId,
					providerId: provider.providerId,
					family,
					status: outcome.family?.status ?? "pending",
				});
			},
		},
	},
});
