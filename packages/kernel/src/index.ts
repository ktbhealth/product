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
import type { Plugin } from "./contributions.ts";

export type {
	PluginConfigSchema,
	PluginContribution,
	PluginId,
	PluginMeta,
	PluginRegistry,
} from "./core.ts";
export { entryEnabled, packageLive } from "./enabled.ts";
export type { PackagedPlugin, PluginEntryRef } from "./enabled.ts";
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
