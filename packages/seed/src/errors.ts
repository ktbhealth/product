/**
 * Error type for `@ktb/seed`. Thrown when a schema asks for something
 * the generator can't satisfy — unsupported `pattern` syntax,
 * unsatisfiable combinator merges, `not` schemas, exhausted depth /
 * node budgets, or a `pattern` that resisted all generation attempts.
 * Generation NEVER silently emits non-conforming data.
 */
export class SeedError extends Error {
	/** JSON-pointer-ish location inside the schema document, when known. */
	readonly path?: string;

	constructor(message: string, path?: string) {
		super(path ? `${message} (at ${path})` : message);
		this.name = "SeedError";
		this.path = path;
	}
}
