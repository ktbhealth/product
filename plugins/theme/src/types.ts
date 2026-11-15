/**
 * Wire/shared types for @ktb/theme (P-082). Everything here is plain
 * JSON — `ResolvedTheme` crosses the server-fn boundary into route
 * loaders and React props, so it must stay serializable and free of
 * Effect/drizzle imports. Client-safe: views, route components and the
 * client registry may all import this module.
 */

/** Theme scope kinds — mirrors `theme_definitions.scope`. */
export type ThemeScopeKind = "platform" | "tenant" | "portal-instance";

/**
 * What a shell asks `Theme.resolve` for. "session" is the app shell's
 * request (bound tenant → platform); portal shells name their
 * instance and get instance → tenant → platform.
 */
export type ThemeResolveRequest =
	| { readonly scope: "session" }
	| { readonly scope: "tenant" }
	| { readonly scope: "platform" }
	| { readonly scope: "portal-instance"; readonly id: string };

/** Admin-authored seed colors — CSS color strings (`oklch(...)`,
 * `#rrggbb`, `rgb(...)`); absent fields derive from `primary`. */
export interface ThemeSeeds {
	readonly primary?: string;
	readonly secondary?: string;
	readonly accent?: string;
	readonly background?: string;
	readonly foreground?: string;
	readonly destructive?: string;
	readonly radius?: string;
	/** Optional per-scheme overrides; absent values derive from the
	 * light seeds (same hues, dark-appropriate lightness). */
	readonly dark?: {
		readonly primary?: string;
		readonly secondary?: string;
		readonly accent?: string;
		readonly background?: string;
		readonly foreground?: string;
	};
}

/** Font delivery config stored on `theme_definitions.fonts`. */
export interface ThemeFontConfig {
	readonly delivery: "self-host" | "google-fonts";
	/** Family names per slot; absent slots keep the default stack. */
	readonly families?: {
		readonly sans?: string | null;
		readonly heading?: string | null;
		readonly mono?: string | null;
	};
	readonly weights?: readonly number[];
	/** Self-hosted font files (Phase 4 asset pipeline): family → URL or
	 * storage ref. Until files exist the shell skips `@font-face`
	 * gracefully. */
	readonly assets?: Readonly<Record<string, string>>;
}

/** Brand asset refs stored on `theme_definitions.brand`. Values are
 * URLs today; Phase 4 swaps storage refs for derived asset URLs. */
export interface ThemeBrand {
	readonly appName?: string | null;
	readonly logoLight?: string | null;
	readonly logoDark?: string | null;
	readonly wordmark?: string | null;
	readonly favicon?: string | null;
	readonly ogImage?: string | null;
}

/** Full token maps keyed by CSS custom-property name. */
export interface ThemeTokens {
	readonly light: Readonly<Record<string, string>>;
	readonly dark: Readonly<Record<string, string>>;
}

/**
 * A theme resolved for one request scope — what shells consume.
 * `preview` is set (never persisted) when the row was selected through
 * the admin `ktb-theme-preview` cookie.
 */
export interface ResolvedTheme {
	readonly id: number;
	readonly scope: ThemeScopeKind;
	readonly scopeId: string;
	readonly appName: string | null;
	readonly seeds: ThemeSeeds;
	readonly tokens: ThemeTokens;
	/** `:root`/`.dark` CSS custom-property overrides (+ font vars). */
	readonly styleCss: string;
	readonly fonts: ThemeFontConfig | null;
	/** Google Fonts stylesheet hrefs — empty unless delivery opts in. */
	readonly fontLinks: readonly string[];
	/** `@font-face` rules for self-hosted fonts — "" until Phase 4
	 * asset files exist. */
	readonly fontFaceCss: string;
	readonly brand: ThemeBrand | null;
	readonly preview?: boolean;
}

/** Compact row shape the admin list/header popover consumes. */
export interface ThemeSummary {
	readonly id: number;
	readonly scope: ThemeScopeKind;
	readonly scopeId: string;
	readonly appName: string | null;
	readonly enabled: boolean;
	readonly version: number;
}

/** Cookie carrying the admin theme preview selection (P-082/PL-006):
 * httpOnly, short-lived, honored by every shell loader only after the
 * PlatformAdmin gate. Value is a `theme_definitions.id`. */
export const THEME_PREVIEW_COOKIE = "ktb-theme-preview";

/** Preview cookie lifetime — long enough for an admin session, short
 * enough that a forgotten preview self-expires. */
export const THEME_PREVIEW_MAX_AGE = 60 * 60 * 8;
