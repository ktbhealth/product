import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { FontCatalog, type FontCatalogFamily } from "@ktb/fonts/catalog";
import { PlatformAdmin } from "@ktb/platform";
import { forbiddenTo, getSessionUser, run, runAs, sessionHandler } from "@ktb/server-fns";

import { presentTheme, themeFontAxes } from "./present.ts";
import { Theme } from "./theme.ts";
import {
	THEME_PREVIEW_COOKIE,
	THEME_PREVIEW_MAX_AGE,
	type ResolvedTheme,
	type ThemeBrand,
	type ThemeFontConfig,
	type ThemeFontSourceOption,
	type ThemeResolveRequest,
	type ThemeAssetSummary,
	type ThemeSeeds,
	type ThemeSummary,
} from "./types.ts";

/**
 * Theme server functions (P-082). `themeScopeFn` is the per-shell
 * resolution seam route loaders call; the rest are the admin surface
 * behind /platform/theme and the header popover. The
 * `ktb-theme-preview` cookie is honored ONLY for PlatformAdmin
 * sessions — it is checked after the admin gate inside the handler,
 * so non-admin requests can never steer branding.
 */

const ScopeInput = Schema.Union([
	Schema.Struct({ scope: Schema.Literal("session") }),
	Schema.Struct({ scope: Schema.Literal("tenant") }),
	Schema.Struct({ scope: Schema.Literal("platform") }),
	Schema.Struct({
		scope: Schema.Literal("portal-instance"),
		id: Schema.String,
	}),
]);
const decodeScope = Schema.decodeUnknownSync(ScopeInput);

/** Cookie read/write helpers — dynamically imported so this module
 * stays loadable outside a request context (tests, build). */
const cookieApi = async () => {
	try {
		return await import("@tanstack/react-start/server");
	} catch {
		return null;
	}
};

const readPreviewId = async (): Promise<number | null> => {
	const api = await cookieApi();
	if (api === null) return null;
	try {
		const raw = api.getCookie?.(THEME_PREVIEW_COOKIE);
		const id = typeof raw === "string" ? Number(raw) : NaN;
		return Number.isInteger(id) && id > 0 ? id : null;
	} catch {
		return null;
	}
};

/**
 * Resolve the theme for a shell scope. Anonymous callers resolve too
 * (public branding) — `run` binds no Principal; `runAs` binds the
 * session user + tenant selector so tenant-scoped themes apply.
 * Admin preview override applies last and marks `preview: true`.
 */
export const themeScopeFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeScope(input) as ThemeResolveRequest)
	.handler(async ({ data: request }): Promise<ResolvedTheme | null> => {
		const user = await getSessionUser();
		const effect = Effect.gen(function* () {
			const theme = yield* Theme;
			return yield* theme.resolve(request);
		});
		const resolved = user === null ? await run(effect) : await runAs(user, effect);
		if (user === null) return resolved;
		// Preview override — PlatformAdmin only, checked per request.
		const isAdmin = await runAs(
			user,
			Effect.gen(function* () {
				const gate = yield* PlatformAdmin;
				return yield* gate.isAdmin({ email: user.email, userId: user.id });
			}),
		).catch(() => false);
		if (!isAdmin) return resolved;
		const previewId = await readPreviewId();
		if (previewId === null) return resolved;
		return (await previewRow(user, previewId)) ?? resolved;
	});

/** Load + present the raw preview row (admin path only). */
const previewRow = async (
	user: { readonly id: string; readonly email?: string },
	id: number,
): Promise<ResolvedTheme | null> => {
	const row = await runAs(
		user,
		Effect.gen(function* () {
			const theme = yield* Theme;
			return yield* theme.previewRow(id);
		}),
	).catch(() => null);
	return row === null ? null : presentTheme(row, { preview: true });
};

/** Admin list for the /platform/theme page and the header popover.
 * Non-admins get an empty list (the page guard 404s them anyway). */
export const listThemesFn = createServerFn({ method: "GET" }).handler(
	sessionHandler(async ({ run }): Promise<readonly ThemeSummary[]> => {
		return run(
			Effect.gen(function* () {
				const theme = yield* Theme;
				return yield* theme.list();
			}).pipe(forbiddenTo([] as ThemeSummary[])),
		);
	}),
);

const GetInput = Schema.Struct({ id: Schema.Number });
const decodeGet = Schema.decodeUnknownSync(GetInput);

const AssetsInput = Schema.Struct({ themeId: Schema.Number });
const decodeAssets = Schema.decodeUnknownSync(AssetsInput);

/** Upload rows for one theme — the editor's Assets tab. Non-admins
 * get an empty list (the service gate denies). */
export const listThemeAssetsFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeAssets(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<readonly ThemeAssetSummary[]> => {
			return run(
				Effect.gen(function* () {
					const theme = yield* Theme;
					return yield* theme.listAssets(data.themeId);
				}).pipe(forbiddenTo([] as ThemeAssetSummary[])),
			);
		}),
	);

/** Full theme by id for the admin editor — seeds/fonts/brand +
 * derived tokens. Non-admins get null (the service gate denies). */
export const getThemeFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeGet(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<ResolvedTheme | null> => {
			return run(
				Effect.gen(function* () {
					const theme = yield* Theme;
					return yield* theme.get(data.id);
				}).pipe(forbiddenTo(null as ResolvedTheme | null)),
			);
		}),
	);

/**
 * Ready managed font families for the editor's per-slot source
 * picker — the fonts plugin's open catalog port (theme.services
 * optionalDeps fonts.services), admin-gated like the rest of the
 * surface. Degrades to [] when the fonts plugin is absent, when the
 * gate denies, or when the catalog read fails — the picker simply
 * hides and free-form families keep working.
 */
export const listThemeFontSourcesFn = createServerFn({ method: "GET" }).handler(
	sessionHandler(async ({ run }): Promise<readonly ThemeFontSourceOption[]> => {
		return run(
			Effect.gen(function* () {
				const gate = yield* PlatformAdmin;
				yield* gate.requireAdmin();
				const catalog = yield* Effect.serviceOption(FontCatalog);
				if (Option.isNone(catalog)) {
					return [] as readonly ThemeFontSourceOption[];
				}
				const rows = yield* catalog.value
					.list()
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning("font catalog read failed", cause).pipe(
								Effect.as([] as readonly FontCatalogFamily[]),
							),
						),
					);
				return rows
					.filter((row) => row.status === "ready")
					.map((row) => {
						// Catalog `meta.axes` (stamped by provider syncs — the
						// "local" adapter records the uploaded font's fvar
						// axes) lets the editor offer per-axis pin inputs.
						// Revalidated here: meta is stored JSON.
						const axes = themeFontAxes(row.meta?.["axes"]);
						return {
							providerId: row.providerId,
							providerName: row.providerName,
							providerKind: row.kind,
							family: row.family,
							weights: [...row.weights],
							...(axes.length === 0 ? {} : { axes }),
						};
					});
			}).pipe(forbiddenTo([] as readonly ThemeFontSourceOption[])),
		);
	}),
);

const PublishInput = Schema.Struct({
	id: Schema.optional(Schema.Number),
	scope: Schema.Literals(["platform", "tenant", "portal-instance"]),
	scopeId: Schema.optional(Schema.String),
	appName: Schema.optional(Schema.NullOr(Schema.String)),
	seeds: Schema.Record(Schema.String, Schema.Unknown),
	fonts: Schema.optional(Schema.NullOr(Schema.Unknown)),
	brand: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
const decodePublish = Schema.decodeUnknownSync(PublishInput);

/** Publish (upsert) a theme definition — PlatformAdmin inside the
 * service. Seeds/fonts/brand arrive as JSON; the palette engine
 * tolerates and corrects invalid color strings. */
export const publishThemeFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodePublish(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<ThemeSummary> => {
			return run(
				Effect.gen(function* () {
					const theme = yield* Theme;
					return yield* theme.publish({
						id: data.id,
						scope: data.scope,
						scopeId: data.scopeId ?? "",
						appName: data.appName,
						// Wire payloads are untyped JSON at the boundary; the
						// palette engine parses/tolerates every field. Undefined
						// optional columns preserve stored values on update.
						seeds: data.seeds as ThemeSeeds,
						fonts: data.fonts === undefined ? undefined : (data.fonts as ThemeFontConfig | null),
						brand: data.brand === undefined ? undefined : (data.brand as ThemeBrand | null),
					});
				}),
			);
		}),
	);

const EnabledInput = Schema.Struct({
	id: Schema.Number,
	enabled: Schema.Boolean,
});
const decodeEnabled = Schema.decodeUnknownSync(EnabledInput);

export const setThemeEnabledFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeEnabled(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<{ readonly ok: boolean }> => {
			await run(Effect.flatMap(Theme, (t) => t.setEnabled(data.id, data.enabled)));
			return { ok: true };
		}),
	);

/** Move the is_main flag to `id` — the admin "Set main" row action.
 * Admin-gated inside the service. */
export const setThemeMainFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeGet(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<{ readonly ok: boolean }> => {
			await run(Effect.flatMap(Theme, (t) => t.setMain(data.id)));
			return { ok: true };
		}),
	);

/** Hard-delete a theme row — the editor discards untouched auto-created
 * drafts through this. Admin-gated inside the service. */
export const deleteThemeFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeGet(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<{ readonly ok: boolean }> => {
			await run(Effect.flatMap(Theme, (t) => t.remove(data.id)));
			return { ok: true };
		}),
	);

const PreviewInput = Schema.Struct({
	themeId: Schema.NullOr(Schema.Number),
});
const decodePreview = Schema.decodeUnknownSync(PreviewInput);

/**
 * Set or clear the `ktb-theme-preview` cookie (httpOnly, path=/,
 * 8h). PlatformAdmin only — the gate runs before any cookie write so
 * a non-admin can never stamp a preview selection. Callers reload the
 * document afterwards so every shell loader re-resolves.
 */
export const setThemePreviewFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodePreview(input))
	.handler(
		sessionHandler(async ({ data, user, run }): Promise<{ readonly ok: boolean }> => {
			const isAdmin = await run(
				Effect.gen(function* () {
					const gate = yield* PlatformAdmin;
					return yield* gate.isAdmin({ email: user.email, userId: user.id });
				}),
			);
			if (!isAdmin) return { ok: false };
			const api = await cookieApi();
			if (api === null) return { ok: false };
			try {
				if (data.themeId === null) {
					api.deleteCookie?.(THEME_PREVIEW_COOKIE, { path: "/" });
				} else {
					api.setCookie?.(THEME_PREVIEW_COOKIE, String(data.themeId), {
						path: "/",
						httpOnly: true,
						sameSite: "lax",
						secure: true,
						maxAge: THEME_PREVIEW_MAX_AGE,
					});
				}
				return { ok: true };
			} catch {
				return { ok: false };
			}
		}),
	);
