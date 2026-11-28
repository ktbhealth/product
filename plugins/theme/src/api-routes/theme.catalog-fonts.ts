import { Effect } from "effect";
import * as Option from "effect/Option";

import { Db } from "@ktb/db";
import { Fonts } from "@ktb/fonts";
import {
	bestEffortDelete,
	checkUpload,
	putStoredObject,
	storedObjectKey,
	type UploadPolicy,
} from "@ktb/media";
import { PlatformAdmin } from "@ktb/platform";
import { createPluginApiRoute, getDoctorUser, getServerRuntime, runAs } from "@ktb/server-fns";

import {
	FONT_UPLOAD_EXTENSIONS,
	THEME_ASSETS_PREFIX,
	catalogFontFamilyOf,
	catalogFontSubsetKeysOf,
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
 * probed for an `fvar` table (the `wght` axis turns the upload into
 * a variable font with one ranged @font-face; other axes are stamped
 * as `axes` metadata — `wdth` becomes `font-stretch` at present time)
 * and a cmap (unicode-range download hint).
 *
 * PlatformAdmin only — same gate as every theme write.
 */

/** Same ceiling the theme asset upload route enforces. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Catalog fonts are font files only — extension + declared-MIME
 * prefix gate; the size/status contract is @ktb/media's. */
const FONT_UPLOAD_POLICY: UploadPolicy = {
	maxBytes: MAX_UPLOAD_BYTES,
	extensions: FONT_UPLOAD_EXTENSIONS,
	mimePrefixes: ["font/"],
};

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

				// Shared upload contract (@ktb/media): empty → 400,
				// oversize → 413, extension/MIME gates → 415.
				const checked = checkUpload(
					{
						bytes: await file.arrayBuffer(),
						fileName: file.name,
						mime: file.type,
					},
					FONT_UPLOAD_POLICY,
				);
				if (!checked.ok) {
					return Response.json({ error: checked.error }, { status: checked.status });
				}
				const bytes = checked.bytes;
				const name = file.name;
				const ext = checked.ext;

				// No explicit weight → filename hint ("Inter-Bold",
				// "Inter_700"); still nothing → single weightless face.
				const hinted = weights === undefined ? weightFromFileName(name) : undefined;
				const effectiveWeights = weights ?? (hinted === undefined ? undefined : [hinted]);

				// Probe the file itself: an `fvar` wght axis turns the
				// upload into a variable font (single ranged @font-face),
				// other fvar axes ride `axes` metadata and the cmap
				// yields a unicode-range download hint.
				// Never fatal — unparseable fonts keep discrete weights.
				// Lazy import: font-variations pulls font-metrics →
				// brotli-dec.wasm, whose eager instantiation breaks under
				// vite-plus's client-consumer test pipeline (apps/web).
				const { parseFontVariations } = await import("../font-variations.ts");
				const variation = await parseFontVariations(new Uint8Array(bytes), ext);
				// Real font subsetting (per-charset siblings) — same
				// lazy-import rationale as font-variations (hb-subset.wasm),
				// and just as non-fatal: null keeps the unicode-range-only
				// path.
				const { subsetCatalogFont } = await import("../font-subset.ts");
				const subsetPlan = await subsetCatalogFont({
					bytes: new Uint8Array(bytes),
					variation,
				});

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

				const key = storedObjectKey(THEME_ASSETS_PREFIX, ["catalog", "font"], ext);
				await putStoredObject(bucket, key, bytes);

				// Subset siblings (one per covered charset) — stored next
				// to the original; insertCatalogFontAsset emits the
				// disjoint subset/full @font-face sets when present.
				const subsetEntries: {
					r2Key: string;
					format: string;
					unicodeRange: string;
				}[] = [];
				if (subsetPlan !== null) {
					const stem = key.slice(0, key.length - ext.length - 1);
					for (const file of subsetPlan.subsets) {
						const subsetKey = `${stem}-${file.charset}.${file.ext}`;
						await putStoredObject(bucket, subsetKey, file.data);
						subsetEntries.push({
							r2Key: subsetKey,
							format: file.format,
							unicodeRange: file.unicodeRange,
						});
					}
				}

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
							// R2 cleanup is best-effort — the row delete
							// below is the authoritative supersede. The
							// subset sibling keys ride variants.subsetKeys
							// (plus the legacy singular subsetKey).
							const staleKeys = [stale.r2Key, ...catalogFontSubsetKeysOf(stale.variants)].filter(
								(k): k is string => k !== null,
							);
							if (staleKeys.length > 0) {
								yield* Effect.promise(() => bestEffortDelete(bucket, staleKeys));
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
								axes: variation?.axes,
								subsets: subsetEntries.length === 0 ? undefined : subsetEntries,
								subsetFullUnicodeRange: subsetPlan?.fullUnicodeRange,
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
