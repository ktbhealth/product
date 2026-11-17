import * as Context from "effect/Context";
import type { JsonObject } from "effect/Schema";

import {
	collectKindContributions,
	GENERIC_CONTRIBUTION_SLOT,
	type ContributionKindDescriptor,
	type Plugin,
	type PluginContribution,
} from "@ktb/kernel";

import type { Fields } from "./fields.ts";
import { checkValue } from "./validate.ts";

/**
 * Collection declarations as DATA (P-089). A plugin contributes a
 * document collection by putting a `documentCollectionContribution(def)`
 * entry in its manifest's generic `contributions` array — the payload
 * is plain JSON (`PluginContribution.meta` is `JsonObject`), so no
 * kernel changes were needed: `DOCUMENT_COLLECTION_KIND` registers the
 * kind on the generic channel and consumers opt in via
 * `collectKindContributions`.
 *
 * The app host collects every contributed definition once at composition
 * time (`collectDocumentCollections` over the topo-ordered registry)
 * and provides them to the `DocumentStore` service through the
 * `DocumentCollections` service — the same injection pattern
 * `makePluginStatesLive(plugins)` uses in @ktb/app-host.
 */

/** The registered contribution kind for document collections. */
export const DOCUMENT_COLLECTION_KIND: ContributionKindDescriptor = {
	id: "document.collection",
	slot: GENERIC_CONTRIBUTION_SLOT,
	consumers: ["app-host.server", "plugin-manager"],
	ordering: "topo",
};

/** Declared secondary indexes — v1 stores them in `schema_json` for
 * tooling/future DB-side indexes; records live in one shared table so
 * they are NOT created as SQL indexes. Entries are dotted field paths. */
export type CollectionIndex = string;

/**
 * A permission requirement: one `"resource.action"` string or an
 * array of alternatives (ANY grant satisfies the check). Strings use
 * the same spelling as `Permissions.can(resource, action)` calls and
 * the rbac vocabulary — split at the FIRST dot (`"i18n.messages.read"`
 * → resource `"i18n"`, action `"messages.read"`), so collection names
 * containing dots stay inside the action segment.
 *
 * Tenant-scoped grants (P-084) compose automatically: the service
 * passes the ambient `Tenant` id to `Permissions.can`, whose grant
 * resolution already unions global (`tenant_id NULL`) and
 * tenant-pinned rows — a global grant satisfies tenant-scoped checks,
 * a tenant-pinned grant only its own tenant.
 */
export type CollectionPermissionSpec = string | readonly string[];

/** Per-field permission overrides — whole-field allow/deny (no partial
 * masking): a `read`-denied field is stripped from returned documents;
 * a `write`-denied field rejects any write that touches it. Field names
 * are top-level `data` keys (same namespace as `fields`). */
export interface CollectionFieldPermissions {
	readonly read?: CollectionPermissionSpec;
	readonly write?: CollectionPermissionSpec;
}

/**
 * Optional collection-level RBAC gate (T-128). When ABSENT the
 * collection keeps the original contract: owner/tenant row fencing
 * only, no grant checks. When PRESENT the service checks
 * `Permissions.can(...)` for the bound `Principal` on every record
 * operation — `read` gates get/find, `write` gates insert/update,
 * `delete` gates delete — and fails `Forbidden` on denial. An absent
 * `Permissions` service fails CLOSED (permissioned collections are
 * unusable without the rbac citizen). `ctx.unscoped` system flows
 * (DocumentStoreAdmin) bypass the checks entirely — they are already
 * gated by PlatformAdmin. Declaring only some operations gates just
 * those (e.g. `{ write: "…" }` leaves reads fencing-only).
 */
export interface CollectionPermissions {
	readonly read?: CollectionPermissionSpec;
	readonly write?: CollectionPermissionSpec;
	readonly delete?: CollectionPermissionSpec;
	readonly fields?: Record<string, CollectionFieldPermissions>;
}

/** A document collection definition — the unit plugins contribute. */
export interface DocumentCollection<F extends Fields = Fields> {
	/** Collection name — unique across all contributors; used as the
	 * `collection` argument of every DocumentStore method. */
	readonly name: string;
	/** Schema version — bump on breaking field changes. `ensureCollection`
	 * keeps the highest version seen (see service.ts). */
	readonly version: number;
	/** Field map — see ./fields.ts for the DSL and InferFields typing. */
	readonly fields: F;
	/** Declared index paths (dotted), informational in v1. */
	readonly indexes?: readonly CollectionIndex[];
	/** Optional RBAC gate — see {@link CollectionPermissions}. */
	readonly permissions?: CollectionPermissions;
	/** Owning plugin id — stamped from the contributing plugin when the
	 * manifest omits it. */
	readonly owner?: string;
}

/**
 * Declare a collection. `version` defaults to 1; everything else is
 * required data — the result is JSON-serializable by construction so it
 * can be dropped into `PluginContribution.meta` unchanged.
 */
export const defineCollection = <const F extends Fields>(options: {
	readonly name: string;
	readonly version?: number;
	readonly fields: F;
	readonly indexes?: readonly CollectionIndex[];
	readonly permissions?: CollectionPermissions;
	readonly owner?: string;
}): DocumentCollection<F> => ({
	name: options.name,
	version: options.version ?? 1,
	fields: options.fields,
	...(options.indexes === undefined ? {} : { indexes: options.indexes }),
	...(options.permissions === undefined ? {} : { permissions: options.permissions }),
	...(options.owner === undefined ? {} : { owner: options.owner }),
});

const COLLECTION_NAME_RE = /^[a-z][a-z0-9._-]{0,99}$/;

/** Field names become literal keys of the stored `data` JSON document.
 * Restricting them to identifier shape (plus the denylist below) keeps
 * prototype-polluting names and dotted names — which would collide
 * with query path syntax — out of the document shape entirely. */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Identifier-shaped but still dangerous as own data keys —
 * `__proto__` assignments mutate prototypes on plain objects,
 * `constructor`/`prototype` collide with Object.prototype members
 * in `in`-style lookups downstream. */
const FORBIDDEN_FIELD_NAMES: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

/** Runtime shape check for a def arriving over the wire (contribution
 * meta or a stored `schema_json` blob). Throws on malformed data —
 * a bad manifest is a packaging bug, not a runtime condition. */
export const assertCollectionDef = (value: unknown, source: string): DocumentCollection => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`document collection from ${source}: expected an object`);
	}
	const def = value as Record<string, unknown>;
	if (typeof def.name !== "string" || !COLLECTION_NAME_RE.test(def.name)) {
		throw new Error(`document collection from ${source}: invalid name ${JSON.stringify(def.name)}`);
	}
	if (typeof def.version !== "number" || !Number.isInteger(def.version)) {
		throw new Error(`document collection "${def.name}": version must be an integer`);
	}
	if (typeof def.fields !== "object" || def.fields === null || Array.isArray(def.fields)) {
		throw new Error(`document collection "${def.name}": fields must be an object`);
	}
	for (const [field, descriptor] of Object.entries(def.fields as Record<string, unknown>)) {
		if (!FIELD_NAME_RE.test(field) || FORBIDDEN_FIELD_NAMES.has(field)) {
			throw new Error(
				`document collection "${def.name}": invalid field name ${JSON.stringify(field)}`,
			);
		}
		if (
			typeof descriptor !== "object" ||
			descriptor === null ||
			!((descriptor as { kind?: unknown }).kind !== undefined)
		) {
			throw new Error(`document collection "${def.name}": field "${field}" is malformed`);
		}
		// `default` arrives as untyped JSON — validate it against the
		// descriptor now (packaging bug → defect) AND again at write
		// time in validate.ts for defs that bypass this assertion.
		const defDescriptor = descriptor as {
			default?: unknown;
		};
		if (defDescriptor.default !== undefined) {
			const issue = checkValue(
				descriptor as Parameters<typeof checkValue>[0],
				defDescriptor.default,
				field,
			);
			if (issue !== null) {
				throw new Error(`document collection "${def.name}": ${issue}`);
			}
		}
	}
	assertPermissionsBlock(def.permissions, def.name);
	return def as unknown as DocumentCollection;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** One permission spec: a non-empty string or a non-empty array of
 * non-empty strings (ANY-of alternatives). */
const assertPermissionSpec = (value: unknown, path: string): void => {
	const specOk =
		(typeof value === "string" && value.length > 0) ||
		(Array.isArray(value) &&
			value.length > 0 &&
			value.every((s) => typeof s === "string" && s.length > 0));
	if (!specOk) {
		throw new Error(
			`document collection permissions at ${path}: expected a non-empty string or string array`,
		);
	}
};

/** Runtime shape check for the optional `permissions` block — same
 * packaging-bug contract as the rest of the def (throws, never a
 * typed error). Unknown keys are tolerated (forward-compat); only the
 * known ops/fields are shape-checked. */
const assertPermissionsBlock = (value: unknown, collectionName: string): void => {
	if (value === undefined) return;
	if (!isPlainObject(value)) {
		throw new Error(`document collection "${collectionName}": permissions must be an object`);
	}
	for (const op of ["read", "write", "delete"] as const) {
		const spec = value[op];
		if (spec !== undefined) assertPermissionSpec(spec, `permissions.${op}`);
	}
	const fields = value.fields;
	if (fields === undefined) return;
	if (!isPlainObject(fields)) {
		throw new Error(
			`document collection "${collectionName}": permissions.fields must be an object`,
		);
	}
	for (const [field, rule] of Object.entries(fields)) {
		if (!FIELD_NAME_RE.test(field) || FORBIDDEN_FIELD_NAMES.has(field)) {
			throw new Error(
				`document collection "${collectionName}": invalid permissions.fields key ${JSON.stringify(field)}`,
			);
		}
		if (!isPlainObject(rule)) {
			throw new Error(
				`document collection "${collectionName}": permissions.fields.${field} must be an object`,
			);
		}
		for (const op of ["read", "write"] as const) {
			const spec = rule[op];
			if (spec !== undefined) {
				assertPermissionSpec(spec, `permissions.fields.${field}.${op}`);
			}
		}
	}
};

/**
 * Build the manifest entry a plugin adds to `contributions`:
 *
 * ```ts
 * contributions: [documentCollectionContribution(myCollection)]
 * ```
 *
 * `meta` carries the whole definition (JSON data); `id`/`version`
 * mirror the def for tooling that reads them without decoding meta.
 */
export const documentCollectionContribution = (def: DocumentCollection): PluginContribution => ({
	kind: DOCUMENT_COLLECTION_KIND.id,
	id: def.name,
	version: String(def.version),
	// Defs are pure JSON by construction (fields.ts keeps every
	// descriptor JSON-shaped) — the cast bridges the typed view onto
	// the serializable contract.
	meta: def as unknown as JsonObject,
});

/** Narrow a collected `PluginContribution` back to a definition.
 * Throws on malformed entries — same packaging-bug contract as
 * `toEvalContribution`. `owner` falls back to the contributing plugin id. */
export const toDocumentCollection = (
	entry: PluginContribution,
	pluginId: string,
): DocumentCollection => {
	const def = assertCollectionDef(entry.meta, `plugin "${pluginId}" contribution "${entry.id}"`);
	return def.owner === undefined ? { ...def, owner: pluginId } : def;
};

/**
 * The ordered collection registry the composition root provides to
 * `DocumentStore`. `collections` is the topo-ordered, owner-stamped
 * result of {@link collectDocumentCollections} — captured once at
 * layer build like `PluginStates`' registry view.
 */
export class DocumentCollections extends Context.Service<
	DocumentCollections,
	{ readonly collections: readonly DocumentCollection[] }
>()("@ktb/document-store/DocumentCollections") {}

/**
 * Collect every `document.collection` contribution across the ordered
 * plugin registry — plugin topo order then manifest declaration order.
 * This is what @ktb/app-host calls with its discovered `plugins` list.
 *
 * Two deliberate properties:
 * - Collections are collected from the FULL registry, ignoring
 *   plugin enablement (`PluginStates`). Enablement gates dispatch —
 *   routes/CQRS of a disabled plugin never run — but the collection
 *   registry is static composition data; a disabled plugin's tables
 *   and contributed defs simply go unused. Filtering by enabled ids
 *   here would be wrong anyway: enabled state is runtime/DB-backed
 *   and can change without rebuilding layers.
 * - Duplicate collection names across contributors are a packaging
 *   bug — this throws rather than silently letting the last
 *   contribution win (service.ts indexes defs by name).
 */
export const collectDocumentCollections = (
	plugins: readonly Plugin[],
): readonly DocumentCollection[] => {
	const collected = collectKindContributions(plugins, DOCUMENT_COLLECTION_KIND).map((entry) =>
		toDocumentCollection(entry.payload as PluginContribution, entry.plugin.id),
	);
	const seen = new Set<string>();
	for (const def of collected) {
		if (seen.has(def.name)) {
			throw new Error(
				`duplicate document collection "${def.name}" contributed by multiple plugins`,
			);
		}
		seen.add(def.name);
	}
	return collected;
};

/** Build the `DocumentCollections` service value for a plugin graph —
 * the layer @ktb/app-host merges into `core` next to
 * `makePluginStatesLive(plugins)`. */
export const makeDocumentCollections = (
	plugins: readonly Plugin[],
): { readonly collections: readonly DocumentCollection[] } => ({
	collections: collectDocumentCollections(plugins),
});
