import { entryEnabled, type PackagedPlugin } from "@ktb/kernel";

/**
 * Site-builder enablement probe (PL-014): admin consoles (pages,
 * layouts) show their "Open in builder" links only while the
 * site-builder package is installed AND enabled — same
 * package-granular contract every other `*.def`-style gate applies
 * (P-058). `enabled` is the runtime enable-state id set
 * (`ctx.pluginStates.enabled`); absent it (hosts without plugin-state
 * wiring) presence in the registry is enough.
 */
export const SITE_BUILDER_PACKAGE = "site-builder";

export const siteBuilderEnabled = (
	plugins: readonly PackagedPlugin[],
	enabled?: readonly string[],
): boolean => {
	const set = enabled === undefined ? undefined : new Set(enabled);
	return plugins.some((plugin) => {
		const isBuilder =
			plugin.pkg === SITE_BUILDER_PACKAGE || plugin.id.startsWith(`${SITE_BUILDER_PACKAGE}.`);
		if (!isBuilder) return false;
		return (
			set === undefined || entryEnabled(plugins, set, { pluginId: plugin.id, pkg: plugin.pkg })
		);
	});
};
