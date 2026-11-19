import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { DocumentStore, type DocumentRecord, type DocumentStoreError } from "@ktb/document-store";
import { defOwnerEnabled } from "@ktb/kernel";
import { PluginStates } from "@ktb/platform/plugin-states";
import { Permissions, splitPermission } from "@ktb/rbac";
import { Tenant, tenantScopeId } from "@ktb/tenant";

import {
	parseViewPath,
	viewKey,
	ViewDefinitions,
	type ViewDef,
	type ViewField,
} from "./definition.ts";
import { planFind, type ViewQueryInput } from "./plan.ts";
import { getPath, viewScalarText } from "./views/view-utils.ts";
import {
	toViewRecordWire,
	type ViewDetailWire,
	type ViewListWire,
	type ViewPageWire,
	type ViewRefLabels,
} from "./wire.ts";

/**
 * Views domain service: resolves contributed `view.def` definitions
 * and serves their records through `DocumentStore` — the read-side
 * complement of forms/wizards. Defs arrive via the `ViewDefinitions`
 * registry (app-host composition, same injection pattern as
 * `DocumentCollections`); records go through the store's tenant/owner
 * fencing unchanged, so a view can never read outside the caller's
 * visible scope.
 *
 * Authorization is two-layered like every plugin surface: the page
 * `guard` runs {@link Views.allows} (def exists + owner enabled +
 * permission grant — owner enablement is the runtime `PluginStates`
 * check shared with @ktb/triggers/@ktb/flows) and the
 * loader/fn re-check inside {@link Views.load}/`query` —
 * denial collapses to `null` (the host maps it to not-found).
 *
 * `ref` label resolution is deliberately bounded: only fields on the
 * VISIBLE page are resolved, deduplicated per `(collection, id)`, and
 * capped at {@link REF_LOOKUP_CAP} lookups per payload — each lookup
 * is a `DocumentStore.get` (the store's v1 JS-side scan makes this an
 * N+1 by design; a hot view graduates to a dedicated table or a
 * denormalized label field, same escape hatch as the store itself).
 */

/** Max `ref` target lookups per wire payload — beyond this cells fall
 * back to `#<id>`. */
export const REF_LOOKUP_CAP = 50;

/** Concurrent `DocumentStore.get` lookups per payload. Each get is a
 * store-side scan (v1 JS evaluation), so the cap bounds in-flight D1
 * round-trips without serializing the whole page. */
const REF_LOOKUP_CONCURRENCY = 8;

export interface ViewsShape {
	/** Cheap gate for the page `guard`: the path parses, a def owns the
	 * key, and its optional permission grant holds. No record fetch. */
	readonly allows: (path: string) => Effect.Effect<boolean>;
	/** Full payload for the wildcard loader: list mode on `/v/<key>`,
	 * detail mode on `/v/<key>/<docId>`. `null` → not-found/forbidden. */
	readonly load: (path: string) => Effect.Effect<ViewPageWire | null, DocumentStoreError>;
	/** Re-query a view's LIST payload with caller offset + declared
	 * interactive-filter values (the `viewQueryFn` server fn). Detail
	 * paths return null — detail views don't paginate. */
	readonly query: (
		path: string,
		input?: ViewQueryInput,
	) => Effect.Effect<ViewPageWire | null, DocumentStoreError>;
}

export class Views extends Context.Service<Views, ViewsShape>()("@ktb/views/Views") {}

const defForKey = (defs: readonly ViewDef[], key: string): ViewDef | undefined =>
	defs.find((def) => viewKey(def) === key);

/** A view field whose `ref` format declares a resolvable target
 * collection — the only fields {@link resolveRefs} scans. */
type RefViewField = ViewField & { readonly refCollection: string };

const isRefField = (field: ViewField): field is RefViewField =>
	field.format === "ref" && field.refCollection !== undefined;

/** Fields whose `ref` format needs label resolution for a payload:
 * the list fields for list mode, `detailFields ?? fields` for detail. */
const refFieldsOf = (def: ViewDef, detail: boolean): readonly RefViewField[] =>
	(detail ? (def.detailFields ?? def.fields) : def.fields).filter(isRefField);

export const ViewsLive = Layer.effect(
	Views,
	Effect.gen(function* () {
		const store = yield* DocumentStore;
		const registry = yield* ViewDefinitions;
		// Permissions is an OPTIONAL port (rbac plugin may be disabled):
		// a declared `permission` with no grant service fails closed.
		const permissions = yield* Effect.serviceOption(Permissions);
		// PluginStates is likewise OPTIONAL: when bound, defs owned by
		// disabled plugins/packages resolve as unknown (404/null) on
		// every call — runtime enablement, same contract as @ktb/flows.
		const pluginStates = yield* Effect.serviceOption(PluginStates);

		const permissionAllows = (def: ViewDef): Effect.Effect<boolean> => {
			if (def.permission === undefined) return Effect.succeed(true);
			if (Option.isNone(permissions)) return Effect.succeed(false);
			const { resource, action } = splitPermission(def.permission);
			// P-084: views serve tenant-scoped document data, so the
			// grant check binds the ambient tenant under "strict" —
			// global (tenant_id NULL) grants do not bleed in. No bound
			// Tenant (personal/system scope) → tenant-less check,
			// global grants only.
			return Effect.gen(function* () {
				const scopeId = tenantScopeId(yield* Tenant);
				return yield* permissions.value.can(resource, action, {
					tenantId: scopeId ?? undefined,
					tenantPolicy: "strict",
				});
			});
		};

		/** Resolve def + permission for a path; null when either fails. */
		const resolve = (
			path: string,
		): Effect.Effect<{ readonly def: ViewDef; readonly docId: number | null } | null> =>
			Effect.gen(function* () {
				const segments = parseViewPath(path);
				if (segments === null) return null;
				const def = defForKey(registry.views, segments.key);
				if (def === undefined) return null;
				// A disabled owner makes the def invisible — same null as
				// an unknown key, so enablement leaks nothing.
				if (Option.isSome(pluginStates)) {
					const enabled = yield* pluginStates.value.enabledIds();
					if (!defOwnerEnabled(registry.ownerIndex, def.owner, enabled)) return null;
				}
				if (!(yield* permissionAllows(def))) return null;
				return { def, docId: segments.docId };
			});

		/**
		 * Collect the distinct `ref` targets visible in `records`
		 * (deduped, capped), fetch each target record and map
		 * `"collection:id"` → label. Per-target failures (unknown
		 * collection, invisible/missing record) are swallowed — the
		 * cell falls back to `#<id>`.
		 */
		const resolveRefs = (
			fields: readonly RefViewField[],
			records: readonly DocumentRecord[],
		): Effect.Effect<ViewRefLabels> =>
			Effect.gen(function* () {
				// First declaration of a (collection, id) target wins its
				// label field — multiple source fields may share a target
				// collection with different refLabelField paths (documented
				// v1: the first rendered field's label is used).
				const targets = new Map<string, { collection: string; id: number; labelField?: string }>();
				for (const record of records) {
					for (const field of fields) {
						const collection = field.refCollection;
						const value = getPath(record.data, field.field);
						if (typeof value !== "number" || !Number.isFinite(value)) continue;
						const key = `${collection}:${value}`;
						if (!targets.has(key)) {
							targets.set(key, {
								collection,
								id: value,
								...(field.refLabelField === undefined ? {} : { labelField: field.refLabelField }),
							});
						}
					}
				}
				const entries = [...targets.entries()].slice(0, REF_LOOKUP_CAP);
				const pairs = yield* Effect.forEach(
					entries,
					([key, target]) =>
						Effect.gen(function* () {
							const record = yield* store
								.get(target.collection, target.id)
								.pipe(Effect.catch(() => Effect.succeed(null)));
							if (record === null) return null;
							const labelValue =
								target.labelField === undefined
									? undefined
									: getPath(record.data, target.labelField);
							const label =
								labelValue === undefined || labelValue === null
									? `#${target.id}`
									: viewScalarText(labelValue);
							return [key, label] as const;
						}),
					{ concurrency: REF_LOOKUP_CONCURRENCY },
				);
				return Object.fromEntries(pairs.filter((p): p is readonly [string, string] => p !== null));
			});

		const listWire = (
			def: ViewDef,
			key: string,
			result: { readonly rows: readonly DocumentRecord[]; readonly total: number },
			pageSize: number,
			offset: number,
		): Effect.Effect<ViewListWire> =>
			Effect.map(resolveRefs(refFieldsOf(def, false), result.rows), (refs) => ({
				mode: "list",
				path: `/v/${key}`,
				def,
				rows: result.rows.map(toViewRecordWire),
				total: result.total,
				pageSize,
				offset,
				refs,
			}));

		const detailWire = (
			def: ViewDef,
			key: string,
			docId: number,
		): Effect.Effect<ViewDetailWire, DocumentStoreError> =>
			Effect.gen(function* () {
				const record = yield* store.get(def.collection, docId);
				const refs = yield* resolveRefs(refFieldsOf(def, true), record === null ? [] : [record]);
				return {
					mode: "detail",
					path: `/v/${key}`,
					def,
					record: record === null ? null : toViewRecordWire(record),
					refs,
				};
			});

		const loadList = (
			def: ViewDef,
			key: string,
			input: ViewQueryInput,
		): Effect.Effect<ViewListWire, DocumentStoreError> =>
			Effect.gen(function* () {
				const planned = planFind(def, input);
				const result = yield* store.find(def.collection, planned.find);
				return yield* listWire(def, key, result, planned.pageSize, planned.offset);
			});

		return Views.of({
			allows: (path) => Effect.map(resolve(path), (resolved) => resolved !== null),
			load: (path) =>
				Effect.gen(function* () {
					const resolved = yield* resolve(path);
					if (resolved === null) return null;
					const key = viewKey(resolved.def);
					if (resolved.docId !== null) {
						return yield* detailWire(resolved.def, key, resolved.docId);
					}
					return yield* loadList(resolved.def, key, {});
				}).pipe(Effect.catchTag("UnknownCollection", () => Effect.succeed(null))),
			query: (path, input = {}) =>
				Effect.gen(function* () {
					const resolved = yield* resolve(path);
					// Detail paths don't paginate — only list payloads refetch.
					if (resolved === null || resolved.docId !== null) return null;
					return yield* loadList(resolved.def, viewKey(resolved.def), input);
				}).pipe(
					Effect.catchTag("UnknownCollection", () => Effect.succeed(null)),
					// Interactive filter values are raw user input — a bad
					// operand shape ($in without an array, an invalid
					// $regex, …) fails store-side validation as
					// InvalidDocumentQuery. Collapse it to null like
					// UnknownCollection: the caller sees "no payload"
					// instead of a 500. Fixed-filter defs are validated
					// at assertViewDef time, so this can only come from
					// interactive input or a store-side rule change.
					Effect.catchTag("InvalidDocumentQuery", () => Effect.succeed(null)),
				),
		});
	}),
);
