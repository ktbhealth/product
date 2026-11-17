import type { FieldDescriptor, FieldKind } from "../fields.ts";

/**
 * Pure helpers shared by the console views: cell formatting for the
 * documents table and form-state ⇄ document-data conversion for the
 * generated editor. Kept UI-free (no React, no i18n) so every rule is
 * unit-testable.
 */

export const EMPTY_CELL = "—";

/** Documents-table page size — shared by the view's pagination and
 * the panel loader's first-page fetch (keep in sync). */
export const DOCUMENTS_PAGE_SIZE = 25;

const JSON_PREVIEW_MAX = 80;

/** Human-readable cell text for one stored value under a field kind.
 * `locale` feeds Date formatting; `fallback` covers absent values. */
export const formatCell = (
	kind: FieldKind,
	value: unknown,
	locale = "en",
	fallback: string = EMPTY_CELL,
): string => {
	if (value === undefined || value === null) return fallback;
	switch (kind) {
		case "boolean":
			return value === true ? "true" : "false";
		case "date":
			return typeof value === "number" && Number.isFinite(value)
				? new Date(value).toLocaleString(locale)
				: String(value as string);
		case "ref":
			return typeof value === "number" ? `#${value}` : String(value as string);
		case "json":
		case "array": {
			const text = JSON.stringify(value);
			return text.length > JSON_PREVIEW_MAX ? `${text.slice(0, JSON_PREVIEW_MAX)}…` : text;
		}
		default:
			return typeof value === "object"
				? JSON.stringify(value)
				: String(value as string | number | boolean);
	}
};

/** epoch ms → `datetime-local` input value ("YYYY-MM-DDTHH:mm"). */
export const dateToInputValue = (ms: unknown): string => {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** `datetime-local` input value → epoch ms; null when unparseable. */
export const inputValueToDate = (value: string): number | null => {
	if (value.trim() === "") return null;
	const ms = new Date(value).getTime();
	return Number.isNaN(ms) ? null : ms;
};

/** Stored value → the raw string a form input starts with. */
export const initialInputValue = (descriptor: FieldDescriptor, value: unknown): string => {
	if (value === undefined || value === null) return "";
	switch (descriptor.kind) {
		case "date":
			return dateToInputValue(value);
		case "boolean":
			// Absent stays "" so an untouched optional boolean is
			// omitted from the payload instead of being forced false.
			return value === true ? "true" : value === false ? "false" : "";
		case "json":
		case "array":
			return JSON.stringify(value, null, 2);
		default:
			return String(value as string | number | boolean);
	}
};

export type BuildDataResult =
	| { readonly ok: true; readonly data: Record<string, unknown> }
	| {
			readonly ok: false;
			readonly field: string;
			readonly reason: "invalidNumber" | "invalidDate" | "invalidJson";
	  };

/**
 * Convert raw input strings into a document payload for
 * `DocumentStore.insert`/`update`. Empty optional inputs are OMITTED
 * (scalars cannot be cleared to null — the DSL only allows null for
 * `json`/`ref`); `ref` fields send `null` for "unset". `boolean` is
 * always sent (unchecked = false). Returns the first conversion
 * failure — the view maps `reason` to a localized message.
 */
export const buildDocumentData = (
	fields: Record<string, FieldDescriptor>,
	inputs: Record<string, string>,
): BuildDataResult => {
	const data: Record<string, unknown> = {};
	for (const [name, descriptor] of Object.entries(fields)) {
		const raw = inputs[name] ?? "";
		switch (descriptor.kind) {
			case "boolean":
				if (raw === "") break;
				data[name] = raw === "true";
				break;
			case "number": {
				if (raw.trim() === "") break;
				const n = Number(raw);
				if (!Number.isFinite(n)) return { ok: false, field: name, reason: "invalidNumber" };
				data[name] = n;
				break;
			}
			case "date": {
				if (raw.trim() === "") break;
				const ms = inputValueToDate(raw);
				if (ms === null) return { ok: false, field: name, reason: "invalidDate" };
				data[name] = ms;
				break;
			}
			case "enum": {
				// "" is the "none" option — omitted like other empties.
				if (raw === "") break;
				data[name] = raw;
				break;
			}
			case "json":
			case "array": {
				if (raw.trim() === "") break;
				try {
					data[name] = JSON.parse(raw);
				} catch {
					return { ok: false, field: name, reason: "invalidJson" };
				}
				break;
			}
			case "ref": {
				if (raw.trim() === "") {
					data[name] = null;
					break;
				}
				const n = Number(raw);
				if (!Number.isFinite(n)) return { ok: false, field: name, reason: "invalidNumber" };
				data[name] = n;
				break;
			}
			default:
				data[name] = raw;
				break;
		}
	}
	return { ok: true, data };
};

/** Field entries in declaration order — the table/editor column order. */
export const fieldEntries = (
	fields: Record<string, FieldDescriptor>,
): readonly (readonly [string, FieldDescriptor])[] => Object.entries(fields);
