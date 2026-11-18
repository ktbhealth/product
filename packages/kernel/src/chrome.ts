import type { ChromeContribution, ChromeUser, Plugin } from "./contributions.ts";

/**
 * Chrome region collection (P-060): shells own named regions and plugins
 * fill them via `chrome` contributions. `collectChrome` filters by
 * region + `when` rules against the current pathname and orders by
 * `order ?? Infinity`, ties broken by plugin topo order then array
 * index. `unknownChromeRegions` feeds the dev warning for contributions
 * aimed at regions no shell declares.
 */

/** `prefix/*` matches the bare prefix and its descendants; anything
 * else is an exact pathname match. */
const pathMatches = (pattern: string, pathname: string): boolean => {
	if (pattern.endsWith("/*")) {
		const base = pattern.slice(0, -2);
		return pathname === base || pathname.startsWith(`${base}/`);
	}
	return pathname === pattern;
};

/** Whether a contribution's `when` rules admit `pathname` under the
 * session `user` (when clinical conditions apply). `minDoctorProfiles`
 * fails closed: no resolved user or no resolved count hides the
 * contribution — clinical chrome never leaks to unknown accounts. */
export const chromeWhenMatches = (
	when: ChromeContribution["when"],
	pathname: string,
	user?: ChromeUser | null,
): boolean => {
	if (when === undefined) return true;
	if (when.exceptPaths?.some((p) => pathMatches(p, pathname))) return false;
	if (
		when.minDoctorProfiles !== undefined &&
		(user?.doctorProfiles ?? 0) < when.minDoctorProfiles
	) {
		return false;
	}
	if (when.paths === undefined || when.paths.length === 0) return true;
	return when.paths.some((p) => pathMatches(p, pathname));
};

interface Ranked {
	readonly entry: ChromeContribution;
	readonly pluginIndex: number;
	readonly entryIndex: number;
}

/** The portal instance chrome contributions belong to when they don't
 * say otherwise (P-081): the platform console is the default portal. */
export const DEFAULT_PORTAL_ID = "platform";

/** The instance an entry renders in: its explicit `portal` tag, else
 * the default instance. Only `portal.*` regions consult this. */
export const chromePortal = (entry: ChromeContribution): string =>
	entry.portal ?? DEFAULT_PORTAL_ID;

/** Chrome contributions for `region` visible at `pathname`, in render
 * order. Plugins without `chrome` contribute nothing. `portal` (P-081)
 * additionally keeps only entries scoped to that instance — pass it for
 * `portal.*` regions; app.* regions ignore it. `user` is the session
 * account the `when` clinical conditions evaluate against — regions
 * without clinical chrome may omit it (their `when` rules only see
 * the pathname). */
export const collectChrome = (
	plugins: readonly Plugin[],
	region: string,
	pathname: string,
	portal?: string,
	user?: ChromeUser | null,
): ChromeContribution[] => {
	const ranked: Ranked[] = [];
	plugins.forEach((plugin, pluginIndex) => {
		(plugin.chrome ?? []).forEach((entry, entryIndex) => {
			if (
				entry.region === region &&
				(portal === undefined || chromePortal(entry) === portal) &&
				chromeWhenMatches(entry.when, pathname, user)
			) {
				ranked.push({ entry, pluginIndex, entryIndex });
			}
		});
	});
	ranked.sort(
		(a, b) =>
			(a.entry.order ?? Number.POSITIVE_INFINITY) - (b.entry.order ?? Number.POSITIVE_INFINITY) ||
			a.pluginIndex - b.pluginIndex ||
			a.entryIndex - b.entryIndex,
	);
	return ranked.map((r) => r.entry);
};

/** Region names contributed by `plugins` that `knownRegions` does not
 * declare — each is skipped by every shell; the caller warns in dev. */
export const unknownChromeRegions = (
	plugins: readonly Plugin[],
	knownRegions: ReadonlySet<string>,
): string[] => {
	const unknown = new Set<string>();
	for (const plugin of plugins) {
		for (const entry of plugin.chrome ?? []) {
			if (!knownRegions.has(entry.region)) unknown.add(entry.region);
		}
	}
	return [...unknown].sort();
};

/** Every region a first-party shell declares (app shell in
 * `routes/__root.tsx`, portal shells in `routes/platform.tsx` and
 * `routes/portal.$instance.$.tsx`). The dev
 * warning uses the union so a contribution aimed at the *other* shell's
 * region isn't a false positive. */
export const KNOWN_CHROME_REGIONS: ReadonlySet<string> = new Set([
	"app.header.brand",
	"app.header.nav",
	"app.header.actions",
	"app.header.session",
	"app.footer.blocks",
	"app.footer.note",
	// /login role-picker tiles (P-099) — plugin-contributed sign-in
	// entries rendered by the picker route, not by a shell.
	"app.login.tiles",
	"portal.sidebar",
	// Fixed brand slot in PortalShell's SidebarHeader (P-082) —
	// plugins contribute `component` entries; the instance badge stays
	// host-owned.
	"portal.brand",
	"portal.header.actions",
	// Dashboard page slots (plugins/dashboard) — the platform portal's
	// landing view is the shell that declares and renders them.
	"portal.dashboard.stats",
	"portal.dashboard.sections",
]);

/** Dev-only warning for chrome contributions aimed at undeclared
 * regions — skipped everywhere, so surface the typo loudly. */
export const warnUnknownChromeRegions = (
	plugins: readonly Plugin[],
	knownRegions: ReadonlySet<string>,
): void => {
	for (const region of unknownChromeRegions(plugins, knownRegions)) {
		// eslint-disable-next-line no-console -- dev-only diagnostic
		console.warn(`[chrome] no shell declares region "${region}" — contribution skipped`);
	}
};
