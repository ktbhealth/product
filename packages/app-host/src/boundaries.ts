import type { BoundaryContribution, Plugin, PluginPriority } from "@ktb/kernel";
import { entryEnabled } from "@ktb/kernel";

/**
 * Router-boundary registry helpers (P-100): plugins contribute
 * `boundaries` entries (`notFound`/`error` components); the host picks
 * ONE winner per kind — highest plugin `priority`, ties by plugin topo
 * order — after applying the same package-granular enabled-state gate
 * page/chrome entries use. Selection is deliberately separate from
 * `collectChrome`: boundaries are single-slot replacements, not
 * ordered region fills.
 */

export type BoundaryKind = BoundaryContribution["kind"];

interface BoundaryEntryBase {
	readonly pluginId: string;
	readonly pkg?: string;
	readonly priority?: PluginPriority;
}

export interface NotFoundBoundaryEntry extends BoundaryEntryBase {
	readonly kind: "notFound";
	readonly component: Extract<BoundaryContribution, { kind: "notFound" }>["component"];
}

export interface ErrorBoundaryEntry extends BoundaryEntryBase {
	readonly kind: "error";
	readonly component: Extract<BoundaryContribution, { kind: "error" }>["component"];
}

export type BoundaryEntry = NotFoundBoundaryEntry | ErrorBoundaryEntry;

/** Every contributed boundary, in plugin topo order. */
export const collectBoundaries = (registry: readonly Plugin[]): readonly BoundaryEntry[] =>
	registry.flatMap((plugin) =>
		(plugin.boundaries ?? []).map((boundary) => {
			const base = {
				pluginId: plugin.id,
				...(plugin.pkg === undefined ? {} : { pkg: plugin.pkg }),
				...(plugin.priority === undefined ? {} : { priority: plugin.priority }),
			};
			return boundary.kind === "notFound"
				? { kind: "notFound" as const, component: boundary.component, ...base }
				: { kind: "error" as const, component: boundary.component, ...base };
		}),
	);

const priorityRank = (priority: PluginPriority | undefined): number => {
	switch (priority) {
		case "high":
			return 3;
		case "low":
			return 1;
		default:
			return 2;
	}
};

const select = <K extends BoundaryKind>(
	entries: readonly BoundaryEntry[],
	plugins: readonly Plugin[],
	enabled: ReadonlySet<string>,
	kind: K,
): Extract<BoundaryEntry, { kind: K }> | undefined => {
	let best: BoundaryEntry | undefined;
	let bestRank = -1;
	for (const entry of entries) {
		if (entry.kind !== kind) continue;
		if (!entryEnabled(plugins, enabled, entry)) continue;
		const rank = priorityRank(entry.priority);
		if (rank > bestRank) {
			best = entry;
			bestRank = rank;
		}
	}
	return best as Extract<BoundaryEntry, { kind: K }> | undefined;
};

/** The enabled not-found boundary winner, or undefined when no plugin
 * contributes one (the host then falls back to its built-in surface). */
export const selectNotFoundBoundary = (
	entries: readonly BoundaryEntry[],
	plugins: readonly Plugin[],
	enabled: ReadonlySet<string>,
): NotFoundBoundaryEntry | undefined => select(entries, plugins, enabled, "notFound");

/** The enabled error boundary winner, or undefined when none is live. */
export const selectErrorBoundary = (
	entries: readonly BoundaryEntry[],
	plugins: readonly Plugin[],
	enabled: ReadonlySet<string>,
): ErrorBoundaryEntry | undefined => select(entries, plugins, enabled, "error");
