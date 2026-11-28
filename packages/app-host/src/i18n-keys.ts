import type { Plugin } from "@ktb/kernel";

/**
 * Plugin-declared chrome i18n keys, merged across the registry (E.19):
 * each plugin's `i18nKeys` maps `to`/group/note-key → `app.*` message
 * key; the host shells resolve labels through these instead of
 * host-side path→key maps. Merge order is plugin topo order — on a
 * key collision the LATER plugin wins (same spread semantics as
 * Object.assign; collisions are a manifest bug, not a feature).
 */
export interface ChromeI18nKeys {
	readonly labels: Readonly<Record<string, string>>;
	readonly groups: Readonly<Record<string, string>>;
	readonly notes: Readonly<Record<string, string>>;
}

/** Merge every enabled-filtered plugin's `i18nKeys` into one lookup.
 * `plugins` must already be enabled-state filtered (enabledPlugins) —
 * disabled plugins contribute no chrome, so their keys stay out too. */
export const collectI18nKeys = (plugins: readonly Plugin[]): ChromeI18nKeys => {
	const labels: Record<string, string> = {};
	const groups: Record<string, string> = {};
	const notes: Record<string, string> = {};
	for (const plugin of plugins) {
		const keys = plugin.i18nKeys;
		if (keys === undefined) continue;
		Object.assign(labels, keys.labels);
		Object.assign(groups, keys.groups);
		Object.assign(notes, keys.notes);
	}
	return { labels, groups, notes };
};
