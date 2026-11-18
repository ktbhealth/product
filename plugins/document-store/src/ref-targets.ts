import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * External `ref` targets (T-149): the port that lets a `ref` field
 * point at a typed-table row owned by another plugin — e.g.
 * `f.ref({ entity: "patients" })` storing `patients.id` — instead of
 * forcing consumers to keep a bare id column and join by hand.
 *
 * Ownership is OPT-IN and typed: the entity's owning plugin registers
 * a checker at layer build, next to its own service layer:
 *
 *   const PatientsRefTargetsLive = Layer.effectDiscard(
 *   	Effect.gen(function* () {
 *   		const targets = yield* Effect.serviceOption(DocumentRefTargets);
 *   		if (Option.isNone(targets)) return; // document-store absent
 *   		const db = yield* Db;
 *   		yield* targets.value.register("patients", (ids) =>
 *   			Effect.promise(async () => {
 *   				const rows = await db
 *   					.select({ id: patients.id })
 *   					.from(patients)
 *   					.where(inArray(patients.id, [...ids]));
 *   				return new Set(rows.map((r) => r.id));
 *   			}),
 *   		);
 *   	}),
 *   );
 *
 * and merges it into its plugin `services` layer. Registration is a
 * composition-time side effect on a shared registry — like
 * `DocumentCollections`, it ignores plugin enablement: a disabled
 * entity owner's table still exists, so refs to it stay valid (the
 * same static-composition contract as contributed collections).
 *
 * Checkers answer EXISTENCE ONLY, batched: one call per write covers
 * every referenced id of that entity (mirroring `scopedExistingIds`
 * for document targets). They run inside the document-store service's
 * effect environment, so a checker may yield its own services (Db,
 * Tenant, …) — requirements are erased the same way plugin service
 * layers are: the runtime context satisfies them at call time.
 *
 * Delete semantics: entity refs declare `onDelete: "restrict" |
 * "nullify"` only — never `cascade` (document-store must not delete
 * rows of a table it does not own). When the ENTITY row is deleted,
 * the owner calls `DocumentStore.applyEntityDelete(entity, id, ctx)`
 * which scans every collection for refs to that id and applies each
 * field's policy — `restrict` fails `DocumentInUse`, `nullify` rewrites
 * the field to `null`. Until a plugin wires that call, entity refs are
 * write-validated but deletes are not enforced (documented v1 gap —
 * same best-effort posture as document refs, which are also
 * scope-bound).
 */

/** Batched existence check for one entity: given referenced ids,
 * resolve the subset that currently exists. Runs in the caller's
 * effect environment (services the checker needs must be provided to
 * the document-store layer graph — in practice `Db` from core). A
 * checker that fails is a plugin bug, not a runtime condition — the
 * service surfaces it as a defect. */
export type RefTargetExists = (
	ids: readonly number[],
) => Effect.Effect<ReadonlySet<number>, unknown, unknown>;

export interface DocumentRefTargetsShape {
	/** Register (or replace) the existence checker for `entity`.
	 * Entity names are owner-chosen slugs (`"patients"`); registering
	 * the same name twice is a packaging bug and throws. */
	readonly register: (entity: string, exists: RefTargetExists) => Effect.Effect<void>;
	/** The registered checker, or undefined when `entity` is unknown. */
	readonly get: (entity: string) => RefTargetExists | undefined;
}

/**
 * Registry of external `ref` targets, provided once by the composition
 * root (@ktb/app-host merges `DocumentRefTargetsLive` into `core`) so
 * every plugin layer — entity owners registering checkers AND
 * DocumentStore resolving them — shares ONE instance. Consumed via
 * `Effect.serviceOption` so document-store keeps working (document
 * refs only) when the service is absent.
 */
export class DocumentRefTargets extends Context.Service<
	DocumentRefTargets,
	DocumentRefTargetsShape
>()("@ktb/document-store/DocumentRefTargets") {}

/** Build a standalone registry value — tests and non-app compositions. */
export const makeDocumentRefTargets = (): DocumentRefTargetsShape => {
	const checkers = new Map<string, RefTargetExists>();
	return {
		register: (entity, exists) =>
			Effect.suspend(() => {
				if (checkers.has(entity)) {
					return Effect.die(new Error(`duplicate document ref target entity "${entity}"`));
				}
				checkers.set(entity, exists);
				return Effect.void;
			}),
		get: (entity) => checkers.get(entity),
	};
};

/** Shared-registry layer for the composition root's `core`. */
export const DocumentRefTargetsLive = Layer.sync(DocumentRefTargets, makeDocumentRefTargets);

/** Helper for entity owners: register `exists` when the document-store
 * port is present, no-op otherwise (document-store plugin absent or
 * disabled — its tables wouldn't exist either way). */
export const registerRefTarget = (
	entity: string,
	exists: RefTargetExists,
): Effect.Effect<void, never, DocumentRefTargets> =>
	Effect.gen(function* () {
		const targets = yield* DocumentRefTargets;
		yield* targets.register(entity, exists);
	});

/** `serviceOption` variant of {@link registerRefTarget} — for plugin
 * layers that must build whether or not document-store is installed. */
export const registerRefTargetIfPresent = (
	entity: string,
	exists: RefTargetExists,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const targetsOpt = yield* Effect.serviceOption(DocumentRefTargets);
		if (Option.isNone(targetsOpt)) return;
		yield* targetsOpt.value.register(entity, exists);
	});
