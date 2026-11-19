/**
 * Module boundary: `core.ts` is the UI-framework-neutral registry
 * contract (PluginRegistry/PluginId/PluginBase/ForbiddenContributions —
 * type-only imports, no runtime deps). `contributions.ts` carries the host-chrome contract:
 * the Plugin union and its prop types reference React/TanStack/drizzle/
 * effect, but ONLY via `import type` against devDependencies, so the
 * emitted package stays dependency-free and server consumers
 * (driver-framework, app-host) never pull UI runtime. The union must
 * stay whole — `ForbiddenContributions` gives each member compile-time
 * exclusivity over the other contribution keys.
 */
import type { MarkerPlugin, Plugin } from "./contributions.ts";

export type {
	PluginConfigSchema,
	PluginContribution,
	PluginId,
	PluginMeta,
	PluginRegistry,
} from "./core.ts";
export {
	buildDefOwnerIndex,
	defOwnerEnabled,
	entryEnabled,
	packageLive,
	type DefOwnerIndex,
	type PackagedPlugin,
	type PluginEntryRef,
} from "./enabled.ts";
export {
	DEFAULT_PORTAL_ID,
	KNOWN_CHROME_REGIONS,
	chromePortal,
	chromeWhenMatches,
	collectChrome,
	unknownChromeRegions,
	warnUnknownChromeRegions,
} from "./chrome.ts";
export {
	collectContributions,
	collectKindContributions,
	ELEMENT_KINDS_KIND,
	FIELD_CONTRIBUTION_KINDS,
	GENERIC_CONTRIBUTION_SLOT,
	pluginContributionKinds,
	THEME_BRAND_KIND,
	THEME_CONTRIBUTION_KINDS,
	THEME_TOKENS_KIND,
	type CollectedContribution,
	type ContributionKindDescriptor,
} from "./kinds.ts";
export { PLUGIN_KEYWORD_SET, PLUGIN_KEYWORDS, type PluginKeyword } from "./keywords.ts";
export type {
	ChromeContent,
	ChromeContribution,
	ChromePlugin,
	ChromeProps,
	ChromeUser,
	ChromeWhen,
	ElementKind,
	ElementKindEditorProps,
	ElementKindsPlugin,
	ElementKindRendererProps,
	LandingFooterBlock,
	LandingLink,
	LandingPageProps,
	LandingPlugin,
	MarkerPlugin,
	PanelHeaderAction,
	PanelPage,
	PanelPageContext,
	PanelPlugin,
	PanelSidebarItem,
	Page,
	PageContext,
	PageI18nSlice,
	PagesPlugin,
	Plugin,
	PortalInstance,
	PortalsPlugin,
	RoutesPlugin,
	ServicesPlugin,
	TablesPlugin,
} from "./contributions.ts";

export const definePlugin = <const P extends Plugin>(plugin: P): P => plugin;

/** Client-registry marker for a plugin whose contributions are
 * entirely server-side (T-149): `plugins/<pkg>/src/client.ts` mirrors
 * must carry every server plugin id — dep edges and package-granular
 * enable-state filtering resolve membership from them — but nothing
 * else is client-consumed, so each stub degenerates to a bare-id
 * marker. `clientStub` accepts only the serializable manifest fields
 * (id/meta/deps/system) — the dedicated contribution fields are
 * compile-time `never` via {@link MarkerPlugin}, and `contributions`/
 * `configSchema` are omitted so server data can't ride the client
 * bundle by accident. Keep ids, meta and dep edges in sync with
 * ./index.ts — parity is asserted by apps/web/src/plugins.test.ts. */
export type ClientStubPlugin = Omit<MarkerPlugin, "contributions" | "configSchema"> & {
	readonly contributions?: never;
	readonly configSchema?: never;
};

export const clientStub = <const P extends ClientStubPlugin>(plugin: P): P => plugin;
