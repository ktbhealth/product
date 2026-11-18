import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PlatformAdmin } from "@ktb/platform";
import { run, runAs, ensureSessionUser, getSessionUser } from "@ktb/server-fns";

import { presentTheme } from "./present.ts";
import { Theme } from "./theme.ts";
import {
	THEME_PREVIEW_COOKIE,
	THEME_PREVIEW_MAX_AGE,
	type ResolvedTheme,
	type ThemeBrand,
	type ThemeFontConfig,
	type ThemeResolveRequest,
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
	async (): Promise<readonly ThemeSummary[]> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const theme = yield* Theme;
				return yield* theme.list();
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as ThemeSummary[]))),
		);
	},
);

const GetInput = Schema.Struct({ id: Schema.Number });
const decodeGet = Schema.decodeUnknownSync(GetInput);

/** Full theme by id for the admin editor — seeds/fonts/brand +
 * derived tokens. Non-admins get null (the service gate denies). */
export const getThemeFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeGet(input))
	.handler(async ({ data }): Promise<ResolvedTheme | null> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const theme = yield* Theme;
				return yield* theme.get(data.id);
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null as ResolvedTheme | null))),
		);
	});

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
	.handler(async ({ data }): Promise<ThemeSummary> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const theme = yield* Theme;
				return yield* theme.publish({
					scope: data.scope,
					scopeId: data.scopeId ?? "",
					appName: data.appName ?? null,
					// Wire payloads are untyped JSON at the boundary; the
					// palette engine parses/tolerates every field.
					seeds: data.seeds as ThemeSeeds,
					fonts: (data.fonts ?? null) as ThemeFontConfig | null,
					brand: (data.brand ?? null) as ThemeBrand | null,
				});
			}),
		);
	});

const EnabledInput = Schema.Struct({
	id: Schema.Number,
	enabled: Schema.Boolean,
});
const decodeEnabled = Schema.decodeUnknownSync(EnabledInput);

export const setThemeEnabledFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeEnabled(input))
	.handler(async ({ data }): Promise<{ readonly ok: boolean }> => {
		const user = await ensureSessionUser();
		await runAs(
			user,
			Effect.flatMap(Theme, (t) => t.setEnabled(data.id, data.enabled)),
		);
		return { ok: true };
	});

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
	.handler(async ({ data }): Promise<{ readonly ok: boolean }> => {
		const user = await ensureSessionUser();
		const isAdmin = await runAs(
			user,
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
	});
