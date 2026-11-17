import type { MessageKind } from "@ktb/i18n";

import type { I18nMessage } from "../schema.ts";

export type MessageScope = "global" | "tenant" | "portal";

export interface Cell {
	readonly draft: string | null;
	readonly live: string;
	readonly status: "draft" | "published";
	readonly kind: MessageKind;
}

/** Map key for one matrix cell — JSON tuple so namespace/key/locale
 * values containing separator characters can't collide. */
export const cellKey = (
	namespace: string,
	key: string,
	locale: string,
	scope: MessageScope = "global",
	scopeId = "",
): string => JSON.stringify([namespace, key, locale, scope, scopeId]);

export type CellIndex = ReadonlyMap<string, Cell>;

/**
 * Index fetched message rows by cell key ONCE per fetch — the matrix
 * renders keys × locales cells per keystroke-adjacent render, so a
 * per-cell `Array.find` would be O(rows) each. Lookups are O(1).
 */
export const buildCellIndex = (messages: readonly I18nMessage[]): CellIndex => {
	const index = new Map<string, Cell>();
	for (const m of messages) {
		index.set(cellKey(m.namespace, m.key, m.locale, m.scope, m.scopeId), {
			draft: m.draftValue,
			live: m.value,
			status: m.status,
			kind: m.kind,
		});
	}
	return index;
};

export const cellFor = (
	index: CellIndex,
	namespace: string,
	key: string,
	locale: string,
	scope: MessageScope = "global",
	scopeId = "",
): Cell | undefined => index.get(cellKey(namespace, key, locale, scope, scopeId));

/** The editor counts as dirty when the textarea diverges from what the
 * cell would open with (pending draft wins over live, like `open`). */
export const isDraftDirty = (draft: string, cell: Cell | undefined): boolean =>
	draft !== (cell?.draft ?? cell?.live ?? "");

/** Client-side preview of an import file BEFORE it hits the wire —
 * namespace + locale/key/entry counts for the confirm step. Shape
 * strictness stays server-side in I18nAdmin.importNamespace. */
export interface ImportSummary {
	readonly namespace: string;
	readonly localeCount: number;
	readonly keyCount: number;
	readonly entryCount: number;
}

export const summarizeImportPayload = (
	payload: unknown,
):
	| { readonly ok: true; readonly summary: ImportSummary }
	| { readonly ok: false; readonly error: string } => {
	if (payload === null || typeof payload !== "object") {
		return { ok: false, error: "not an i18n export file" };
	}
	const p = payload as { readonly namespace?: unknown; readonly messages?: unknown };
	if (typeof p.namespace !== "string" || p.namespace === "") {
		return { ok: false, error: "missing namespace" };
	}
	if (p.messages === null || typeof p.messages !== "object") {
		return { ok: false, error: "missing messages" };
	}
	const keys = new Set<string>();
	let entryCount = 0;
	for (const kv of Object.values(p.messages)) {
		if (kv === null || typeof kv !== "object") continue;
		for (const key of Object.keys(kv)) {
			keys.add(key);
			entryCount += 1;
		}
	}
	return {
		ok: true,
		summary: {
			namespace: p.namespace,
			localeCount: Object.keys(p.messages).length,
			keyCount: keys.size,
			entryCount,
		},
	};
};
