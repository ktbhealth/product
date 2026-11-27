import * as Context from "effect/Context";

import { API_KEY_PATTERN, COLLECTION_NAME_RE, isRecord, PERMISSION_RE } from "@ktb/dsl";
import { defineDefKind, type DefOwnerIndex } from "@ktb/kernel";

/**
 * API exposures as DATA — the `api.expose` contribution kind.
 *
 * Document-store collections are NOT public by default. A plugin opts a
 * collection into the HTTP surface by putting an
 * `apiExposureContribution(def)` entry in its manifest's generic
 * `contributions` array; the payload is plain JSON
 * (`PluginContribution.meta` is `JsonObject`), so no kernel changes are
 * needed. `@ktb/api` owns the kind descriptor, the def validator, the
 * `ApiExposures` registry (app-host composition, same injection pattern
 * as `DocumentCollections`/`ViewDefinitions`) and the `/api/documents/*`
 * splat route that serves only exposed collections.
 *
 * DEFAULT-DENY: no `api.expose` contribution → no endpoint. An unknown
 * key, an unexposed collection and a malformed path all answer the same
 * 404, so the surface never becomes a collection-enumeration oracle.
 *
 * v1 mount model: every exposure lives under the single splat subtree
 * `/api/documents/<key>[/<id>]`. `basePath` may RENAME the key but must
 * stay inside that subtree (`/api/documents/<key>`) — arbitrary mount
 * points would need per-exposure routes the kernel's virtual route
 * tree does not support.
 *
 * Extension points: `methods` (`API_METHODS`) is a CLOSED union — the
 * dispatch in ./service.ts is a fixed switch; there is no `hook`
 * escape hatch, custom verbs need a route contribution instead.
 */

/** The single mount subtree every exposure lives under. */
export const API_BASE_PATH = "/api/documents";

/** URL key charset — the `<key>` segment of `/api/documents/<key>`.
 * Slug-safe so keys round-trip through paths and query strings.
 * Re-exported from @ktb/dsl (the shared grammar). */
export { API_KEY_PATTERN };

/** The CRUD verbs an exposure can publish. `list`/`get` are reads;
 * `create`/`update`/`delete` are writes. */
export const API_METHODS = ["list", "get", "create", "update", "delete"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

/**
 * Read-only default: exposures that omit `methods` publish list+get
 * only. Writes are always an explicit opt-in — the safe default for a
 * public HTTP surface.
 */
export const API_DEFAULT_METHODS: readonly ApiMethod[] = ["list", "get"];

/** One API exposure — the unit plugins contribute. */
export interface ApiExposure {
	/** Document-store collection name the exposure serves. */
	readonly collection: string;
	/** Optional mount override — must be exactly
	 * `/api/documents/<key>` (single slug segment under the mounted
	 * subtree). The `<key>` becomes the URL key; the collection name
	 * is the default key. See the module doc for the v1 limitation. */
	readonly basePath?: string;
	/** Optional `"resource.action"` permission required for every
	 * non-public method — checked through the optional `Permissions`
	 * port (@ktb/rbac); absent service or denied grant fails closed
	 * (403). Ignored for anonymous `list`/`get` when `public: true`. */
	readonly permission?: string;
	/** Published methods — defaults to `["list", "get"]`. */
	readonly methods?: readonly ApiMethod[];
	/** `true` allows ANONYMOUS `list`/`get` (no session, no permission
	 * check). Writes are NEVER public: `create`/`update`/`delete` still
	 * require an authenticated session (and the declared permission,
	 * when present). Default false. */
	readonly public?: boolean;
	/** Owning plugin id — stamped from the contributing plugin when the
	 * manifest omits it. */
	readonly owner?: string;
}

/** The URL key an exposure mounts under: the `basePath` tail when
 * present, else the collection name. */
export const exposureKey = (def: ApiExposure): string =>
	def.basePath === undefined ? def.collection : def.basePath.slice(API_BASE_PATH.length + 1);

/** The full mount path for an exposure key — the inverse of
 * {@link exposureKey} for links/docs. */
export const exposurePath = (key: string): string => `${API_BASE_PATH}/${key}`;

/** Methods an exposure publishes (default read-only). */
export const exposureMethods = (def: ApiExposure): readonly ApiMethod[] =>
	def.methods ?? API_DEFAULT_METHODS;

/**
 * Validate an untyped manifest payload as an {@link ApiExposure}.
 * Throws with a caller-supplied context string — same packaging-bug
 * contract as `assertViewDef`/`assertCollectionDef`.
 */
export const assertApiExposure = (value: unknown, context: string): ApiExposure => {
	if (!isRecord(value)) {
		throw new Error(`${context}: api exposure must be an object`);
	}
	const { collection, basePath, permission, methods, public: isPublic, owner } = value;
	if (typeof collection !== "string" || !COLLECTION_NAME_RE.test(collection)) {
		throw new Error(`${context}: api exposure collection is not a valid collection name`);
	}
	let key: string;
	if (basePath === undefined) {
		key = collection;
	} else {
		const prefix = `${API_BASE_PATH}/`;
		if (typeof basePath !== "string" || !basePath.startsWith(prefix)) {
			throw new Error(
				`${context}: api exposure basePath must live under ${API_BASE_PATH}/ (got ${JSON.stringify(basePath)})`,
			);
		}
		const tail = basePath.slice(prefix.length);
		if (!API_KEY_PATTERN.test(tail) || tail.includes("/")) {
			throw new Error(
				`${context}: api exposure basePath ${JSON.stringify(basePath)} must be ${API_BASE_PATH}/<key> with a single slug segment`,
			);
		}
		key = tail;
	}
	if (permission !== undefined) {
		if (typeof permission !== "string" || !PERMISSION_RE.test(permission)) {
			throw new Error(
				`${context}: api exposure "${key}" permission must use the "resource.action" spelling`,
			);
		}
	}
	let checkedMethods: readonly ApiMethod[] | undefined;
	if (methods !== undefined) {
		if (!Array.isArray(methods) || methods.length === 0) {
			throw new Error(`${context}: api exposure "${key}" methods must be a non-empty array`);
		}
		const seen = new Set<ApiMethod>();
		for (const method of methods) {
			if (typeof method !== "string" || !API_METHODS.includes(method as ApiMethod)) {
				throw new Error(
					`${context}: api exposure "${key}" method ${JSON.stringify(method)} is not one of ${API_METHODS.join(", ")}`,
				);
			}
			seen.add(method as ApiMethod);
		}
		checkedMethods = [...seen];
	}
	if (isPublic !== undefined && typeof isPublic !== "boolean") {
		throw new Error(`${context}: api exposure "${key}" public must be a boolean`);
	}
	if (owner !== undefined && typeof owner !== "string") {
		throw new Error(`${context}: api exposure "${key}" owner must be a string`);
	}
	return {
		collection,
		...(basePath === undefined ? {} : { basePath }),
		...(permission === undefined ? {} : { permission }),
		...(checkedMethods === undefined ? {} : { methods: checkedMethods }),
		...(isPublic === undefined ? {} : { public: isPublic }),
		...(owner === undefined ? {} : { owner }),
	};
};

/**
 * The `api.expose` contribution pipeline — kind descriptor, define /
 * contribution / to-def / collect / registry builders — owned by
 * `defineDefKind` (@ktb/kernel). Manifest ids and the duplicate guard
 * key on the URL key (`exposureKey`), not the collection name; the
 * contribution builder re-asserts the def so an untyped caller still
 * gets a packaging-bug throw instead of a garbage key.
 */
const apiExposureKind = defineDefKind<ApiExposure, "exposures">({
	id: "api.expose",
	// app-host.server: the Api service resolves exposures through
	// ApiExposures. plugin-manager: exposures are JSON data tooling may
	// enumerate via ctx.plugins.
	consumers: ["app-host.server", "plugin-manager"],
	assert: assertApiExposure,
	defId: (def) => def.collection,
	noun: "api exposure",
	field: "exposures",
	contributionId: (def) => exposureKey(assertApiExposure(def, "apiExposureContribution")),
	uniqueKey: exposureKey,
	uniqueLabel: "api exposure key",
});

/** The registered contribution kind for API exposures. */
export const API_EXPOSE_KIND = apiExposureKind.KIND;

/**
 * Declare an exposure. Everything is data — the result is
 * JSON-serializable by construction so it can be dropped into
 * `PluginContribution.meta` unchanged.
 */
export const defineApiExposure = apiExposureKind.define;

/**
 * Build the manifest entry a plugin adds to `contributions`:
 *
 * ```ts
 * contributions: [apiExposureContribution(myExposure)]
 * ```
 *
 * `meta` carries the whole definition (JSON data); `id` is the URL key.
 */
export const apiExposureContribution = apiExposureKind.contribution;

/** Narrow a collected `PluginContribution` back to a definition.
 * Throws on malformed entries — same packaging-bug contract as
 * {@link assertApiExposure}. `owner` falls back to the contributing
 * plugin id. */
export const toApiExposure = apiExposureKind.toDef;

/**
 * Collect every `api.expose` contribution across `plugins` (expected in
 * topo order — pass the output of `orderPlugins`/`ctx.plugins`).
 * Duplicate URL keys are a packaging bug — this throws rather than
 * letting the first contribution silently shadow the rest.
 */
export const collectApiExposures = apiExposureKind.collect;

/**
 * The ordered exposure registry the composition root provides to the
 * `Api` service — the layer @ktb/app-host merges into `core` next to
 * `makePluginStatesLive(plugins)`/`makeDocumentCollections(plugins)`.
 *
 * `ownerIndex` is optional so hand-built registries (tests, tooling)
 * keep working; `makeApiExposures` always populates it. The Api
 * service re-checks each exposure's `owner` against
 * `PluginStates.enabledIds()` per request — a disabled plugin's
 * exposure answers the same 404 as an unexposed collection.
 */
export class ApiExposures extends Context.Service<
	ApiExposures,
	{
		readonly exposures: readonly ApiExposure[];
		readonly ownerIndex?: DefOwnerIndex;
	}
>()("@ktb/api/ApiExposures") {}

/** Build the `ApiExposures` service value for a plugin graph. */
export const makeApiExposures = apiExposureKind.makeRegistry;
