/**
 * Versioned builder document codec (PL-014 / P-109).
 *
 * `builderJson` columns (pages.builder_json, layouts.builder_json)
 * store a JSON string wrapping the Puck `Data` document:
 *
 *   { "version": 1, "data": { "root": {...}, "content": [...], "zones": {...} } }
 *
 * The wrapper exists so prop-shape breaking changes can be migrated
 * without touching stored rows: {@link migrateBuilderDoc} walks the
 * version chain through {@link BUILDER_DOC_MIGRATIONS} (empty today —
 * v1 is the first shipped shape) and every reader goes through
 * {@link parseBuilderDoc} + {@link migrateBuilderDoc} before handing
 * `data` to Puck's `<Render>`/`<Puck>`.
 *
 * This module is deliberately framework-free: no React, no Puck
 * imports — it is safe on server and client edges.
 */

/** Current builder-document schema version. Bump when the stored
 * `data` shape changes incompatibly and append a migration step. */
export const BUILDER_DOC_VERSION = 1;

/** The stored wrapper: schema `version` plus the opaque Puck `Data`
 * payload (`root`/`content`/`zones` — validated by Puck at render). */
export interface BuilderDoc {
	readonly version: number;
	readonly data: unknown;
}

/** One migration step: transforms `data` from `version` to
 * `version + 1`. Steps run in order; a doc at the current version
 * passes through untouched. */
export type BuilderDocMigration = (data: unknown) => unknown;

/** Ordered migration steps — index `i` migrates `version: i + 1` →
 * `i + 2`. Empty while v1 is current; append here (never edit shipped
 * steps) when the doc shape breaks. */
export const BUILDER_DOC_MIGRATIONS: readonly BuilderDocMigration[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse stored `builderJson` text into a {@link BuilderDoc}. Returns
 * null for absent/blank/malformed input — callers treat null as "no
 * builder document" and fall back to the legacy render path. */
export const parseBuilderDoc = (raw: string | null | undefined): BuilderDoc | null => {
	if (raw === null || raw === undefined) return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!isRecord(parsed)) return null;
		const version = parsed.version;
		if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
		if (!("data" in parsed)) return null;
		return { version, data: parsed.data };
	} catch {
		return null;
	}
};

/** Serialize a doc for storage. The output is always re-parseable by
 * {@link parseBuilderDoc} — kept symmetric so tests can round-trip. */
export const serializeBuilderDoc = (doc: BuilderDoc): string => JSON.stringify(doc);

/** Fresh empty Puck `Data` — the seed the editor opens for rows with
 * no stored document. Shape matches what `<Puck>`/`<Render>` expect
 * (`root.props` + `content` + `zones`). */
export const emptyBuilderData = (): {
	root: { props: Record<string, never> };
	content: never[];
	zones: Record<string, never>;
} => ({ root: { props: {} }, content: [], zones: {} });

/** Wrap raw Puck `Data` into the versioned stored shape. */
export const builderDocFromData = (data: unknown): BuilderDoc => ({
	version: BUILDER_DOC_VERSION,
	data,
});

/**
 * Bring `doc` up to `currentVersion` by applying
 * {@link BUILDER_DOC_MIGRATIONS} in order. Unknown/future versions and
 * docs newer than `currentVersion` pass through unchanged (forward
 * compatibility — a newer writer's doc still renders via Puck's own
 * tolerance). `migrations`/`currentVersion` are parameters so tests
 * can exercise the chain without shipping fake steps.
 */
export const migrateBuilderDoc = (
	doc: BuilderDoc,
	migrations: readonly BuilderDocMigration[] = BUILDER_DOC_MIGRATIONS,
	currentVersion: number = BUILDER_DOC_VERSION,
): BuilderDoc => {
	let current = doc;
	// Guard against pathological inputs: a doc claiming an absurd
	// version would otherwise spin through undefined steps.
	while (current.version < currentVersion && current.version <= migrations.length) {
		const step = migrations[current.version - 1];
		/* v8 ignore next -- the `version <= migrations.length` guard keeps
		 * the index in range; the check only satisfies noUncheckedIndexedAccess. */
		if (step === undefined) break;
		current = { version: current.version + 1, data: step(current.data) };
	}
	return current;
};
