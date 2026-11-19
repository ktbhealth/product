import type { ComponentType, ReactNode } from "react";
import type { VirtualRouteNode } from "@tanstack/virtual-file-routes";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

import type { ForbiddenContributions, PluginBase } from "./core.ts";

/** One entry in a plugin's portal sidebar. `icon` is any
 * component accepting `className` (lucide icons qualify); the host
 * shell sizes it via `[&_svg]` rules. `exact` marks index-style items
 * that must not stay active on descendant routes. */
export interface PanelSidebarItem {
	readonly to: string;
	readonly label: string;
	readonly icon?: ComponentType<{ className?: string }>;
	readonly exact?: boolean;
	/** Sidebar group label — items cluster under it in declaration
	 * (topo) order; groups order by first appearance. Defaults to a
	 * single unlabeled group. */
	readonly group?: string;
}

/** One entry in a plugin's console top-bar right side. `component` is a
 * self-contained React component (icon button, popover, badge…) rendered
 * by the shell; data reaches it via plugin-owned contexts/props the host
 * injects — plugins cannot import apps or server fns. */
export interface PanelHeaderAction {
	readonly id: string;
	/** The host injects the active UI locale plus the route-scoped DB
	 * catalog slice (PL-008) — header actions are self-contained
	 * components that cannot import the host's i18n runtime, so they
	 * resolve their own copy from them. */
	readonly component: ComponentType<{
		readonly locale?: string;
		readonly i18n?: PageI18nSlice;
	}>;
}

/**
 * Feature plugin contract. The host (apps/web) registers plugins in a
 * static list; each plugin object contributes EXACTLY ONE kind of
 * contribution — every union member below forbids the other
 * contribution keys (`?: never`), so a multi-concern plugin object is a
 * compile error. A plugin that only anchors dependency edges (e.g.
 * `platform.admin`, `platform.panel`) is a MarkerPlugin: no dedicated
 * contribution field — it may still carry generic `contributions`
 * entries (P-070) for kinds without a typed field. Everything is
 * statically imported — workerd can't do
 * dynamic module loading, and static keeps 100% type safety.
 *
 * Consumers read a contribution with optional access (`p.landingNav ?? []`) —
 * forbidden keys are declared `?: never`, so `"<field>" in p` does not
 * discriminate the union.
 */

/** Host-injected context handed to `pages` page components (P-059): the
 * discovered plugin registry, so contributed pages can render
 * plugin-aware views without importing the app host, plus the active
 * UI locale so views resolve their own localized copy, plus the
 * session user when one exists (app pages may be public). */
/** Resolved DB-catalog slice injected into page contexts (PL-008):
 * `namespace.key` → MF1 template for the active locale + scope chain. */
export interface PageI18nSlice {
	readonly locale: string;
	readonly catalog: Readonly<Record<string, string>>;
	/** Enabled locale codes for the language picker (host payloads only). */
	readonly enabledLocales?: readonly string[];
}

export interface PageContext {
	readonly plugins: readonly Plugin[];
	readonly locale: string;
	readonly user?: ChromeUser | null;
	/** Present when the host wired i18n into loader data; absent on
	 * surfaces without it (views keep their code catalogs as
	 * fallback). */
	readonly i18n?: PageI18nSlice;
	/** Enabled plugin-id set for surfaces that must evaluate
	 * plugin-contributed chrome gates (e.g. the /login tile picker).
	 * `plugins` stays the registry the host chose for the surface
	 * (enabled-filtered on app pages, full on console pages); this is
	 * the raw enablement snapshot those gates check `requires` against. */
	readonly pluginStates?: { readonly enabled: readonly string[] };
}

/** Host-injected context handed to every panel page component — the
 * discovered plugin registry, so console pages can render
 * plugin-aware views without importing the app host, plus the active
 * UI locale so views resolve their own localized copy. Same payload
 * as `PageContext` (P-059 unified the two). */
export interface PanelPageContext extends PageContext {}

/** Route facts every page lifecycle hook receives. `path` is the
 * resolved request path (for wildcard descriptors, the concrete path —
 * not the `/*` key); `search` is the parsed search object; `params`
 * are route params; `location` mirrors TanStack's location shape;
 * `context` is the host router context when available. */
export interface PageHookContext {
	readonly path: string;
	readonly params: Readonly<Record<string, string | undefined>>;
	readonly search: Readonly<Record<string, unknown>>;
	readonly location: {
		readonly pathname: string;
		readonly searchStr: string;
		readonly href: string;
	};
	readonly context?: unknown;
}

/** Page-level search validation. The host calls this after resolving
 * the winning descriptor because one splat route cannot declare a
 * different TanStack `validateSearch` per page. Return the validated
 * search object, or void to keep the input. */
export type PageValidateSearch = (input: {
	readonly search: Readonly<Record<string, unknown>>;
	readonly path: string;
	readonly params: Readonly<Record<string, string | undefined>>;
}) => Readonly<Record<string, unknown>> | void;

/** Control result a page `beforeLoad` may return: redirect, explicit
 * not-found, or a context object merged into route context. Throwing
 * is also allowed — hosts pass thrown values through unchanged. */
export type PageBeforeLoadResult =
	| { readonly redirectTo: string; readonly replace?: boolean }
	| { readonly notFound: true }
	| Readonly<Record<string, unknown>>
	| void;

export type PageBeforeLoad = (
	ctx: PageHookContext,
) => PageBeforeLoadResult | Promise<PageBeforeLoadResult>;

/** Minimal head payload a page hook may return. The host merges it
 * with shell/route metadata; adapter code casts to TanStack's head
 * types so kernel stays router-neutral. */
export interface PageHeadContent {
	readonly meta?: ReadonlyArray<Record<string, unknown>>;
	readonly links?: ReadonlyArray<Record<string, unknown>>;
	readonly scripts?: ReadonlyArray<Record<string, unknown>>;
	readonly styles?: ReadonlyArray<Record<string, unknown>>;
}

export interface PageHeadContext extends PageHookContext {
	readonly loaderData?: unknown;
	readonly matches?: readonly unknown[];
	/** Route-scoped i18n slice when the host resolved one before head
	 * generation (usually from the root match's loader data). */
	readonly i18n?: PageI18nSlice;
}

export type PageHead = (ctx: PageHeadContext) => PageHeadContent | void;

/** Shared optional lifecycle hooks for page descriptors. Plain
 * isomorphic functions only — they run on server and client
 * dispatchers; `guard`/`loader` remain server-only Effects. */
export interface PageLifecycle {
	readonly validateSearch?: PageValidateSearch;
	readonly beforeLoad?: PageBeforeLoad;
	readonly head?: PageHead;
}

/** A console page contributed via `panel.pages` (P-050): the host
 * mounts a generic dispatcher at `path` under /platform, runs `loader`
 * as an Effect under the session principal (`runAs` binds Principal +
 * Tenant — authz stays inside the domain services), and renders
 * `component` with the result as `data`. `loader` runs on every
 * navigation, like a route loader; pages without one get `data: null`.
 * `path` is the full route path — "/platform" itself or any nested
 * "/platform/<segment>[/<segment>…]"; the host's splat route matches
 * all of them and looks the descriptor up by exact path.
 * `guard` (optional) is an Effect run server-side under the same
 * principal BEFORE `loader`; a `false` result makes the host treat the
 * page as not found — use it for feature flags / entitlement checks.
 * Hard authorization stays inside the loader/service layer.
 * `guard`/`loader` receive the request path — exact-path pages ignore
 * it; wildcard pages (see `Page.path`) need it to resolve their data. */
export interface PanelPage extends PageLifecycle {
	readonly id: string;
	readonly path: string;
	readonly component: ComponentType<{ data: unknown; ctx: PanelPageContext }>;
	readonly loader?: (path: string) => Effect.Effect<unknown, unknown, unknown>;
	readonly guard?: (path: string) => Effect.Effect<boolean, unknown, unknown>;
}

/** A page contributed via `pages` (P-059): the host mounts a generic
 * splat dispatcher that resolves `path` against the registry, runs
 * `guard` then `loader` as Effects (server-side, under the session
 * principal when one exists — app pages may be public), and renders
 * `component` with the result as `data`. `path` is the full absolute
 * route path ("/about", "/platform/x", …); the host looks descriptors
 * up by exact path. `guard` (optional) runs BEFORE `loader`; a `false`
 * result or a failure makes the host treat the page as not found —
 * use it for feature flags / entitlement checks. Hard authorization
 * stays inside the loader/service layer.
 * `context` selects the shell: "portal" pages dispatch under a portal
 * instance (/platform, /portal/<id>) behind the audience gate (portal
 * chrome); "app" pages render inside the marketing shell and may be
 * public. Defaults to "portal" for portal-instance paths and "app"
 * otherwise — an app-context page claiming a portal path is a contract
 * violation (the host warns and ignores it).
 * `path` may also end in "/*" to claim a whole path subtree (same
 * syntax as chrome `when` paths): exact-path descriptors always win;
 * among wildcard entries the LONGEST matching base wins, ties break by
 * plugin topo order. This is the seam runtime/DB-driven pages use —
 * one wildcard descriptor serves every path its loader resolves (e.g.
 * the custom-pages plugin's "/*" backed by a DB lookup). `guard` and
 * `loader` receive the REQUESTED path so the descriptor can resolve
 * which entity the path names; signatures taking no argument remain
 * valid (the argument is simply ignored). `loader` may also declare an
 * optional second `search` parameter receiving the request's parsed
 * URL search params (undefined when the host route supplies none) —
 * pages that validate URL params (e.g. schema-bound custom pages)
 * clean them inside the loader so SSR and client navigations share
 * the result; `(path) =>` loaders stay valid and simply ignore it. */
export interface Page extends PageLifecycle {
	readonly id: string;
	readonly path: string;
	readonly component: ComponentType<{ data: unknown; ctx: PageContext }>;
	readonly loader?: (
		path: string,
		search?: Record<string, unknown>,
	) => Effect.Effect<unknown, unknown, unknown>;
	readonly guard?: (path: string) => Effect.Effect<boolean, unknown, unknown>;
	readonly context?: "app" | "portal";
}

/** Host-injected context for router boundary pages (404/error): the
 * page context plus the pathname that triggered the boundary. */
export interface BoundaryContext extends PageContext {
	readonly pathname: string;
}

/** Props the host injects into a contributed not-found page. `actions`
 * are host-rendered chrome nodes collected from the
 * `app.notFound.actions` region, so the boundary plugin never
 * hardcodes feature links. */
export interface BoundaryPageProps {
	readonly ctx: BoundaryContext;
	readonly actions?: ReactNode;
}

/** Props the host injects into a contributed error page. */
export interface ErrorBoundaryPageProps extends BoundaryPageProps {
	readonly error: unknown;
	readonly reset: () => void;
}

/** One router-boundary contribution. `notFound` renders when no route
 * matches; `error` renders when a route loader/component throws. The
 * host adapts TanStack's ErrorComponentProps into these framework-
 * neutral props. */
export type BoundaryContribution =
	| {
			readonly kind: "notFound";
			readonly component: ComponentType<BoundaryPageProps>;
	  }
	| {
			readonly kind: "error";
			readonly component: ComponentType<ErrorBoundaryPageProps>;
	  };

/** Replaceable router-boundary pages (404/error). Multiple plugins may
 * contribute boundaries; for each kind the host selects the
 * highest-`priority` enabled contribution, ties breaking by plugin topo
 * order. These are normal plugins — not system — so a better third-
 * party boundary can replace ours with `priority: "high"` or disable it. */
export interface BoundariesPlugin extends PluginBase, ForbiddenContributions<"boundaries"> {
	readonly boundaries: readonly BoundaryContribution[];
}

/** Dependency anchor only — no dedicated contribution field (generic
 * `contributions` entries are still allowed, P-070). */
export interface MarkerPlugin extends PluginBase, ForbiddenContributions<never> {}

/** Drizzle table slice composed into @ktb/db/schema. */
export interface TablesPlugin extends PluginBase, ForbiddenContributions<"tables"> {
	readonly tables: Record<string, SQLiteTable>;
}

/** Effect layers: services the plugin needs/provides at runtime.
 * Heterogeneous by design: each plugin provides its own services.
 * Type-erased to Layer.Any; the host verifies requirements at
 * ManagedRuntime composition. */
export interface ServicesPlugin extends PluginBase, ForbiddenContributions<"services"> {
	readonly services: Layer.Any;
}

/** Route subtree composed into the host's virtualRouteConfig. */
export interface RoutesPlugin extends PluginBase, ForbiddenContributions<"routes"> {
	readonly routes: readonly VirtualRouteNode[];
}

/** A link contributed to a chrome region (header nav). */
export interface LandingLink {
	readonly to: string;
	readonly label: string;
}

/** One block in a footer region: optional heading + link list. */
export interface LandingFooterBlock {
	readonly heading?: string;
	readonly links: ReadonlyArray<LandingLink>;
}

/** Declarative per-page visibility for a chrome contribution — data,
 * not functions, so the registries stay serializable-clean and rules
 * stay unit-testable. `paths`/`exceptPaths` entries match the current
 * pathname exactly or as a `prefix/*` subtree (the bare prefix itself
 * counts); `exceptPaths` wins over `paths`. Absent `paths` means "every
 * page". `minDoctorProfiles` is the clinical request-state condition:
 * the contribution only renders when the session account's doctor-
 * profile directory holds at least that many entries — fails closed
 * (hidden) when the host resolves no user or no count. */
export interface ChromeWhen {
	readonly paths?: readonly string[];
	readonly exceptPaths?: readonly string[];
	readonly minDoctorProfiles?: number;
}

/** A named portal instance (P-081): a sidebar-shell surface scoped to
 * an audience — the platform admin console, a clinician portal, a
 * translator portal, … `id` is the instance id chrome contributions
 * and audience rules refer to; `basePath` is where the instance's
 * pages live ("/platform", "/portal/doctor", …); `label` is the
 * shell/switcher display string; `icon` an optional brand mark;
 * `audience` names the audience RULE the portal gate checks (see
 * `PortalAudience` in @ktb/portal) — absent means `PORTAL_AUDIENCE_MEMBER`
 * (any signed-in user). `subject` selects which identity page loaders
 * run under: absent/"session" binds the raw session account;
 * "doctor" binds the doctor-resolved acting user (delegation-aware —
 * `Principal.userId` is the acting doctor's id, `actorId` the signed-in
 * account), which owner-scoped clinical services require. */
export interface PortalInstance {
	readonly id: string;
	readonly basePath: string;
	readonly label: string;
	readonly icon?: ComponentType<{ readonly className?: string }>;
	readonly audience?: string;
	readonly subject?: "session" | "doctor";
	/** Pinned UI locale for this portal (PL-008 Phase 6) — when set it
	 * overrides the visitor's locale cookie for all copy under the
	 * portal (e.g. a clinic portal pinned to pt-BR). */
	readonly locale?: string;
}

/** Portal instance contributions: the portals a plugin ships. The
 * host mounts a shell per instance — `/platform` for the platform
 * instance, `/portal/<id>/*` for namespaced ones — and scopes
 * `portal.*` chrome regions and page dispatch to it. */
export interface PortalsPlugin extends PluginBase, ForbiddenContributions<"portals"> {
	readonly portals: ReadonlyArray<PortalInstance>;
}

/** Session user shape handed to chrome components — structurally
 * compatible with `SessionUser` (@ktb/auth) without a kernel→auth dep. */
export interface ChromeUser {
	readonly id: string;
	readonly email: string;
	readonly name?: string | null;
	/** True for an account with no doctor side (a patient account) — chrome
	 * hides doctor-only entries for it. Absent means a regular account. */
	readonly patientOnly?: boolean;
	/** True when the session passes the console gate (same check the
	 * /platform beforeLoad runs) — chrome shows the console entry. */
	readonly platformAdmin?: boolean;
	/**
	 * The account's clinical standing from the doctor-profile directory:
	 * "owner" holds its own doctor profile, "secretary" only acts through
	 * delegations, null has no doctor side (patient). Hosts that do not
	 * resolve a role leave it undefined — chrome treats that as "owner".
	 */
	readonly clinicalRole?: "owner" | "secretary" | null;
	/**
	 * Number of entries in the account's doctor-profile directory — own
	 * profile plus delegations. `when.minDoctorProfiles` gates chrome on
	 * it; hosts that do not resolve the directory leave it undefined,
	 * which gates treat as 0.
	 */
	readonly doctorProfiles?: number;
	/**
	 * Number of patient records linked to the account — how many profiles
	 * the patient portal would offer. Hosts that do not resolve the
	 * patient directory leave it undefined, which chrome treats as 0 —
	 * the patient-portal entry only renders when there is a record to
	 * open.
	 */
	readonly patientProfiles?: number;
}

/** Everything the host injects into a chrome `component` contribution —
 * plugins cannot import the host's i18n runtime or session helpers, so
 * the shell resolves locale, user, labels and sign-out and hands them
 * down. `labels` carries the host-localized strings plugins need
 * (documented keys: `login`, `signOut`, `langMenu`,
 * `patientPortal`, `doctorPortal`, `secretaryPortal`, `myConsultations`,
 * `platformConsole`);
 * plugins fall back to their own English literal per key. `signOut`
 * performs the host's sign-out flow (plugins may not import auth
 * adapters). */
export interface ChromeProps {
	readonly user: ChromeUser | null;
	readonly locale: string;
	readonly plugins: readonly Plugin[];
	readonly locales: readonly string[];
	readonly localeName: (locale: string) => string;
	readonly setLocale: (locale: string) => void;
	readonly labels: Readonly<Record<string, string>>;
	readonly signOut: () => Promise<void>;
	/** Host-injected resolved theme for the current shell (P-082/PL-006
	 * phase 7): the shape is owned by the theme plugin (`@ktb/theme`
	 * `ResolvedTheme`) — the kernel stays dependency-free, so brand
	 * chrome narrows it. Absent/null when no theme resolved (the host
	 * always injects the built-in default in practice). */
	readonly theme?: unknown;
	/** Route-scoped DB catalog slice for chrome components (PL-008). */
	readonly i18n?: PageI18nSlice;
}

/** What a chrome contribution renders. `link` is a router link (nav
 * regions), `component` an arbitrary widget, `sidebarItem`/`headerAction`
 * the console chrome payloads (reusing the panel types), `footerBlock`
 * a footer link block, `note` a localized footer note keyed for the
 * host's i18n mapping. */
export type ChromeContent =
	| { readonly kind: "link"; readonly to: string; readonly label: string }
	| {
			readonly kind: "component";
			readonly component: ComponentType<ChromeProps>;
	  }
	| { readonly kind: "sidebarItem"; readonly item: PanelSidebarItem }
	| {
			readonly kind: "headerAction";
			readonly id: string;
			readonly component: ComponentType<{
				readonly locale?: string;
				readonly i18n?: PageI18nSlice;
			}>;
	  }
	| { readonly kind: "footerBlock"; readonly block: LandingFooterBlock }
	| { readonly kind: "note"; readonly key: string; readonly fallback: string }
	/** One tile on the /login role picker (P-099): each sign-in flow's
	 * owning plugin declares its own entry into the `app.login.tiles`
	 * region; the host resolves `labelKey` against its `app.*` message
	 * slice (falling back to `fallback`) and gates the whole flow on
	 * `requires` — plugin ids checked package-granularly (P-058), the
	 * same contract `entryEnabled` applies to registry entries. */
	| {
			readonly kind: "loginTile";
			readonly to: string;
			readonly labelKey: string;
			readonly fallback: string;
			readonly icon: ComponentType<{ readonly className?: string }>;
			readonly requires?: readonly string[];
	  }
	/** A destructive/confirm action a plugin offers inside another
	 * plugin's confirmation dialog (e.g. "unlink & unpublish" vs
	 * "delete referents" when deleting a shared document). `owner`
	 * names the plugin-side hook that executes the action — the host
	 * dialog only enables actions whose owner reported referents.
	 * `id` is the action identifier the owner's cleanup hook receives;
	 * `destructive` marks irreversible choices (styled/emphasized by
	 * the dialog). Labels are English literals like other chrome
	 * payloads — the contributing plugin owns the copy. */
	| {
			readonly kind: "dialogAction";
			readonly action: {
				readonly id: string;
				readonly owner: string;
				readonly label: string;
				readonly description?: string;
				readonly destructive?: boolean;
			};
	  };

/** One slot filled in a shell-owned region. `region` names the slot
 * (e.g. "app.header.nav", "portal.sidebar") — the host declares the
 * valid set per shell; unknown regions are skipped with a dev warning.
 * `order` sorts within the region (ascending, `order ?? Infinity`),
 * ties break by plugin topo order then array index; `when` filters by
 * pathname and session clinical state at render time. `portal` scopes the contribution to ONE
 * portal instance (P-081): only consulted for `portal.*` regions —
 * absent means the default instance ("platform"), so pre-portal
 * contributions keep rendering in the platform console only. */
export interface ChromeContribution {
	readonly id: string;
	readonly region: string;
	readonly order?: number;
	readonly when?: ChromeWhen;
	readonly portal?: string;
	readonly content: ChromeContent;
}

/** Shell chrome slots: ordered, per-page-filtered contributions into
 * named regions owned by the host shells (app marketing chrome,
 * portal sidebars/headers). Replaces the retired landingNav/landingFooter
 * fields and the sidebar/headerActions halves of `panel`. */
export interface ChromePlugin extends PluginBase, ForbiddenContributions<"chrome"> {
	readonly chrome: ReadonlyArray<ChromeContribution>;
}

/** Props the host injects into a contributed landing page — the active
 * UI locale so the page resolves its own localized copy (plugins cannot
 * import the host's i18n runtime). */
export interface LandingPageProps {
	readonly locale?: string;
	/** Route-scoped DB catalog slice (PL-008). */
	readonly i18n?: PageI18nSlice;
}

/** Whole-page landing slot: the host renders the first landing plugin's
 * `page` at "/" in topo order instead of the built-in landing. At most
 * one landing plugin should exist — additional ones are ignored. */
export interface LandingPlugin extends PluginBase, ForbiddenContributions<"landing"> {
	readonly landing: {
		readonly page: ComponentType<LandingPageProps>;
	};
}

/** System-console (panel) contribution: pages the host dispatches
 * under /platform — each `path` gets a generic route that runs `loader`
 * and renders `component`. Paths must be unique across plugins. Console
 * chrome (sidebar items, header actions) is contributed via `chrome`
 * into the "console.*" regions instead. */
export interface PanelPlugin extends PluginBase, ForbiddenContributions<"panel"> {
	readonly panel: {
		/** Console pages the host dispatches under /platform — each
		 * `path` gets a generic route that runs `loader` and renders
		 * `component`. Paths must be unique across plugins. */
		readonly pages?: ReadonlyArray<PanelPage>;
	};
}

/** Props the host injects into an element kind's `renderer` (P-102):
 * `value` is exactly what the kind's server-side `ElementKinds`
 * descriptor `resolve`d for the stored ref — the renderer never sees
 * refs, services or plugin internals, so any layout/template surface
 * can mount it uniformly. */
export interface ElementKindRendererProps {
	readonly value: unknown;
}

/** Props the host injects into an element kind's `editor`: the current
 * payload plus the change sink. The editor is a controlled-by-callback
 * component — it never sees refs, services or persistence; the
 * consumer owns loading/saving the value. */
export interface ElementKindEditorProps {
	readonly value: unknown;
	readonly onChange: (value: unknown) => void;
}

/** One managed-content kind contributed via `elementKinds` (P-102):
 * the client-consumed half of the kind contract — identity (`kind` is
 * the stable string consumers store alongside the ref, e.g.
 * `"rich-text"`), display `label`, optional `icon`, and the React
 * `renderer`/`editor` components a layout mounts for it. Server-side
 * behavior (ref resolution, lifecycle hooks) is NOT declared here —
 * the owning plugin registers an `ElementKindDescriptor` into the
 * `ElementKinds` service at layer build (see @ktb/platform
 * `element-kinds`), keeping plugins decoupled: consumers depend on the
 * registry, never on another plugin's internals. `renderer`/`editor`
 * are optional — a kind may be render-only or editor-less. */
export interface ElementKind {
	readonly kind: string;
	readonly label: string;
	readonly icon?: ComponentType<{ readonly className?: string }>;
	readonly renderer?: ComponentType<ElementKindRendererProps>;
	readonly editor?: ComponentType<ElementKindEditorProps>;
}

/** Element-kind contribution (P-102): the managed-content kinds a
 * plugin ships. Carried on BOTH registries like `panel`/`pages` — the
 * client manifest supplies `renderer`/`editor` components, the server
 * manifest keeps parity; the server descriptor (resolve/hooks) lives
 * in the plugin's service layer, registered via `serviceOption` at
 * build time. `kind` strings must be unique across plugins — the
 * `ElementKinds` registry dies on duplicates. */
export interface ElementKindsPlugin extends PluginBase, ForbiddenContributions<"elementKinds"> {
	readonly elementKinds: ReadonlyArray<ElementKind>;
}

/** Generic page contribution (P-059): plugin-declared pages at
 * arbitrary absolute paths, dispatched by the host's splat routes —
 * the generalization of `panel.pages` beyond /platform. `context`
 * picks the shell (default derived from the path); paths must be
 * unique across ALL page contributions (panel.pages and pages
 * together) — first in topo order wins, later duplicates are dropped
 * with a dev warning. This is also the seam runtime/DB-driven pages
 * (e.g. a future custom-pages plugin) plug into. */
export interface PagesPlugin extends PluginBase, ForbiddenContributions<"pages"> {
	readonly pages: ReadonlyArray<Page>;
}

export type Plugin =
	| MarkerPlugin
	| TablesPlugin
	| ServicesPlugin
	| RoutesPlugin
	| LandingPlugin
	| ChromePlugin
	| PanelPlugin
	| PagesPlugin
	| PortalsPlugin
	| BoundariesPlugin
	| ElementKindsPlugin;
