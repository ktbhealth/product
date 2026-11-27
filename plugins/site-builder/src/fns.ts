import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Schema } from "effect";

import { Layouts } from "@ktb/layouts/service";
import { Pages } from "@ktb/pages/service";
import { PlatformAdmin } from "@ktb/platform";
import { pluginHandler, runAs, sessionHandler } from "@ktb/server-fns";
import { migrateBuilderDoc, parseBuilderDoc, serializeBuilderDoc } from "@ktb/builder";

// Site-builder server functions (PL-014 / P-109): admin-gated load +
// save of the versioned `builderJson` document on `pages`/`layouts`
// rows. Handled domain failures (Forbidden / PageNotFound /
// LayoutNotFound / InvalidBuilderDoc) collapse to null — the same
// "not visible / not saved" contract the other plugin fns use; other
// errors still propagate. The admin gate runs twice by design: the
// `asAdmin` wrapper AND inside each service method (defense in depth,
// same pattern as the pages/layouts fns).

/** Which entity a builder document belongs to. */
export type BuilderTargetKind = "page" | "layout";

/** Wire shape the editor page loads: identity + display fields + the
 * stored `builderJson` text (null = never built — the editor opens an
 * empty document). */
export interface BuilderDocumentWire {
	readonly kind: BuilderTargetKind;
	readonly id: number;
	readonly title: string;
	readonly subtitle: string | null;
	readonly builderJson: string | null;
}

const DocInput = Schema.Struct({
	kind: Schema.Literals(["page", "layout"]),
	id: Schema.Number,
});
const SaveInput = Schema.Struct({
	kind: Schema.Literals(["page", "layout"]),
	id: Schema.Number,
	builderJson: Schema.String,
});

const decodeDocInput = Schema.decodeUnknownSync(DocInput);
const decodeSaveInput = Schema.decodeUnknownSync(SaveInput);

const HANDLED_TAGS = ["Forbidden", "PageNotFound", "LayoutNotFound", "InvalidBuilderDoc"] as const;

const isHandled = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	(HANDLED_TAGS as readonly string[]).includes(String((error as { _tag?: unknown })._tag));

/** Run `eff` as the session user after the PlatformAdmin gate. */
const asAdmin = <A, E>(
	user: { readonly id: string; readonly email?: string },
	eff: Effect.Effect<A, E, unknown>,
): Promise<A> =>
	runAs(
		user,
		Effect.gen(function* () {
			const platformAdmin = yield* PlatformAdmin;
			yield* platformAdmin.requireAdmin();
			return yield* eff;
		}),
	);

/** Load one entity's builder document for the editor; `null` for
 * non-admins and missing rows. */
export const builderDocumentFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeDocInput(input))
	.handler(
		pluginHandler(
			"site-builder.panel",
			sessionHandler(async ({ data, user }): Promise<BuilderDocumentWire | null> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						if (data.kind === "page") {
							const pages = yield* Effect.serviceOption(Pages);
							if (Option.isNone(pages)) return null;
							const row = yield* pages.value.adminGet(data.id);
							if (row === null) return null;
							return {
								kind: "page" as const,
								id: row.id,
								title: row.title,
								subtitle: row.path,
								builderJson: row.builderJson,
							};
						}
						const layouts = yield* Effect.serviceOption(Layouts);
						if (Option.isNone(layouts)) return null;
						const doc = yield* layouts.value.adminGet(data.id);
						if (doc === null) return null;
						return {
							kind: "layout" as const,
							id: doc.id,
							title: doc.name,
							subtitle: doc.description,
							builderJson: doc.builderJson,
						};
					}),
				).catch((error: unknown) => {
					if (isHandled(error)) return null;
					throw error;
				});
			}),
		),
	);

/** Persist the editor's Puck `Data` as the entity's versioned
 * `builderJson`. The client sends the serialized {@link BuilderDoc}
 * wrapper; the fn re-validates it (`parseBuilderDoc`), migrates to the
 * current schema version and stores the canonical serialization.
 * `null` for non-admins, missing rows and malformed docs. */
export const saveBuilderDocumentFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeSaveInput(input))
	.handler(
		pluginHandler(
			"site-builder.panel",
			sessionHandler(async ({ data, user }): Promise<boolean> => {
				const doc = parseBuilderDoc(data.builderJson);
				if (doc === null) return false;
				// Serialize the migrated doc itself — not builderDocFromData —
				// so a future-version doc keeps its claimed version instead of
				// being mislabeled as the current one.
				const canonical = serializeBuilderDoc(migrateBuilderDoc(doc));
				return asAdmin(
					user,
					Effect.gen(function* () {
						if (data.kind === "page") {
							const pages = yield* Effect.serviceOption(Pages);
							if (Option.isNone(pages)) return false;
							yield* pages.value.adminSetBuilderJson(data.id, canonical);
						} else {
							const layouts = yield* Effect.serviceOption(Layouts);
							if (Option.isNone(layouts)) return false;
							yield* layouts.value.adminSetBuilderJson(data.id, canonical);
						}
						return true;
					}),
				).catch((error: unknown) => {
					if (isHandled(error)) return false;
					throw error;
				});
			}),
		),
	);
