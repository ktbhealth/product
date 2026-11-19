import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, eq, lte, sql } from "drizzle-orm";

import { audit } from "@ktb/audit";
import { Forbidden, Principal } from "@ktb/authz";
import { Db } from "@ktb/db";
import { PlatformAdmin, type PlatformAdminShape } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";
import { i18nManifestHash, parseMessage, PSEUDO_LOCALE, type MessageParam } from "@ktb/i18n";

import {
	I18nAdmin,
	I18nValidationError,
	I18N_EDIT_ACTION,
	I18N_LOCALES_ACTION,
	I18N_READ_ACTION,
	I18N_RESOURCE,
	MAX_MESSAGE_FIELD_LENGTH,
	MAX_MESSAGE_VALUE_LENGTH,
	MESSAGE_ID_FORBIDDEN_RE,
	RICH_FORBIDDEN_RE,
	validateMessageId,
	type I18nExportPayload,
	type MessageId,
	type NamespaceCoverage,
	type NamespaceInfo,
} from "./contract.ts";
import { replaceDocValue, snapshotUpdate } from "./crdt.ts";
import { I18nRuntime } from "./runtime.ts";
import { i18nCrdtUpdates, i18nLocales, i18nMessages, i18nNamespaces } from "./schema.ts";
import {
	bumpCatalogRevision,
	getMessageRow,
	listCrdtUpdates,
	listLocales,
	listMessageRows,
} from "./store.ts";

export { I18nAdmin, I18nValidationError, type MessageId, type SaveDraftInput } from "./contract.ts";

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

/**
 * Op-log bound: past this many updates per message the CRDT log is
 * collapsed into a single snapshot row (see `snapshotUpdate`). Keeps
 * `listCrdtUpdates` replay and the table size bounded on hot keys —
 * every saveDraft otherwise appends one row forever.
 */
const CRDT_LOG_LIMIT = 200;

/** Rows per multi-row upsert during namespace import. */
const IMPORT_UPSERT_CHUNK = 64;

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

		/**
		 * Scope-aware authorization. `global` rows ride the plain
		 * `i18n.messages.*` grant; non-global scopes go through the
		 * tenant-pinned rbac lookup:
		 *
		 * - `tenant`: the grant check passes `tenantId: scopeId` to
		 *   rbac, whose grant resolution is `tenant_id IS NULL OR
		 *   tenant_id = scopeId` — so a GLOBAL grant (tenant_id NULL)
		 *   satisfies tenant-scoped checks and global i18n grant
		 *   holders CAN write any tenant's copy, while tenant-pinned
		 *   grants stay isolated to their own tenant. The scopeId
		 *   itself is not re-validated against a tenant directory —
		 *   none is reachable from this layer — but the grant lookup
		 *   fails closed: a scopeId with no matching tenant grant
		 *   resolves Forbidden. (Whether global grants SHOULD imply
		 *   tenant write access is a product decision — flagged for
		 *   review; the orAdmin fallback below is unaffected.)
		 * - `portal`: portal instance ids live in the app-host chrome
		 *   registry (`findPortalInstance`), which plugins cannot
		 *   import (arch lint) and which has no rbac tenant analogue —
		 *   portal-scoped copy therefore requires the platform-admin
		 *   allowlist.
		 */
		const requireScopePermission = (action: string, path: string, scope: string, scopeId: string) =>
			Effect.gen(function* () {
				if (scope === "global") return yield* requirePermission(action, path);
				if (scopeId === "") return yield* forbidden(path);
				if (scope === "tenant" && Option.isSome(permissionsOpt)) {
					const check = permissionsOpt.value.requirePermission(I18N_RESOURCE, action, {
						tenantId: scopeId,
					});
					return yield* orAdmin(platformAdmin, check);
				}
				// Portal scope (or tenant scope without a Permissions
				// service): platform-admin allowlist only.
				return yield* platformAdmin
					.requireAdmin()
					.pipe(Effect.catchTag("Forbidden", () => forbidden(path)));
			});

		const actorId = Effect.map(Principal, (p) => p?.userId ?? "");

		/**
		 * Locale gate for writes: `i18n_locales` is the runtime source of
		 * truth for valid codes (LOCALE_META only seeds it — admins can
		 * add/remove rows), so existence is checked against the table,
		 * not the constant. Rejecting unknown codes keeps dead rows out
		 * of i18n_messages.
		 */
		const requireKnownLocale = (locale: string) =>
			Effect.gen(function* () {
				const rows = yield* Effect.promise(() =>
					db
						.select({ code: i18nLocales.code })
						.from(i18nLocales)
						.where(eq(i18nLocales.code, locale))
						.limit(1),
				);
				if (rows.length === 0) {
					return yield* Effect.fail(
						new I18nValidationError({ error: `unknown locale '${locale}'` }),
					);
				}
			});

		/**
		 * Copy-creating paths additionally refuse the pseudo-locale:
		 * `qps` is a QA transform applied at render time over
		 * default-locale copy (catalogs never carry qps rows), so an
		 * authored/published qps row would be pseudo-localized a second
		 * time. Discard stays on requireKnownLocale so stray qps rows
		 * can still be cleaned up.
		 */
		const requireWritableLocale = (locale: string) =>
			Effect.gen(function* () {
				if (locale === PSEUDO_LOCALE) {
					return yield* Effect.fail(
						new I18nValidationError({
							error: `'${PSEUDO_LOCALE}' is the QA pseudo-locale and cannot hold authored copy`,
						}),
					);
				}
				yield* requireKnownLocale(locale);
			});

		/**
		 * Append a whole-value replace to the message's CRDT log and
		 * return the MERGED doc value. `draft_value` must store this —
		 * the raw input would make publish last-write-wins while the op
		 * log implies merge (concurrent edits would be silently dropped).
		 */
		const appendCrdt = (id: MessageId, value: string) =>
			Effect.gen(function* () {
				const { updates, maxId } = yield* Effect.promise(() => listCrdtUpdates(db, id));
				const merged = replaceDocValue(updates, value);
				const actor = yield* actorId;
				const update = merged.update;
				const row = {
					namespace: id.namespace,
					key: id.key,
					locale: id.locale,
					scope: id.scope,
					scopeId: id.scopeId,
					actorId: actor,
				};
				if (updates.length + 1 > CRDT_LOG_LIMIT) {
					// Compact: fold the whole log (old ops + this delta)
					// into a single snapshot row. Two guards keep a
					// concurrent save from being silently dropped:
					//  - the delete is bounded to `id <= maxId` (the
					//    highest row id seen by the read above), so an
					//    op appended after the read survives and merges
					//    on replay — the snapshot simply doesn't cover
					//    it, which is correct since it postdates the
					//    merged value we snapshotted;
					//  - delete+insert run in one db.batch(), which D1
					//    executes atomically (interactive BEGIN is
					//    rejected on D1, but batch() is the atomic
					//    multi-statement path).
					const snapshot = snapshotUpdate([...updates, update]);
					yield* Effect.promise(() =>
						db.batch([
							db
								.delete(i18nCrdtUpdates)
								.where(
									and(
										eq(i18nCrdtUpdates.namespace, id.namespace),
										eq(i18nCrdtUpdates.key, id.key),
										eq(i18nCrdtUpdates.locale, id.locale),
										eq(i18nCrdtUpdates.scope, id.scope),
										eq(i18nCrdtUpdates.scopeId, id.scopeId),
										lte(i18nCrdtUpdates.id, maxId),
									),
								),
							db.insert(i18nCrdtUpdates).values({ ...row, update: snapshot }),
						]),
					);
				} else {
					yield* Effect.promise(() => db.insert(i18nCrdtUpdates).values({ ...row, update }));
				}
				return merged.value;
			});

		return I18nAdmin.of({
			namespaces: () =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_READ_ACTION, "i18n.messages.read");
					const [registered, counts] = yield* Effect.all([
						Effect.promise(() => db.select().from(i18nNamespaces)),
						// GROUP BY count — the panel only needs per-namespace
						// totals, not every message row in the table. Scoped
						// to global rows: a plain read-grant holder must not
						// see other tenants'/portals' row counts (the panel's
						// global view only ever lists global copy anyway).
						Effect.promise(() =>
							db
								.select({
									namespace: i18nMessages.namespace,
									count: sql<number>`count(*)`,
								})
								.from(i18nMessages)
								.where(and(eq(i18nMessages.scope, "global"), eq(i18nMessages.scopeId, "")))
								.groupBy(i18nMessages.namespace),
						),
					]);
					const byNs = new Map(counts.map((c) => [c.namespace, c.count]));
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

			coverage: () =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_READ_ACTION, "i18n.messages.read");
					// Global scope only — same visibility rule as namespaces():
					// a plain read-grant holder must not see other scopes' copy.
					const [registered, rows, locs] = yield* Effect.all([
						Effect.promise(() => db.select().from(i18nNamespaces)),
						Effect.promise(() => listMessageRows(db, { scope: "global", scopeId: "" })),
						Effect.promise(() => listLocales(db)),
					]);
					const keysByNs = new Map<string, Set<string>>();
					const translated = new Map<string, Map<string, Set<string>>>();
					for (const r of rows) {
						let ks = keysByNs.get(r.namespace);
						if (ks === undefined) {
							ks = new Set();
							keysByNs.set(r.namespace, ks);
						}
						ks.add(r.key);
						// Only published rows serve traffic — staged drafts and
						// never-published rows don't count as coverage.
						if (r.status === "published") {
							let byLocale = translated.get(r.namespace);
							if (byLocale === undefined) {
								byLocale = new Map();
								translated.set(r.namespace, byLocale);
							}
							let keys = byLocale.get(r.locale);
							if (keys === undefined) {
								keys = new Set();
								byLocale.set(r.locale, keys);
							}
							keys.add(r.key);
						}
					}
					const meta = new Map(registered.map((r) => [r.namespace, r]));
					const localeCodes = locs.map((l) => l.code);
					const names = new Set([...meta.keys(), ...keysByNs.keys()]);
					const out: NamespaceCoverage[] = [];
					for (const ns of [...names].sort((a, b) => a.localeCompare(b))) {
						const m = meta.get(ns);
						const byLocale = translated.get(ns);
						const translatedRec: Record<string, number> = {};
						for (const code of localeCodes) {
							translatedRec[code] = byLocale?.get(code)?.size ?? 0;
						}
						// Manifest drift: the stored hash was snapshotted at
						// baseline (re)import; compare it to the live
						// I18N_MANIFEST contract. "" or a namespace with no
						// manifest entry means drift is not applicable.
						const manifestHash = m?.manifestHash ?? "";
						const currentHash = i18nManifestHash(ns);
						const manifestDrift: NamespaceCoverage["manifestDrift"] =
							currentHash === null || manifestHash === ""
								? "unrecorded"
								: manifestHash === currentHash
									? "no"
									: "yes";
						out.push({
							namespace: ns,
							pluginId: m?.pluginId ?? "",
							defaultLocale: m?.defaultLocale ?? "en",
							keyCount: keysByNs.get(ns)?.size ?? 0,
							translated: translatedRec,
							manifestHash,
							manifestDrift,
						});
					}
					return out;
				}),

			missingKeys: (input) =>
				Effect.gen(function* () {
					yield* requirePermission(I18N_READ_ACTION, "i18n.messages.read");
					// Same id hygiene as validateMessageId's field checks —
					// namespace/locale are wire input, not trusted PK
					// material. Scope is fixed to global (coverage's
					// universe), so no scope/scopeId fields apply.
					for (const [field, value] of [
						["namespace", input.namespace],
						["locale", input.locale],
					] as const) {
						if (
							value === "" ||
							MESSAGE_ID_FORBIDDEN_RE.test(value) ||
							value.length > MAX_MESSAGE_FIELD_LENGTH
						) {
							return yield* Effect.fail(
								new I18nValidationError({
									error: `${field} must be non-empty, free of whitespace/control characters, and at most ${MAX_MESSAGE_FIELD_LENGTH} characters`,
								}),
							);
						}
					}
					// Global scope only — identical visibility rule to
					// coverage(): tenant/portal rows never enter the
					// key universe or the translated set.
					const rows = yield* Effect.promise(() =>
						listMessageRows(db, {
							namespace: input.namespace,
							scope: "global",
							scopeId: "",
						}),
					);
					const keys = new Set<string>();
					const translated = new Set<string>();
					for (const r of rows) {
						keys.add(r.key);
						// coverage() counts a key as translated when a
						// published row exists for the locale — drafts
						// (status "draft") and other locales don't.
						if (r.locale === input.locale && r.status === "published") {
							translated.add(r.key);
						}
					}
					return [...keys].filter((k) => !translated.has(k)).sort();
				}),

			messages: (filter = {}) =>
				Effect.gen(function* () {
					const scope = filter.scope ?? "global";
					if (scope !== "global") {
						// Non-global rows are elevated reads — the same gate
						// as writes, so a plain read grant can't dump other
						// tenants'/portals' copy (draft_value included).
						yield* requireScopePermission(
							I18N_READ_ACTION,
							"i18n.messages.read",
							scope,
							filter.scopeId ?? "",
						);
						return yield* Effect.promise(() => listMessageRows(db, filter));
					}
					const allowed = yield* canRead;
					if (!allowed) return yield* forbidden("i18n.messages.read");
					// Global/unspecified scope: force global rows server-side.
					// A scope-less filter must never return tenant/portal
					// rows to a plain read-grant holder, and a stray
					// scopeId can't leak across scopes (global rows always
					// carry scope_id "").
					return yield* Effect.promise(() =>
						listMessageRows(db, { ...filter, scope: "global", scopeId: filter.scopeId ?? "" }),
					);
				}),

			saveDraft: (input) =>
				Effect.gen(function* () {
					const kind = input.kind ?? "text";
					if (input.value.length > MAX_MESSAGE_VALUE_LENGTH) {
						return yield* Effect.fail(
							new I18nValidationError({
								error: `value exceeds ${MAX_MESSAGE_VALUE_LENGTH} characters`,
							}),
						);
					}
					// Defense in depth: parseMessage already rejects this
					// for kind "rich" — keep a local check so a parser
					// regression can't write active markup into drafts.
					if (kind === "rich" && RICH_FORBIDDEN_RE.test(input.value)) {
						return yield* Effect.fail(
							new I18nValidationError({ error: "forbidden markup in rich message" }),
						);
					}
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
					const idError = validateMessageId(id);
					if (idError !== null) {
						return yield* Effect.fail(new I18nValidationError({ error: idError }));
					}
					// Locale must exist in i18n_locales (and not be the
					// pseudo-locale) BEFORE any write — unknown codes
					// would leave dead rows no catalog ever reads.
					yield* requireWritableLocale(id.locale);
					// Scope gate after id validation: malformed ids get the
					// precise validation error; well-formed tenant/portal
					// ids then need the elevated grant.
					yield* requireScopePermission(I18N_EDIT_ACTION, MSG_PATH, id.scope, id.scopeId);
					// draft_value stores the CRDT-merged value, not the raw
					// input — see appendCrdt. The op-log insert + row upsert
					// can't share a transaction (D1 rejects BEGIN); each
					// statement is atomic and the upsert is race-safe.
					const merged = yield* appendCrdt(id, input.value);
					// Single upsert on the composite PK — no check-then-act,
					// so concurrent saves can't PK-violate into a 500.
					yield* Effect.promise(() =>
						db
							.insert(i18nMessages)
							.values({
								namespace: id.namespace,
								key: id.key,
								locale: id.locale,
								scope: id.scope,
								scopeId: id.scopeId,
								kind,
								value: "",
								draftValue: merged,
								status: "draft",
								params: sig,
								version: 1,
							})
							.onConflictDoUpdate({
								target: [
									i18nMessages.namespace,
									i18nMessages.key,
									i18nMessages.locale,
									i18nMessages.scope,
									i18nMessages.scopeId,
								],
								set: {
									draftValue: merged,
									kind,
									params: sig,
									updatedAt: new Date(),
								},
							}),
					);
					yield* audit({
						action: "i18n.message.draft",
						targetType: "i18n_message",
						detail: { ...id, kind },
					});
				}),

			publish: (id) =>
				Effect.gen(function* () {
					yield* requireScopePermission(I18N_EDIT_ACTION, MSG_PATH, id.scope, id.scopeId);
					yield* requireWritableLocale(id.locale);
					const row = yield* Effect.promise(() => getMessageRow(db, id));
					const draft = row?.draftValue;
					if (row === undefined || draft === null || draft === undefined) {
						return yield* forbidden(MSG_PATH);
					}
					// Last gate before the value serves traffic: re-validate
					// the staged draft (kind-aware parse + the rich-markup
					// guard). Drafts are already validated at save/import
					// time — this catches anything that bypassed those paths.
					const kind = row.kind;
					if (kind === "rich" && RICH_FORBIDDEN_RE.test(draft)) {
						return yield* Effect.fail(
							new I18nValidationError({ error: "forbidden markup in rich message" }),
						);
					}
					const parsed = parseMessage(kind, draft);
					if (!parsed.ok) {
						return yield* Effect.fail(new I18nValidationError({ error: parsed.error }));
					}
					// Single conditional UPDATE: `value` takes the
					// draft_value COLUMN, so the exact draft validated
					// above is what goes live — and the
					// `draft_value = <fetched>` guard makes a concurrent
					// saveDraft/discard/publish a no-op (empty RETURNING
					// → Forbidden; the caller retries against fresh
					// state). No stale-draft resurrection or loss.
					const updated = yield* Effect.promise(() =>
						db
							.update(i18nMessages)
							.set({
								value: sql`${i18nMessages.draftValue}`,
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
									// Stale-draft guard: promote only the draft
									// we validated above. A saveDraft landing
									// between the read and this UPDATE changes
									// draft_value → 0 rows → Forbidden; the
									// caller retries against the fresh draft.
									eq(i18nMessages.draftValue, draft),
								),
							)
							.returning({ key: i18nMessages.key }),
					);
					if (updated.length === 0) {
						return yield* forbidden(MSG_PATH);
					}
					// The live catalog changed → move the O(1) stamp so
					// other isolates reload on their next TTL re-check.
					yield* Effect.promise(() => bumpCatalogRevision(db));
					yield* runtime.invalidate();
					yield* audit({
						action: "i18n.message.publish",
						targetType: "i18n_message",
						detail: { ...id },
					});
				}),

			discardDraft: (id) =>
				Effect.gen(function* () {
					yield* requireScopePermission(I18N_EDIT_ACTION, MSG_PATH, id.scope, id.scopeId);
					// Existence-only locale gate (qps allowed): discard is
					// cleanup — a stray row under any known code, including
					// the pseudo-locale, must stay removable.
					yield* requireKnownLocale(id.locale);
					const row = yield* Effect.promise(() => getMessageRow(db, id));
					if (row === undefined) return;
					if (row.status === "draft") {
						// Never-published draft: the row IS the draft — drop it
						// and its CRDT ops so the log doesn't orphan.
						yield* Effect.promise(() =>
							db
								.delete(i18nCrdtUpdates)
								.where(
									and(
										eq(i18nCrdtUpdates.namespace, id.namespace),
										eq(i18nCrdtUpdates.key, id.key),
										eq(i18nCrdtUpdates.locale, id.locale),
										eq(i18nCrdtUpdates.scope, id.scope),
										eq(i18nCrdtUpdates.scopeId, id.scopeId),
									),
								),
						);
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
						// Published row: clear only the staged draft. The
						// CRDT op log is kept deliberately — it is the
						// merge/audit history behind the live `value`, and
						// replaceDocValue rebuilds from it on the next
						// save (a discarded draft can't resurrect: the
						// whole-value replace deletes all prior text).
						// Op-log compaction/retention is out of scope.
						//
						// The `draft_value = <fetched>` guard mirrors
						// publish's stale-draft guard: a saveDraft landing
						// between the read and this UPDATE changes
						// draft_value → 0 rows → the fresh draft survives
						// (discard stays idempotent — nothing to retry).
						const stagedDraft = row.draftValue;
						if (stagedDraft !== null) {
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
											eq(i18nMessages.draftValue, stagedDraft),
										),
									),
							);
						}
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
					// RETURNING doubles as the existence check — toggling a
					// locale code that isn't in i18n_locales is a clear
					// not-found, not a silent ok.
					const updated = yield* Effect.promise(() =>
						db
							.update(i18nLocales)
							.set({ enabled })
							.where(eq(i18nLocales.code, code))
							.returning({ code: i18nLocales.code }),
					);
					if (updated.length === 0) {
						return yield* Effect.fail(
							new I18nValidationError({ error: `unknown locale '${code}'` }),
						);
					}
					// Enabled-locale set feeds listPublishedRows' locale
					// filter → the published catalog changed.
					yield* Effect.promise(() => bumpCatalogRevision(db));
					yield* runtime.invalidate();
					yield* audit({
						action: "i18n.locale.toggle",
						targetType: "i18n_locale",
						detail: { code, enabled },
					});
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
						MESSAGE_ID_FORBIDDEN_RE.test(p.namespace) ||
						p.messages === null ||
						typeof p.messages !== "object"
					) {
						return yield* Effect.fail(new I18nValidationError({ error: "invalid export payload" }));
					}
					// Validate EVERYTHING before writing anything.
					// i18n_locales is the runtime source of truth for valid
					// codes — one select up front, then per-entry checks.
					const localeRows = yield* Effect.promise(() =>
						db.select({ code: i18nLocales.code }).from(i18nLocales),
					);
					const knownLocales = new Set(localeRows.map((l) => l.code));
					const entries: Array<{
						locale: string;
						key: string;
						value: string;
						params: readonly MessageParam[];
					}> = [];
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
							const idError = validateMessageId({
								namespace: p.namespace,
								key,
								locale,
								scope: "global",
								scopeId: "",
							});
							if (idError !== null) {
								problems.push(`${locale}.${key}: ${idError}`);
								continue;
							}
							// Unknown locales would stage dead rows no
							// catalog reads; qps is render-time pseudo
							// copy, never authored data (same gate as
							// saveDraft/publish).
							if (locale === PSEUDO_LOCALE) {
								problems.push(
									`${locale}.${key}: '${PSEUDO_LOCALE}' is the QA pseudo-locale and cannot hold authored copy`,
								);
								continue;
							}
							if (!knownLocales.has(locale)) {
								problems.push(`${locale}.${key}: unknown locale '${locale}'`);
								continue;
							}
							if (value.length > MAX_MESSAGE_VALUE_LENGTH) {
								problems.push(
									`${locale}.${key}: value exceeds ${MAX_MESSAGE_VALUE_LENGTH} characters`,
								);
								continue;
							}
							const parsed = parseMessage("text", value);
							if (!parsed.ok) {
								problems.push(`${locale}.${key}: ${parsed.error}`);
								continue;
							}
							entries.push({
								locale,
								key,
								value,
								params: parsed.message.params,
							});
						}
					}
					if (problems.length > 0) {
						return yield* Effect.fail(new I18nValidationError({ error: problems.join("; ") }));
					}
					// D1 has no interactive transactions (BEGIN is rejected
					// at runtime), so each write is a single atomic
					// statement: chunked multi-row upserts on the composite
					// PK are race-safe, and all validation ran before the
					// first write. A mid-import failure can leave earlier
					// chunks staged as drafts — publish() is the only path
					// that promotes them, so partial imports never go live.
					//
					// File imports deliberately SKIP appendCrdt: there is no
					// concurrent-editor merge to preserve for a bulk load,
					// and the imported value IS the draft — writing
					// draft_value directly turns ~4 sequential D1 ops per
					// entry into one chunked upsert per IMPORT_UPSERT_CHUNK
					// rows (the old path was quadratic on re-import).
					const namespace = p.namespace;
					for (let i = 0; i < entries.length; i += IMPORT_UPSERT_CHUNK) {
						const chunk = entries.slice(i, i + IMPORT_UPSERT_CHUNK);
						yield* Effect.promise(() =>
							db
								.insert(i18nMessages)
								.values(
									chunk.map((e) => ({
										namespace,
										key: e.key,
										locale: e.locale,
										scope: "global" as const,
										scopeId: "",
										kind: "text" as const,
										value: "",
										draftValue: e.value,
										status: "draft" as const,
										params: e.params,
										version: 1,
									})),
								)
								.onConflictDoUpdate({
									target: [
										i18nMessages.namespace,
										i18nMessages.key,
										i18nMessages.locale,
										i18nMessages.scope,
										i18nMessages.scopeId,
									],
									set: {
										// Per-row values come from the proposed
										// insert row (`excluded.*`) — the set clause
										// is shared across the whole chunk. `kind`
										// resets too: a row previously saved as
										// "rich" must not stay rich while staging
										// imported plain text.
										draftValue: sql`excluded.draft_value`,
										kind: sql`excluded.kind`,
										params: sql`excluded.params`,
										updatedAt: new Date(),
									},
								}),
						);
					}
					// No catalog revision bump: imports stage drafts
					// only — `value`/`status` are untouched, so the
					// published catalog (and its stamp) doesn't move
					// until publish().
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

// The `i18n.admin.services` plugin citizen is defined in index.ts next to
// the other single-concern plugins (the arch plugin-contract rule
// resolves `plugins` entries within the entry file only).
