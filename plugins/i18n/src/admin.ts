import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, eq, sql } from "drizzle-orm";

import { audit, auditServicesPlugin } from "@ktb/audit";
import { Forbidden, Principal } from "@ktb/authz";
import { Db } from "@ktb/db";
import { definePlugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, type PlatformAdminShape } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";
import { rbacServicesPlugin } from "@ktb/rbac-plugin";
import { parseMessage } from "@ktb/i18n";

import {
	I18nAdmin,
	I18nValidationError,
	I18N_EDIT_ACTION,
	I18N_LOCALES_ACTION,
	I18N_READ_ACTION,
	I18N_RESOURCE,
	type I18nExportPayload,
	type MessageId,
	type NamespaceInfo,
} from "./contract.ts";
import { replaceDocValue } from "./crdt.ts";
import { I18nRuntime } from "./runtime.ts";
import { i18nCrdtUpdates, i18nLocales, i18nMessages, i18nNamespaces } from "./schema.ts";
import { getMessageRow, listCrdtUpdates, listLocales, listMessageRows } from "./store.ts";

export {
	I18nAdmin,
	I18nValidationError,
	I18N_EDIT_ACTION,
	I18N_LOCALES_ACTION,
	I18N_READ_ACTION,
	I18N_RESOURCE,
	type I18nAdminShape,
	type I18nExportPayload,
	type LocaleInfo,
	type MessageId,
	type NamespaceInfo,
	type SaveDraftInput,
} from "./contract.ts";

/**
 * Panel write path (P-083 / PL-008 Phase 3). Copy edits are data
 * mutations: every save validates the MF1-subset template, appends a
 * Loro op to the message's CRDT log (concurrent edits merge), and
 * stages the result in `draft_value` — `value` only moves on
 * `publish`, which is also the moment the isolate cache invalidates.
 *
 * Access: `i18n.messages.read|edit` grants via @ktb/rbac, with the
 * PlatformAdmin allowlist as the bootstrap path (same orPlatformAdmin
 * contract as patients/consultations).
 */

const MSG_PATH = "i18n.messages.edit";

const orAdmin = (platformAdmin: PlatformAdminShape, check: Effect.Effect<void, Forbidden>) =>
	check.pipe(
		Effect.catchTag("Forbidden", (err) =>
			platformAdmin.requireAdmin().pipe(Effect.catchTag("Forbidden", () => Effect.fail(err))),
		),
	);

const forbidden = (path: string) => Effect.fail(new Forbidden({ path }));

export const I18nAdminLive = Layer.effect(
	I18nAdmin,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		const permissionsOpt = yield* Effect.serviceOption(Permissions);
		const runtime = yield* I18nRuntime;

		/** Grant check bound to the request Principal; admin allowlist
		 * is the fallback when the rbac grant is absent/denied. */
		const requirePermission = (action: string, path: string) =>
			Effect.gen(function* () {
				if (Option.isSome(permissionsOpt)) {
					const check = permissionsOpt.value.requirePermission(I18N_RESOURCE, action);
					yield* orAdmin(platformAdmin, check);
					return;
				}
				yield* platformAdmin
					.requireAdmin()
					.pipe(Effect.catchTag("Forbidden", () => forbidden(path)));
			});

		const canRead = Effect.gen(function* () {
			if (Option.isSome(permissionsOpt)) {
				const ok = yield* permissionsOpt.value.can(I18N_RESOURCE, I18N_READ_ACTION);
				if (ok) return true;
			}
			return yield* platformAdmin.requireAdmin().pipe(
				Effect.as(true),
				Effect.catchTag("Forbidden", () => Effect.succeed(false)),
			);
		});

		const actorId = Effect.map(Principal, (p) => p?.userId ?? "");

		const appendCrdt = (id: MessageId, value: string) =>
			Effect.gen(function* () {
				const updates = yield* Effect.promise(() => listCrdtUpdates(db, id));
				const { update } = replaceDocValue(updates, value);
				const actor = yield* actorId;
				yield* Effect.promise(() =>
					db.insert(i18nCrdtUpdates).values({
						namespace: id.namespace,
						key: id.key,
						locale: id.locale,
						scope: id.scope,
						scopeId: id.scopeId,
						update,
						actorId: actor,
					}),
				);
			});

		return I18nAdmin.of({
			namespaces: () =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_READ_ACTION, "i18n.messages.read");
					const [registered, counts] = yield* Effect.all([
						Effect.promise(() => db.select().from(i18nNamespaces)),
						Effect.promise(() => listMessageRows(db)),
					]);
					const byNs = new Map<string, number>();
					for (const m of counts) byNs.set(m.namespace, (byNs.get(m.namespace) ?? 0) + 1);
					const seen = new Set<string>();
					const out: NamespaceInfo[] = [];
					for (const r of registered) {
						seen.add(r.namespace);
						out.push({
							namespace: r.namespace,
							pluginId: r.pluginId,
							defaultLocale: r.defaultLocale,
							messageCount: byNs.get(r.namespace) ?? 0,
						});
					}
					// Namespaces present only as message rows (pre-registration).
					for (const [namespace, messageCount] of byNs) {
						if (!seen.has(namespace)) {
							out.push({ namespace, pluginId: "", defaultLocale: "en", messageCount });
						}
					}
					return out.sort((a, b) => a.namespace.localeCompare(b.namespace));
				}),

			locales: () =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_READ_ACTION, "i18n.messages.read");
					const rows = yield* Effect.promise(() => listLocales(db));
					return rows;
				}),

			messages: (filter = {}) =>
				Effect.gen(function* () {
					const allowed = yield* canRead;
					if (!allowed) return yield* forbidden("i18n.messages.read");
					return yield* Effect.promise(() => listMessageRows(db, filter));
				}),

			saveDraft: (input) =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_EDIT_ACTION, MSG_PATH);
					const kind = input.kind ?? "text";
					const parsed = parseMessage(kind, input.value);
					if (!parsed.ok) {
						return yield* Effect.fail(new I18nValidationError({ error: parsed.error }));
					}
					const sig = input.params ?? parsed.message.params;
					const id: MessageId = {
						namespace: input.namespace,
						key: input.key,
						locale: input.locale,
						scope: input.scope ?? "global",
						scopeId: input.scopeId ?? "",
					};
					yield* appendCrdt(id, input.value);
					const existing = yield* Effect.promise(() => getMessageRow(db, id));
					if (existing === undefined) {
						yield* Effect.promise(() =>
							db.insert(i18nMessages).values({
								namespace: id.namespace,
								key: id.key,
								locale: id.locale,
								scope: id.scope,
								scopeId: id.scopeId,
								kind,
								value: "",
								draftValue: input.value,
								status: "draft",
								params: sig,
								version: 1,
							}),
						);
					} else {
						yield* Effect.promise(() =>
							db
								.update(i18nMessages)
								.set({
									draftValue: input.value,
									kind,
									params: sig,
									updatedAt: new Date(),
								})
								.where(
									and(
										eq(i18nMessages.namespace, id.namespace),
										eq(i18nMessages.key, id.key),
										eq(i18nMessages.locale, id.locale),
										eq(i18nMessages.scope, id.scope),
										eq(i18nMessages.scopeId, id.scopeId),
									),
								),
						);
					}
					yield* audit({
						action: "i18n.message.draft",
						targetType: "i18n_message",
						detail: { ...id, kind },
					});
				}),

			publish: (id) =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_EDIT_ACTION, MSG_PATH);
					const row = yield* Effect.promise(() => getMessageRow(db, id));
					const draft = row?.draftValue;
					if (row === undefined || draft === null || draft === undefined) {
						return yield* forbidden(MSG_PATH);
					}
					yield* Effect.promise(() =>
						db
							.update(i18nMessages)
							.set({
								value: draft,
								draftValue: null,
								status: "published",
								version: sql`${i18nMessages.version} + 1`,
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(i18nMessages.namespace, id.namespace),
									eq(i18nMessages.key, id.key),
									eq(i18nMessages.locale, id.locale),
									eq(i18nMessages.scope, id.scope),
									eq(i18nMessages.scopeId, id.scopeId),
								),
							),
					);
					yield* runtime.invalidate();
					yield* audit({
						action: "i18n.message.publish",
						targetType: "i18n_message",
						detail: { ...id },
					});
				}),

			discardDraft: (id) =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_EDIT_ACTION, MSG_PATH);
					const row = yield* Effect.promise(() => getMessageRow(db, id));
					if (row === undefined) return;
					if (row.status === "draft") {
						// Never-published draft: the row IS the draft — drop it.
						yield* Effect.promise(() =>
							db
								.delete(i18nMessages)
								.where(
									and(
										eq(i18nMessages.namespace, id.namespace),
										eq(i18nMessages.key, id.key),
										eq(i18nMessages.locale, id.locale),
										eq(i18nMessages.scope, id.scope),
										eq(i18nMessages.scopeId, id.scopeId),
									),
								),
						);
					} else {
						yield* Effect.promise(() =>
							db
								.update(i18nMessages)
								.set({ draftValue: null, updatedAt: new Date() })
								.where(
									and(
										eq(i18nMessages.namespace, id.namespace),
										eq(i18nMessages.key, id.key),
										eq(i18nMessages.locale, id.locale),
										eq(i18nMessages.scope, id.scope),
										eq(i18nMessages.scopeId, id.scopeId),
									),
								),
						);
					}
					yield* audit({
						action: "i18n.message.discard",
						targetType: "i18n_message",
						detail: { ...id },
					});
				}),

			setLocaleEnabled: (code, enabled) =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_LOCALES_ACTION, "i18n.locales.manage");
					yield* Effect.promise(() =>
						db.update(i18nLocales).set({ enabled }).where(eq(i18nLocales.code, code)),
					);
					yield* runtime.invalidate();
				}),

			exportNamespace: (namespace) =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_READ_ACTION, "i18n.messages.read");
					const rows = yield* Effect.promise(() =>
						listMessageRows(db, { namespace, scope: "global", scopeId: "" }),
					);
					const messages: Record<string, Record<string, string>> = {};
					for (const r of rows) {
						// Draft wins in the export — it's the newest intent.
						const value = r.draftValue ?? r.value;
						(messages[r.locale] ??= {})[r.key] = value;
					}
					return { version: 1 as const, namespace, messages };
				}),

			importNamespace: (payload) =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_EDIT_ACTION, MSG_PATH);
					const p = payload as Partial<I18nExportPayload> | null;
					if (
						p === null ||
						typeof p !== "object" ||
						p.version !== 1 ||
						typeof p.namespace !== "string" ||
						p.namespace === "" ||
						p.messages === null ||
						typeof p.messages !== "object"
					) {
						return yield* Effect.fail(new I18nValidationError({ error: "invalid export payload" }));
					}
					// Validate EVERYTHING before writing anything.
					const entries: Array<{ locale: string; key: string; value: string }> = [];
					const problems: string[] = [];
					for (const [locale, kv] of Object.entries(p.messages)) {
						if (kv === null || typeof kv !== "object") {
							problems.push(`locale '${locale}': expected object`);
							continue;
						}
						for (const [key, value] of Object.entries(kv)) {
							if (typeof value !== "string") {
								problems.push(`${locale}.${key}: value must be a string`);
								continue;
							}
							const parsed = parseMessage("text", value);
							if (!parsed.ok) {
								problems.push(`${locale}.${key}: ${parsed.error}`);
								continue;
							}
							entries.push({ locale, key, value });
						}
					}
					if (problems.length > 0) {
						return yield* Effect.fail(new I18nValidationError({ error: problems.join("; ") }));
					}
					for (const e of entries) {
						const id: MessageId = {
							namespace: p.namespace,
							key: e.key,
							locale: e.locale,
							scope: "global",
							scopeId: "",
						};
						yield* appendCrdt(id, e.value);
						const existing = yield* Effect.promise(() => getMessageRow(db, id));
						if (existing === undefined) {
							yield* Effect.promise(() =>
								db.insert(i18nMessages).values({
									namespace: id.namespace,
									key: id.key,
									locale: id.locale,
									scope: "global",
									scopeId: "",
									kind: "text",
									value: "",
									draftValue: e.value,
									status: "draft",
									params: [],
									version: 1,
								}),
							);
						} else {
							yield* Effect.promise(() =>
								db
									.update(i18nMessages)
									.set({ draftValue: e.value, updatedAt: new Date() })
									.where(
										and(
											eq(i18nMessages.namespace, id.namespace),
											eq(i18nMessages.key, id.key),
											eq(i18nMessages.locale, id.locale),
											eq(i18nMessages.scope, "global"),
											eq(i18nMessages.scopeId, ""),
										),
									),
							);
						}
					}
					yield* audit({
						action: "i18n.messages.import",
						targetType: "i18n_namespace",
						detail: { namespace: p.namespace, imported: entries.length },
					});
					return { imported: entries.length };
				}),
		});
	}),
);

/** i18n admin service citizen (P-083): panel read/write path. */
export const i18nAdminServicesPlugin = definePlugin({
	id: "i18n.admin.services",
	// i18n.services first: publish() invalidates the shared isolate
	// cache — the runtime must be the SAME instance, not a private one.
	requiredDeps: [platformAdminPlugin.id, rbacServicesPlugin.id, "i18n.services"],
	optionalDeps: [auditServicesPlugin.id],
	services: I18nAdminLive,
});

/** Compile-time dep registry. */
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"i18n.admin.services": true;
	}
}
