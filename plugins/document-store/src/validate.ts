import type { Json } from "effect/Schema";

import type { FieldDescriptor, Fields } from "./fields.ts";

/**
 * Runtime validation of record `data` against a collection's field
 * descriptors (P-089). Pure and synchronous — DB-side concerns (ref
 * target existence, unique enforcement) live in service.ts.
 *
 * Rules:
 * - Unknown keys are rejected (strict schema — evolving a collection
 *   means bumping `version` and widening `fields`).
 * - Absent keys fall back to `default`, then to "missing": required
 *   fields without a default fail; optional fields are omitted from
 *   the stored document. In `partial` mode absent keys are skipped
 *   entirely — defaults are NOT injected into patches.
 * - A key PRESENT with value `undefined` is rejected in `partial`
 *   mode: `undefined` is not a JSON value, and treating it as absent
 *   would let a patch silently delete fields (required and `unique`
 *   included). In full mode it is treated as absent — insert input
 *   never round-trips `undefined` through JSON anyway.
 * - `null` is only valid for `json` and `ref` fields (a null ref is
 *   "unset"); every other kind rejects it.
 * - `date` values are epoch milliseconds (finite number).
 * - `array` bounds use `minLength`/`maxLength` as ITEM counts; `string`
 *   uses them as character counts; `number`/`date` use `min`/`max`.
 * - `default` values are validated through the same `checkValue` path
 *   as caller-supplied data — defs arrive as untyped JSON, so an
 *   invalid default is a loud validation issue, not silent corruption.
 */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON-serializable check for `json` fields — rejects undefined,
 * functions, symbols and circular structures via a seen-set. */
const isJsonValue = (value: unknown, seen: Set<unknown>): boolean => {
	if (value === null) return true;
	switch (typeof value) {
		case "string":
		case "boolean":
			return true;
		case "number":
			return Number.isFinite(value);
		case "object": {
			if (seen.has(value)) return false;
			// Plain objects/arrays only — Date, Map, class instances etc.
			// are not JSON values even when they serialize lossily.
			if (!Array.isArray(value)) {
				const proto = Object.getPrototypeOf(value);
				if (proto !== Object.prototype && proto !== null) return false;
			}
			seen.add(value);
			const ok = Array.isArray(value)
				? value.every((v) => isJsonValue(v, seen))
				: Object.values(value as Record<string, unknown>).every((v) => isJsonValue(v, seen));
			seen.delete(value);
			return ok;
		}
		default:
			return false;
	}
};

export const isJson = (value: unknown): value is Json => isJsonValue(value, new Set());

// `null` never reaches here — checkValue rejects it before the kind
// switch (json/ref handle it earlier), so no null branch is needed.
const typeName = (v: unknown): string => (Array.isArray(v) ? "array" : typeof v);

/** Validate a single value against one descriptor. Returns an issue
 * string or null. `path` is the dotted field path for messages.
 *
 * Exported for collection.ts, which reuses it to validate `default`
 * values at def-assertion time (defs arrive as untyped JSON).
 */
export const checkValue = (
	descriptor: FieldDescriptor,
	value: unknown,
	path: string,
): string | null => {
	const fail = (msg: string) => `${path}: ${msg}`;

	if (descriptor.kind === "json") {
		return isJson(value) ? null : fail("must be a JSON value");
	}
	if (descriptor.kind === "ref") {
		if (value === null) return null;
		return typeof value === "number" && Number.isFinite(value)
			? null
			: fail("must be a record id (number) or null");
	}
	if (value === null) return fail(`must be ${descriptor.kind}, got null`);

	switch (descriptor.kind) {
		case "string": {
			if (typeof value !== "string") return fail(`must be a string, got ${typeName(value)}`);
			const length = value.length;
			if (descriptor.minLength !== undefined && length < descriptor.minLength) {
				return fail(`shorter than minLength ${descriptor.minLength}`);
			}
			if (descriptor.maxLength !== undefined && length > descriptor.maxLength) {
				return fail(`longer than maxLength ${descriptor.maxLength}`);
			}
			if (descriptor.pattern !== undefined && !new RegExp(descriptor.pattern).test(value)) {
				return fail(`does not match pattern ${descriptor.pattern}`);
			}
			return null;
		}
		case "number":
		case "date": {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return fail(`must be a finite number, got ${typeName(value)}`);
			}
			if (descriptor.min !== undefined && value < descriptor.min) {
				return fail(`below min ${descriptor.min}`);
			}
			if (descriptor.max !== undefined && value > descriptor.max) {
				return fail(`above max ${descriptor.max}`);
			}
			return null;
		}
		case "boolean":
			return typeof value === "boolean" ? null : fail(`must be a boolean, got ${typeName(value)}`);
		case "enum": {
			if (typeof value !== "string" || !descriptor.values?.includes(value)) {
				return fail(`must be one of ${(descriptor.values ?? []).join(", ")}`);
			}
			return null;
		}
		case "array": {
			if (!Array.isArray(value)) return fail(`must be an array, got ${typeName(value)}`);
			if (descriptor.minLength !== undefined && value.length < descriptor.minLength) {
				return fail(`has fewer than minLength ${descriptor.minLength} items`);
			}
			if (descriptor.maxLength !== undefined && value.length > descriptor.maxLength) {
				return fail(`has more than maxLength ${descriptor.maxLength} items`);
			}
			const of = descriptor.of;
			if (of === undefined) return null;
			for (let i = 0; i < value.length; i++) {
				const issue = checkValue(of, value[i], `${path}[${i}]`);
				if (issue !== null) return issue;
			}
			return null;
		}
		default:
			return fail(`unknown field kind ${(descriptor as { kind: string }).kind}`);
	}
};

export interface ValidateOptions {
	/** Update semantics: only validate keys present in `input`; absent
	 * keys keep their stored values (required is NOT re-checked). */
	readonly partial?: boolean;
}

/**
 * Validate `input` against `fields`. Returns the normalized document
 * (defaults applied, absent optional keys omitted) or the list of
 * issues (empty = valid). `input` must be a plain object.
 */
export const validateDocumentData = (
	fields: Fields,
	input: unknown,
	options: ValidateOptions = {},
):
	| { readonly ok: true; readonly data: Record<string, unknown> }
	| { readonly ok: false; readonly issues: readonly string[] } => {
	if (!isPlainObject(input)) {
		return { ok: false, issues: ["data must be a JSON object"] };
	}
	const issues: string[] = [];
	// Null-prototype accumulator: field names are data keys, and a
	// `__proto__` assignment on a plain object would silently rewrite
	// its prototype instead of storing the value (assertCollectionDef
	// rejects such names upstream; this is defense in depth for
	// hand-built Fields maps).
	const data: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(input)) {
		// hasOwn, not `in` — `"constructor" in fields` is true via the
		// prototype chain and would mask genuinely unknown keys.
		if (!Object.hasOwn(fields, key)) issues.push(`${key}: unknown field`);
	}
	for (const [name, descriptor] of Object.entries(fields)) {
		// hasOwn, not `in` — same prototype-chain trap on the input side.
		const present = Object.hasOwn(input, name);
		const raw = present ? input[name] : undefined;
		if (present && raw === undefined) {
			// Explicit `undefined` is not a JSON value. In partial mode
			// it must NOT be treated as absent: the update path merges
			// the patch over stored data, so skipping the key would let
			// `{ field: undefined }` silently delete the stored value —
			// bypassing `required` and dropping `unique` fields out of
			// the uniqueness check. Reject it as a typed issue.
			if (options.partial === true) {
				issues.push(`${name}: must not be undefined`);
				continue;
			}
			// Full (insert) mode keeps the historical "undefined ≡
			// absent" semantics — insert data never survives a JSON
			// round-trip with undefined anyway.
		}
		if (!present || raw === undefined) {
			// Partial (patch) semantics skip absent keys entirely —
			// defaults are NOT injected: a patch must not mutate fields
			// the caller never mentioned.
			if (options.partial === true) continue;
			if (descriptor.default !== undefined) {
				// Defaults are untyped JSON from the def — run them
				// through the same check as caller data so an invalid
				// default fails loudly instead of storing bad data.
				const defaultIssue = checkValue(descriptor, descriptor.default, name);
				if (defaultIssue !== null) {
					issues.push(defaultIssue);
				} else {
					data[name] = descriptor.default;
				}
				continue;
			}
			if (descriptor.required === true) {
				issues.push(`${name}: required field missing`);
			}
			continue;
		}
		const issue = checkValue(descriptor, raw, name);
		if (issue !== null) {
			issues.push(issue);
		} else {
			data[name] = raw;
		}
	}
	return issues.length > 0 ? { ok: false, issues } : { ok: true, data };
};
