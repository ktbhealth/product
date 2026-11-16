import { LoroDoc } from "loro-crdt";

/**
 * Loro CRDT helpers for rich-text message editing (P-083). CRDT lives
 * ONLY on the edit path — reads use the materialized `i18n_messages.value`,
 * so `t()` never pays CRDT cost. Each message has one LoroDoc whose
 * single text field "value" holds the HTML; ops merge automatically,
 * which is the concurrency answer (no last-write-wins).
 *
 * Spike note: Loro is WASM — verified in workerd before Phase 3 relies
 * on it (PL-008). Node-side behavior is covered by tests here.
 */

const FIELD = "value";

/** Fresh doc seeded with `initial` HTML. */
export const newMessageDoc = (initial = ""): LoroDoc => {
	const doc = new LoroDoc();
	if (initial !== "") doc.getText(FIELD).insert(0, initial);
	return doc;
};

/** Rebuild a doc from the full op log (or a snapshot update). */
export const docFromUpdates = (updates: readonly Uint8Array[]): LoroDoc => {
	const doc = new LoroDoc();
	for (const u of updates) doc.import(u);
	return doc;
};

/** Materialize the current text value of a doc. */
export const docValue = (doc: LoroDoc): string => doc.getText(FIELD).toString();

/**
 * Apply a remote/local update and return { doc, update } — the update is
 * what gets appended to `i18n_crdt_updates`; `docValue(doc)` is what gets
 * written to `i18n_messages.value`.
 */
export const applyTextEdit = (
	doc: LoroDoc,
	edit: { readonly insert?: string; readonly delete?: number },
): { readonly doc: LoroDoc; readonly update: Uint8Array; readonly value: string } => {
	const before = doc.oplogVersion();
	const text = doc.getText(FIELD);
	if (edit.delete !== undefined && edit.delete > 0) {
		// delete last N chars appended — CRDT ops in the panel carry
		// explicit ranges; this helper covers the append-at-end case.
		const len = text.length;
		text.delete(Math.max(0, len - edit.delete), edit.delete);
	}
	if (edit.insert !== undefined && edit.insert !== "") {
		text.insert(text.length, edit.insert);
	}
	const update = doc.export({ mode: "update", from: before });
	return { doc, update, value: docValue(doc) };
};

/**
 * Whole-value replace (panel textarea saves): rebuild the doc from the
 * message's op log, swap the entire text, export the delta. Concurrent
 * remote edits still merge — Loro reconciles overlapping replaces.
 */
export const replaceDocValue = (
	updates: readonly Uint8Array[],
	value: string,
): { readonly update: Uint8Array; readonly value: string } => {
	const doc = updates.length === 0 ? newMessageDoc() : docFromUpdates(updates);
	const before = doc.oplogVersion();
	const text = doc.getText(FIELD);
	if (text.length > 0) text.delete(0, text.length);
	if (value !== "") text.insert(0, value);
	const update = doc.export({ mode: "update", from: before });
	return { update, value: docValue(doc) };
};
