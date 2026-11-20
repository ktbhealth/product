import { resolvePath } from "./path.ts";

/**
 * Template resolution — the ONE implementation shared by wizard
 * completions, trigger actions and flow `set-field` writes.
 *
 * A string of the form `"$<scope>.<dot.path>"` resolves against the
 * scope's OWN root properties (`record`, `event`, `flow`, `answers`,
 * `wizard`, `run`, `trigger`, … — see each runtime for its scope
 * shape). Non-string values and strings that are not templates pass
 * through literally; a template whose path does not resolve ALSO
 * passes through literally (fail-open on copy — the written literal
 * is visible in the record rather than silently dropped or `undefined`).
 */
export const resolveTemplate = (value: unknown, scope: object): unknown => {
	// Stryker disable next-line ConditionalExpression: resolvePath returns
	// undefined for every non-string, so `resolved === undefined` yields
	// `value` either way — the early return is redundant.
	if (typeof value !== "string") return value;
	const resolved = resolvePath(value, scope);
	return resolved === undefined ? value : resolved;
};
