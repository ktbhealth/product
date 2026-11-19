/**
 * Pure helpers over the stored JSON document — no platejs/ui imports, so
 * they stay safe for the public renderer bundle. The stored `value` is
 * `JSON.stringify` of a Plate `Value` (array of nodes); these helpers
 * only inspect its structure (text leaves, emptiness, plain-text excerpt).
 */

/** Parse a stored JSON document into a Plate value candidate. Returns the
 * parsed value only when it is a non-empty array; anything else (bad JSON,
 * object, empty array) resolves to null. */
export const parseRichTextValue = (json: string): unknown => {
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
	} catch {
		return null;
	}
};

/** Yield every string `text` leaf reachable under `node`. */
const textLeaves = function* (node: unknown): Generator<string> {
	if (typeof node !== "object" || node === null) return;
	const n = node as { text?: unknown; children?: unknown };
	if (typeof n.text === "string") yield n.text;
	if (Array.isArray(n.children)) {
		for (const child of n.children) yield* textLeaves(child);
	}
};

/** True when the value carries no non-empty text anywhere — the canonical
 * empty doc `[{type:"p",children:[{text:""}]}]` counts as empty. */
export const isRichTextEmpty = (value: unknown): boolean => {
	if (!Array.isArray(value)) return true;
	for (const node of value) {
		for (const text of textLeaves(node)) {
			if (text.length > 0) return false;
		}
	}
	return true;
};

/** First ~`max` chars of concatenated text leaves — list excerpts. */
export const richTextPlainText = (value: unknown, max = 80): string => {
	if (!Array.isArray(value)) return "";
	let out = "";
	for (const node of value) {
		for (const text of textLeaves(node)) out += text;
		if (out.length >= max) break;
	}
	return out.slice(0, max);
};
