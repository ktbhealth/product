import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden } from "@ktb/authz";
import { PlatformAdmin, type PlatformAdminShape } from "@ktb/platform";
import { Permissions, type PermissionsShape } from "@ktb/rbac";

import { I18nAdmin, I18nAdminLive, I18nValidationError, type SaveDraftInput } from "./admin.ts";
import {
	I18N_TEST_DDL,
	i18nCrdtUpdates,
	i18nLocales,
	i18nMessages,
	i18nNamespaces,
} from "./index.ts";
import { I18nRuntimeLive } from "./runtime.ts";

/**
 * Race-injection hooks for store reads: a test can arm `crdt` (fires
 * after listCrdtUpdates returns, before appendCrdt writes) or `row`
 * (fires after getMessageRow returns, before publish/discardDraft
 * writes) to simulate a concurrent writer landing mid-operation.
 * Passthrough by default — every other test is unaffected.
 */
const readHooks = vi.hoisted(() => ({
	crdt: null as null | (() => Promise<unknown>),
	row: null as null | (() => Promise<unknown>),
}));

vi.mock("./store.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("./store.ts")>();
	const runHook = async (key: "crdt" | "row") => {
		const hook = readHooks[key];
		readHooks[key] = null;
		if (hook !== null) await hook();
	};
	return {
		...mod,
		listCrdtUpdates: async (...args: Parameters<typeof mod.listCrdtUpdates>) => {
			const result = await mod.listCrdtUpdates(...args);
			await runHook("crdt");
			return result;
		},
		getMessageRow: async (...args: Parameters<typeof mod.getMessageRow>) => {
			const result = await mod.getMessageRow(...args);
			await runHook("row");
			return result;
		},
	};
});

let db: DbClient;

const adminGate: PlatformAdminShape = {
	isAdmin: () => Effect.succeed(true),
	requireAdmin: () => Effect.void,
};
const denyGate: PlatformAdminShape = {
	isAdmin: () => Effect.succeed(false),
	requireAdmin: () => Effect.fail(new Forbidden({ path: "platform.admin" })),
};

const makeRuntime = (gate: PlatformAdminShape = adminGate) =>
	ManagedRuntime.make(
		I18nAdminLive.pipe(
			Layer.provide(I18nRuntimeLive),
			Layer.provide(Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, gate))),
		),
	);

/** Grant shape that allows every GLOBAL i18n grant check but denies any
 * tenant-scoped lookup — the "plain grant holder" of the scope-authz
 * audit. */
const globalOnlyPermissions: PermissionsShape = {
	permissionsFor: () => Effect.succeed(new Map()),
	canFor: () => Effect.succeed(true),
	can: () => Effect.succeed(true),
	requirePermissionFor: (_u, _r, _a, tenantId) =>
		tenantId === undefined
			? Effect.void
			: Effect.fail(new Forbidden({ path: "rbac.i18n.messages.edit" })),
	requirePermission: (_r, _a, opts) =>
		opts?.tenantId === undefined
			? Effect.void
			: Effect.fail(new Forbidden({ path: "rbac.i18n.messages.edit" })),
	invalidate: () => Effect.void,
};

const makeRuntimeWithPermissions = (
	permissions: PermissionsShape,
	gate: PlatformAdminShape = denyGate,
) =>
	ManagedRuntime.make(
		I18nAdminLive.pipe(
			Layer.provide(I18nRuntimeLive),
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(Db, db),
					Layer.succeed(PlatformAdmin, gate),
					Layer.succeed(Permissions, permissions),
				),
			),
		),
	);

const ID = {
	namespace: "app",
	key: "welcome",
	locale: "en",
	scope: "global" as const,
	scopeId: "",
};

beforeAll(async () => {
	db = makeDb(makeD1(I18N_TEST_DDL));
	// The runtime layer auto-seeds I18N_BASELINE when i18n_namespaces is
	// empty — these tests assert exact row contents, so register a
	// sentinel namespace up front to keep the fixture empty.
	await db.insert(i18nNamespaces).values({
		namespace: "_fixture",
		pluginId: "",
		defaultLocale: "en",
	});
});

describe("I18nAdmin", () => {
	it("saveDraft stages draft_value without touching live value", async () => {
		const rt = makeRuntime();
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({ ...ID, value: "Welcome {name}" });
			}),
		);
		const rows = await db.select().from(i18nMessages);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.value).toBe("");
		expect(rows[0]?.draftValue).toBe("Welcome {name}");
		expect(rows[0]?.status).toBe("draft");
	});

	it("rejects markup in text messages", async () => {
		const rt = makeRuntime();
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.saveDraft({ ...ID, key: "bad", value: "<b>hi</b>" }).pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(I18nValidationError);
	});

	it("publish moves draft_value live and bumps version", async () => {
		const rt = makeRuntime();
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.publish(ID);
			}),
		);
		const rows = await db.select().from(i18nMessages);
		expect(rows[0]?.value).toBe("Welcome {name}");
		expect(rows[0]?.draftValue).toBeNull();
		expect(rows[0]?.status).toBe("published");
		expect(rows[0]?.version).toBe(2);
	});

	it("discardDraft deletes never-published rows", async () => {
		const rt = makeRuntime();
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({ ...ID, key: "temp", locale: "pt-BR", value: "Olá" });
				yield* admin.discardDraft({ ...ID, key: "temp", locale: "pt-BR" });
			}),
		);
		const rows = await db.select().from(i18nMessages);
		expect(rows.find((r) => r.key === "temp")).toBeUndefined();
	});

	it("denies writes when neither grant nor admin gate passes", async () => {
		const rt = makeRuntime(denyGate);
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.saveDraft({ ...ID, key: "nope", value: "x" }).pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(Forbidden);
	});

	it("export/import round-trips as drafts, rejects bad payloads atomically", async () => {
		const rt = makeRuntime();
		const out = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				const exported = yield* admin.exportNamespace("app");
				// Import into a different namespace.
				const res = yield* admin.importNamespace({
					...exported,
					namespace: "imported",
				});
				return { exported, res };
			}),
		);
		expect(out.res.imported).toBeGreaterThan(0);
		const rows = await db.select().from(i18nMessages);
		expect(rows.every((r) => r.namespace !== "imported" || r.status === "draft")).toBe(true);

		// Bad payload: nothing applied.
		const before = rows.length;
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.importNamespace({
						version: 1,
						namespace: "bad",
						messages: { en: { k: "<b>markup</b>" } },
					})
					.pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(I18nValidationError);
		expect(await db.select().from(i18nMessages)).toHaveLength(before);
	});

	it("namespaces + locales list for the panel", async () => {
		const rt = makeRuntime();
		const out = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return {
					namespaces: yield* admin.namespaces(),
					locales: yield* admin.locales(),
				};
			}),
		);
		expect(out.namespaces.map((n) => n.namespace)).toContain("app");
	});
});

describe("I18nAdmin validation", () => {
	const BASE = {
		namespace: "app",
		key: "v-base",
		locale: "en",
		scope: "global" as const,
		scopeId: "",
		value: "x",
	};

	it("rejects whitespace/control characters in id fields", async () => {
		const rt = makeRuntime();
		const cases: Array<Partial<SaveDraftInput>> = [
			{ key: "has space" },
			{ key: "line\nbreak" },
			{ locale: "en US" },
			{ namespace: "bad\tns" },
		];
		for (const patch of cases) {
			const err = await rt.runPromise(
				Effect.gen(function* () {
					const admin = yield* I18nAdmin;
					return yield* admin
						.saveDraft({ ...BASE, key: "v-id", ...patch, value: "x" })
						.pipe(Effect.flip);
				}),
			);
			expect(err).toBeInstanceOf(I18nValidationError);
		}
	});

	it("enforces scopeId rules: empty iff global, required otherwise", async () => {
		const rt = makeRuntime();
		// global scope with a scopeId → reject.
		const e1 = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.saveDraft({ ...BASE, key: "v-scope", scopeId: "t-1" })
					.pipe(Effect.flip);
			}),
		);
		expect(e1).toBeInstanceOf(I18nValidationError);
		// tenant scope without scopeId → reject.
		const e2 = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.saveDraft({ ...BASE, key: "v-scope", scope: "tenant", scopeId: "" })
					.pipe(Effect.flip);
			}),
		);
		expect(e2).toBeInstanceOf(I18nValidationError);
		// tenant scope with a clean scopeId → accepted.
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({
					...BASE,
					key: "v-scope",
					scope: "tenant",
					scopeId: "t-1",
					value: "Tenant copy",
				});
			}),
		);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, "v-scope"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.scope).toBe("tenant");
		expect(rows[0]?.scopeId).toBe("t-1");
	});

	it("rejects forbidden markup in rich values and oversized values", async () => {
		const rt = makeRuntime();
		const rich = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.saveDraft({
						...BASE,
						key: "v-rich",
						kind: "rich",
						value: '<p onclick="x()">hi</p><script>alert(1)</script>',
					})
					.pipe(Effect.flip);
			}),
		);
		expect(rich).toBeInstanceOf(I18nValidationError);
		const big = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.saveDraft({ ...BASE, key: "v-big", value: "x".repeat(60_000) })
					.pipe(Effect.flip);
			}),
		);
		expect(big).toBeInstanceOf(I18nValidationError);
	});
});

describe("I18nAdmin upsert + counts", () => {
	it("saveDraft upserts on the composite PK — no duplicate rows", async () => {
		const rt = makeRuntime();
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({
					namespace: "app",
					key: "v-upsert",
					locale: "en",
					scope: "global",
					scopeId: "",
					value: "first",
				});
				yield* admin.saveDraft({
					namespace: "app",
					key: "v-upsert",
					locale: "en",
					scope: "global",
					scopeId: "",
					value: "second",
				});
			}),
		);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, "v-upsert"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.draftValue).toBe("second");
	});

	it("re-drafting a published row keeps the live value and status", async () => {
		const rt = makeRuntime();
		const id = {
			namespace: "app",
			key: "v-repub",
			locale: "en",
			scope: "global" as const,
			scopeId: "",
		};
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({ ...id, value: "live copy" });
				yield* admin.publish(id);
				yield* admin.saveDraft({ ...id, value: "staged copy" });
			}),
		);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, "v-repub"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("published");
		expect(rows[0]?.value).toBe("live copy");
		expect(rows[0]?.draftValue).toBe("staged copy");
	});

	it("namespaces() reports accurate per-namespace GLOBAL message counts", async () => {
		const rt = makeRuntime();
		const out = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.namespaces();
			}),
		);
		const appRows = (await db.select().from(i18nMessages)).filter((r) => r.namespace === "app");
		const expected = appRows.filter((r) => r.scope === "global" && r.scopeId === "").length;
		const app = out.find((n) => n.namespace === "app");
		expect(app?.messageCount).toBe(expected);
		expect(expected).toBeGreaterThan(0);
		// Scoped rows exist for "app" by this point (tenant copies from
		// earlier describes) — they must NOT be counted for a plain
		// read-grant holder.
		expect(appRows.some((r) => r.scope !== "global" || r.scopeId !== "")).toBe(true);
	});

	it("importNamespace rejects invalid keys and dirty namespaces atomically", async () => {
		const rt = makeRuntime();
		const badKey = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.importNamespace({
						version: 1,
						namespace: "imp-check",
						messages: { en: { "bad key": "v" }, es: { ok: "v" } },
					})
					.pipe(Effect.flip);
			}),
		);
		expect(badKey).toBeInstanceOf(I18nValidationError);
		const badNs = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.importNamespace({
						version: 1,
						namespace: "bad ns",
						messages: { en: { ok: "v" } },
					})
					.pipe(Effect.flip);
			}),
		);
		expect(badNs).toBeInstanceOf(I18nValidationError);
		// Nothing was written for either attempt.
		const rows = await db
			.select()
			.from(i18nMessages)
			.where(eq(i18nMessages.namespace, "imp-check"));
		expect(rows).toHaveLength(0);
	});
});

describe("I18nAdmin scope authz", () => {
	const TENANT_ID = {
		namespace: "app",
		key: "scoped-authz",
		locale: "en",
		scope: "tenant" as const,
		scopeId: "tenant-x",
	};

	it("denies tenant-scoped writes to a global-only grant holder", async () => {
		const rt = makeRuntimeWithPermissions(globalOnlyPermissions, denyGate);
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.saveDraft({ ...TENANT_ID, value: "tenant copy" }).pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(Forbidden);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, TENANT_ID.key));
		expect(rows).toHaveLength(0);
	});

	it("denies portal-scoped writes to a global-only grant holder", async () => {
		const rt = makeRuntimeWithPermissions(globalOnlyPermissions, denyGate);
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.saveDraft({
						...TENANT_ID,
						key: "portal-authz",
						scope: "portal",
						scopeId: "clinician",
						value: "portal copy",
					})
					.pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(Forbidden);
	});

	it("still allows global writes for the same grant holder", async () => {
		const rt = makeRuntimeWithPermissions(globalOnlyPermissions, denyGate);
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({ ...ID, key: "global-grant-ok", value: "hi" });
			}),
		);
		const rows = await db
			.select()
			.from(i18nMessages)
			.where(eq(i18nMessages.key, "global-grant-ok"));
		expect(rows).toHaveLength(1);
	});

	it("platform admin bypasses the tenant-scope grant requirement", async () => {
		const rt = makeRuntimeWithPermissions(globalOnlyPermissions, adminGate);
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({ ...TENANT_ID, value: "admin tenant copy" });
			}),
		);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, TENANT_ID.key));
		expect(rows[0]?.scope).toBe("tenant");
		expect(rows[0]?.draftValue).toBe("admin tenant copy");
	});

	it("messages() denies non-global scope reads without the elevated grant", async () => {
		const rt = makeRuntimeWithPermissions(globalOnlyPermissions, denyGate);
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.messages({ namespace: "app", scope: "tenant", scopeId: "t-9" })
					.pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(Forbidden);
	});

	it("messages() with no scope returns global rows only — never tenant/portal", async () => {
		const rt = makeRuntimeWithPermissions(globalOnlyPermissions, denyGate);
		const rows = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.messages({ namespace: "app" });
			}),
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.scope === "global")).toBe(true);
		// Same for an explicit global filter carrying a stray scopeId.
		const stray = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.messages({
					namespace: "app",
					scope: "global",
					scopeId: "t-9",
				});
			}),
		);
		expect(stray.every((r) => r.scope === "global")).toBe(true);
	});

	it("messages() lets the platform admin read a tenant scope", async () => {
		await db.insert(i18nMessages).values({
			namespace: "app",
			key: "tenant-read",
			locale: "en",
			scope: "tenant",
			scopeId: "t-read",
			kind: "text",
			value: "tenant copy",
			status: "published",
			params: [],
			version: 1,
		});
		const rt = makeRuntime();
		const rows = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.messages({
					namespace: "app",
					scope: "tenant",
					scopeId: "t-read",
				});
			}),
		);
		expect(rows.map((r) => r.key)).toContain("tenant-read");
	});
});

describe("I18nAdmin publish", () => {
	it("fails Forbidden when draft_value changed mid-flight; retry promotes the fresh draft", async () => {
		const rt = makeRuntime();
		const id = {
			namespace: "app",
			key: "v-publish-stale",
			locale: "en",
			scope: "global" as const,
			scopeId: "",
		};
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({ ...id, value: "staged" });
				// Simulate a concurrent saveDraft landing between
				// publish's getMessageRow read and its conditional
				// UPDATE: draft_value no longer matches the validated
				// draft → 0 rows → Forbidden, nothing goes live.
				readHooks.row = async () => {
					await db
						.update(i18nMessages)
						.set({ draftValue: "newer draft" })
						.where(eq(i18nMessages.key, id.key));
				};
				const err = yield* admin.publish(id).pipe(Effect.flip);
				expect(err).toBeInstanceOf(Forbidden);
				// Caller retries: reads the fresh draft, validates it,
				// promotes exactly that value.
				yield* admin.publish(id);
			}),
		);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, id.key));
		expect(rows[0]?.value).toBe("newer draft");
		expect(rows[0]?.draftValue).toBeNull();
		expect(rows[0]?.status).toBe("published");
	});

	it("rejects an invalid staged draft instead of publishing it", async () => {
		const rt = makeRuntime();
		const id = {
			namespace: "app",
			key: "v-publish-bad",
			locale: "en",
			scope: "global" as const,
			scopeId: "",
		};
		// Bypass saveDraft — plant a draft that could never validate.
		await db.insert(i18nMessages).values({
			namespace: id.namespace,
			key: id.key,
			locale: id.locale,
			scope: id.scope,
			scopeId: id.scopeId,
			kind: "text",
			value: "live",
			draftValue: "<b>markup</b>",
			status: "published",
			params: [],
			version: 3,
		});
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.publish(id).pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(I18nValidationError);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, id.key));
		expect(rows[0]?.value).toBe("live");
		expect(rows[0]?.draftValue).toBe("<b>markup</b>");
	});

	it("second publish is a no-op Forbidden — draft_value is gone", async () => {
		const rt = makeRuntime();
		const id = {
			namespace: "app",
			key: "v-publish-twice",
			locale: "en",
			scope: "global" as const,
			scopeId: "",
		};
		await rt
			.runPromise(
				Effect.gen(function* () {
					const admin = yield* I18nAdmin;
					yield* admin.saveDraft({ ...id, value: "once" });
					yield* admin.publish(id);
					return yield* admin.publish(id).pipe(Effect.flip);
				}),
			)
			.then((err) => expect(err).toBeInstanceOf(Forbidden));
	});
});

describe("I18nAdmin import batching", () => {
	it("imports >IMPORT_UPSERT_CHUNK entries as drafts in chunked upserts", async () => {
		const rt = makeRuntime();
		const total = 130; // crosses the 64-row chunk boundary
		const messages: Record<string, string> = {};
		for (let i = 0; i < total; i++) messages[`bulk-${i}`] = `value ${i}`;
		const res = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.importNamespace({
					version: 1,
					namespace: "bulk-import",
					messages: { en: messages },
				});
			}),
		);
		expect(res.imported).toBe(total);
		const rows = await db
			.select()
			.from(i18nMessages)
			.where(eq(i18nMessages.namespace, "bulk-import"));
		expect(rows).toHaveLength(total);
		expect(rows.every((r) => r.status === "draft" && r.draftValue !== null)).toBe(true);
		expect(rows.find((r) => r.key === "bulk-129")?.draftValue).toBe("value 129");
	});

	it("re-import upserts drafts via excluded.* — values update, rows don't duplicate", async () => {
		const rt = makeRuntime();
		const payload = {
			version: 1 as const,
			namespace: "reimport",
			messages: { en: { a: "one", b: "two" } },
		};
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.importNamespace(payload);
				yield* admin.importNamespace({
					...payload,
					messages: { en: { a: "ONE", c: "three" } },
				});
			}),
		);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.namespace, "reimport"));
		expect(rows).toHaveLength(3);
		const byKey = new Map(rows.map((r) => [r.key, r]));
		expect(byKey.get("a")?.draftValue).toBe("ONE");
		expect(byKey.get("b")?.draftValue).toBe("two");
		expect(byKey.get("c")?.draftValue).toBe("three");
	});
});

describe("I18nAdmin CRDT compaction", () => {
	it("collapses the op log to a single snapshot row past the limit", async () => {
		const rt = makeRuntime();
		const id = {
			namespace: "app",
			key: "v-crdt-compact",
			locale: "en",
			scope: "global" as const,
			scopeId: "",
		};
		// 201 saves > CRDT_LOG_LIMIT (200): the 201st triggers compaction.
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				for (let i = 0; i < 201; i++) {
					yield* admin.saveDraft({ ...id, value: `v${i}` });
				}
			}),
		);
		const ops = await db.select().from(i18nCrdtUpdates).where(eq(i18nCrdtUpdates.key, id.key));
		expect(ops).toHaveLength(1);
		// The snapshot still replays to the latest merged value.
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, id.key));
		expect(rows[0]?.draftValue).toBe("v200");
	});

	it("compaction's bounded delete preserves ops appended after the read", async () => {
		const rt = makeRuntime();
		const id = {
			namespace: "app",
			key: "v-crdt-race",
			locale: "en",
			scope: "global" as const,
			scopeId: "",
		};
		// 200 saves fill the log; the 201st triggers compaction
		// (updates.length + 1 > CRDT_LOG_LIMIT).
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				for (let i = 0; i < 200; i++) {
					yield* admin.saveDraft({ ...id, value: `v${i}` });
				}
				// A concurrent save's op row lands between
				// listCrdtUpdates and the compaction delete — its row id
				// is ABOVE maxId, so the bounded delete must leave it
				// alone (it merges on the next replay).
				readHooks.crdt = async () => {
					await db.insert(i18nCrdtUpdates).values({
						namespace: id.namespace,
						key: id.key,
						locale: id.locale,
						scope: id.scope,
						scopeId: id.scopeId,
						update: new Uint8Array([0xde, 0xad]),
						actorId: "racer",
					});
				};
				yield* admin.saveDraft({ ...id, value: "v200" });
			}),
		);
		const ops = await db.select().from(i18nCrdtUpdates).where(eq(i18nCrdtUpdates.key, id.key));
		// Snapshot row + the surviving concurrent op — the 200 read ops
		// were folded into the snapshot.
		expect(ops).toHaveLength(2);
		expect(ops.some((o) => o.actorId === "racer")).toBe(true);
		// The merged draft still reflects this save's value.
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, id.key));
		expect(rows[0]?.draftValue).toBe("v200");
	});
});

describe("I18nAdmin discardDraft", () => {
	it("keeps a draft saved after the read (stale-draft guard)", async () => {
		const rt = makeRuntime();
		const id = {
			namespace: "app",
			key: "v-discard-stale",
			locale: "en",
			scope: "global" as const,
			scopeId: "",
		};
		await db.insert(i18nMessages).values({
			namespace: id.namespace,
			key: id.key,
			locale: id.locale,
			scope: id.scope,
			scopeId: id.scopeId,
			kind: "text",
			value: "live",
			draftValue: "stale draft",
			status: "published",
			params: [],
			version: 1,
		});
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				// Concurrent saveDraft lands between discard's read and
				// its conditional UPDATE: draft_value changed → the
				// guarded UPDATE matches 0 rows → the FRESH draft
				// survives (discard is idempotent, no retry needed).
				readHooks.row = async () => {
					await db
						.update(i18nMessages)
						.set({ draftValue: "fresh draft" })
						.where(eq(i18nMessages.key, id.key));
				};
				yield* admin.discardDraft(id);
			}),
		);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, id.key));
		expect(rows[0]?.value).toBe("live");
		expect(rows[0]?.draftValue).toBe("fresh draft");
		expect(rows[0]?.status).toBe("published");
	});
});

describe("I18nAdmin locales", () => {
	it("setLocaleEnabled fails with a validation error for unknown codes", async () => {
		const rt = makeRuntime();
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.setLocaleEnabled("zz", true).pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(I18nValidationError);
	});

	it("setLocaleEnabled toggles a seeded locale", async () => {
		const rt = makeRuntime();
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.setLocaleEnabled("es", false);
			}),
		);
		const rows = await db.select().from(i18nLocales).where(eq(i18nLocales.code, "es"));
		expect(rows[0]?.enabled).toBe(false);
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.setLocaleEnabled("es", true);
			}),
		);
	});
});

describe("I18nAdmin locale gate", () => {
	const BASE = {
		namespace: "app",
		key: "loc-gate",
		scope: "global" as const,
		scopeId: "",
		value: "x",
	};

	it("saveDraft rejects unknown locales and the pseudo-locale before writing", async () => {
		const rt = makeRuntime();
		for (const locale of ["xx", "qps"]) {
			const err = await rt.runPromise(
				Effect.gen(function* () {
					const admin = yield* I18nAdmin;
					return yield* admin
						.saveDraft({ ...BASE, key: `loc-${locale}`, locale, value: "x" })
						.pipe(Effect.flip);
				}),
			);
			expect(err).toBeInstanceOf(I18nValidationError);
		}
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, "loc-gate"));
		expect(rows).toHaveLength(0);
		const qps = await db
			.select()
			.from(i18nMessages)
			.where(and(eq(i18nMessages.locale, "qps"), eq(i18nMessages.scope, "global")));
		expect(qps).toHaveLength(0);
	});

	it("publish rejects unknown and pseudo locales", async () => {
		const rt = makeRuntime();
		for (const locale of ["xx", "qps"]) {
			const err = await rt.runPromise(
				Effect.gen(function* () {
					const admin = yield* I18nAdmin;
					return yield* admin.publish({ ...BASE, key: "loc-pub", locale }).pipe(Effect.flip);
				}),
			);
			expect(err).toBeInstanceOf(I18nValidationError);
		}
	});

	it("discardDraft rejects unknown locales (but still allows qps cleanup)", async () => {
		const rt = makeRuntime();
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.discardDraft({ ...BASE, key: "loc-disc", locale: "xx" })
					.pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(I18nValidationError);
		// qps exists in i18n_locales → discard proceeds (no-op here).
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.discardDraft({ ...BASE, key: "loc-disc", locale: "qps" });
			}),
		);
	});

	it("importNamespace marks unknown-locale and qps entries invalid — nothing applies", async () => {
		const rt = makeRuntime();
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin
					.importNamespace({
						version: 1,
						namespace: "loc-imp",
						messages: {
							en: { ok: "valid" },
							xx: { bad: "unknown locale" },
							qps: { pseudo: "pseudo locale" },
						},
					})
					.pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(I18nValidationError);
		expect((err as I18nValidationError).error).toContain("unknown locale 'xx'");
		expect((err as I18nValidationError).error).toContain("qps");
		// Atomic: even the valid en entry was not staged.
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.namespace, "loc-imp"));
		expect(rows).toHaveLength(0);
	});
});

describe("I18nAdmin import kind reset", () => {
	it("re-import resets kind to text on conflict — rich rows don't stay rich", async () => {
		const rt = makeRuntime();
		// A row previously saved as rich; the import stages plain text
		// under the same logical key.
		await db.insert(i18nMessages).values({
			namespace: "kind-imp",
			key: "k",
			locale: "en",
			scope: "global",
			scopeId: "",
			kind: "rich",
			value: "",
			draftValue: "<p>old rich</p>",
			status: "draft",
			params: [],
			version: 1,
		});
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.importNamespace({
					version: 1,
					namespace: "kind-imp",
					messages: { en: { k: "plain text" } },
				});
			}),
		);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.namespace, "kind-imp"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("text");
		expect(rows[0]?.draftValue).toBe("plain text");
	});
});
