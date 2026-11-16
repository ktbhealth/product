import * as Effect from "effect/Effect";

import type { DbClient } from "@ktb/db";
import { indexMessages, resolveMessage, type LocaleChain, type ScopeChain } from "@ktb/i18n";

import { listPublishedRows } from "./store.ts";

const SEP = " ";

/**
 * Route-scoped catalog slice (PL-008 Phase 2): resolves every message
 * in `namespaces` for the request's scope chain + locale chain down to
 * final templates, keyed `namespace.key`. This is what loader data
 * carries to the client — `t()` there is a pure map lookup + render,
 * no DB, no Effect.
 *
 * Slices query directly rather than through the isolate cache: subsets
 * are small and per-route, and caching every subset would explode the
 * isolate map. Full-catalog callers use I18nRuntime.catalogFor.
 */
export const catalogSlice = (
	db: DbClient,
	input: {
		readonly namespaces: readonly string[];
		readonly scopeChain: ScopeChain;
		readonly locales: LocaleChain;
	},
): Effect.Effect<Record<string, string>> =>
	Effect.gen(function* () {
		const rows = yield* Effect.promise(() =>
			listPublishedRows(db, {
				locales: input.locales.locales,
				scopes: input.scopeChain.scopes,
				namespaces: input.namespaces,
			}),
		);
		const index = indexMessages(rows);
		const keys = new Set(rows.map((r) => `${r.namespace}${SEP}${r.key}`));
		const slice: Record<string, string> = {};
		for (const composite of keys) {
			const sep = composite.indexOf(SEP);
			const namespace = composite.slice(0, sep);
			const key = composite.slice(sep + 1);
			const resolved = resolveMessage(index, {
				namespace,
				key,
				scopeChain: input.scopeChain,
				locales: input.locales,
			});
			if (resolved.source.kind === "hit") {
				slice[`${namespace}.${key}`] = resolved.template;
			}
		}
		return slice;
	});

/** Serialize a slice for loader data — sorted keys, stable output. */
export const stableSlice = (slice: Record<string, string>): Record<string, string> =>
	Object.fromEntries(Object.entries(slice).sort(([a], [b]) => a.localeCompare(b)));
