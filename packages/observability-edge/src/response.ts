/**
 * Unwrap the `Response` carried by a request-middleware `next()` result.
 *
 * The pipeline result is typed as `{ response: Response }`, but the SSR
 * pipeline can hand back a wrapper object whose own `response` field
 * holds the real `Response` — the shape is framework-internal, so this
 * probes structurally (`instanceof` + one nested `.response` level)
 * rather than trusting the declared type. Anything that doesn't resolve
 * to an actual `Response` returns `undefined`: callers must not treat
 * arbitrary objects as responses (a truthy non-Response would crash on
 * `response.headers.set`).
 */
export const unwrapResponse = (result: unknown): Response | undefined => {
	// The pipeline may resolve to the Response itself.
	if (result instanceof Response) return result;

	const exposed = (result as { response?: unknown } | null | undefined)?.response;
	if (exposed instanceof Response) return exposed;

	// SSR wrapper: `{ response: { response: Response } }` — one level deep.
	if (exposed !== null && typeof exposed === "object" && "response" in exposed) {
		const inner = (exposed as { response?: unknown }).response;
		return inner instanceof Response ? inner : undefined;
	}
	return undefined;
};
