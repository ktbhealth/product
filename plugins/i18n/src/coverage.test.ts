import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden } from "@ktb/authz";
import { i18nManifestHash } from "@ktb/i18n";
import { PlatformAdmin, type PlatformAdminShape } from "@ktb/platform";
import { Permissions, type PermissionsShape } from "@ktb/rbac";

import { I18nAdmin, I18nAdminLive } from "./admin.ts";
import { I18N_TEST_DDL, i18nMessages, i18nNamespaces } from "./index.ts";
import { I18nRuntimeLive } from "./runtime.ts";

/**
 * I18nAdmin.coverage() — per-namespace translation coverage over
 * GLOBAL-scope rows only. Self-contained fixture db (cov.*
 * namespaces) so counts are exact regardless of other test files.
 *
 * i18n_locales is seeded by I18nRuntimeLive at layer build:
 * en, pt-BR, es enabled + qps disabled — qps is still a locale ROW,
 * so coverage's `translated` record carries an entry for it.
 *
 * Manifest-drift fixtures reuse REAL I18N_MANIFEST namespace names
 * (app, agenda, audit): drift compares i18n_namespaces.manifest_hash
 * against i18nManifestHash(ns) computed live.
 */

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

/** Global read grant (no tenant pinning) — the plain grant holder. */
const readPermissions: PermissionsShape = {
	permissionsFor: () => Effect.succeed(new Map()),
	canFor: () => Effect.succeed(true),
	can: () => Effect.succeed(true),
	requirePermissionFor: () => Effect.void,
	requirePermission: () => Effect.void,
	invalidate: () => Effect.void,
};

const makeRuntimeWithPermissions = (permissions: PermissionsShape, gate: PlatformAdminShape) =>
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

const COV_MSG = (
	namespace: string,
	key: string,
	locale: string,
	over: Partial<typeof i18nMessages.$inferInsert> = {},
) => ({
	namespace,
	key,
	locale,
	scope: "global" as const,
	scopeId: "",
	kind: "text" as const,
	value: "",
	status: "published" as const,
	params: [],
	version: 1,
	...over,
});

const runCoverage = (rt: ManagedRuntime.ManagedRuntime<I18nAdmin, never>) =>
	rt.runPromise(
		Effect.gen(function* () {
			const admin = yield* I18nAdmin;
			return yield* admin.coverage();
		}),
	);

beforeAll(async () => {
	db = makeDb(makeD1(I18N_TEST_DDL));
	// Sentinel namespace keeps i18n_namespaces non-empty so the runtime
	// layer's lazy baseline seed (admin.test.ts pattern) stays a no-op.
	await db.insert(i18nNamespaces).values({
		namespace: "_fixture",
		pluginId: "",
		defaultLocale: "en",
	});
	await db.insert(i18nNamespaces).values([
		{ namespace: "cov.reg", pluginId: "cov-plugin", defaultLocale: "pt-BR" },
		{ namespace: "cov.empty", pluginId: "", defaultLocale: "en" },
		{ namespace: "cov.scoped", pluginId: "scoped-plugin", defaultLocale: "en" },
		// Manifest-drift fixtures — all three names exist in
		// I18N_MANIFEST, exercising each manifestDrift verdict:
		//   app   — stored hash predates the current contract
		//   agenda — stored hash matches the live manifest
		//   audit — registered before hash recording ("")
		{ namespace: "app", pluginId: "", defaultLocale: "en" },
		{ namespace: "agenda", pluginId: "", defaultLocale: "en" },
		{ namespace: "audit", pluginId: "", defaultLocale: "en" },
	]);
	// Stored hashes are written post-insert so the fixtures can embed
	// i18nManifestHash("agenda") — the CURRENT contract hash.
	await db
		.update(i18nNamespaces)
		.set({ manifestHash: "00000000" })
		.where(eq(i18nNamespaces.namespace, "app"));
	await db
		.update(i18nNamespaces)
		.set({ manifestHash: i18nManifestHash("agenda") ?? "" })
		.where(eq(i18nNamespaces.namespace, "agenda"));
	// audit keeps the column default "" — the unrecorded case.
	await db.insert(i18nMessages).values([
		// cov.reg: 4 distinct keys across locales/statuses.
		COV_MSG("cov.reg", "a", "en", { value: "A" }),
		COV_MSG("cov.reg", "a", "pt-BR", { value: "A pt" }),
		COV_MSG("cov.reg", "b", "en", { value: "B" }),
		// Draft-status row: counts toward keyCount, NOT translated.
		COV_MSG("cov.reg", "b", "pt-BR", {
			value: "",
			draftValue: "B pt staged",
			status: "draft",
		}),
		// Never-published draft: same rule.
		COV_MSG("cov.reg", "c", "en", { value: "", draftValue: "C staged", status: "draft" }),
		// Published WITH a staged draft still counts as translated.
		COV_MSG("cov.reg", "d", "en", { value: "D live", draftValue: "D staged" }),
		// cov.orphan: rows but no i18n_namespaces registration.
		COV_MSG("cov.orphan", "x", "en", { value: "X" }),
		// cov.scoped: registered, but only NON-global rows — must not
		// count toward keyCount or translated.
		COV_MSG("cov.scoped", "t", "en", {
			scope: "tenant",
			scopeId: "t-1",
			value: "tenant copy",
		}),
		// cov.tenant-only: unregistered, only non-global rows — must
		// not appear in coverage at all.
		COV_MSG("cov.tenant-only", "t", "en", {
			scope: "tenant",
			scopeId: "t-1",
			value: "tenant copy",
		}),
	]);
});

describe("I18nAdmin coverage", () => {
	it("counts distinct keys and published-only translations per locale", async () => {
		const out = await runCoverage(makeRuntime());
		const cov = out.find((n) => n.namespace === "cov.reg");
		expect(cov).toBeDefined();
		expect(cov?.pluginId).toBe("cov-plugin");
		expect(cov?.defaultLocale).toBe("pt-BR");
		// a, b, c, d — draft rows still count as keys.
		expect(cov?.keyCount).toBe(4);
		// en published: a, b, d (c is draft-only) → 3.
		// pt-BR published: a only (b is draft) → 1.
		expect(cov?.translated.en).toBe(3);
		expect(cov?.translated["pt-BR"]).toBe(1);
		expect(cov?.translated.es).toBe(0);
		// Every i18n_locales row gets an entry — including the
		// disabled qps pseudo-locale.
		expect(Object.keys(cov?.translated ?? {}).sort()).toEqual(["en", "es", "pt-BR", "qps"].sort());
		expect(cov?.translated.qps).toBe(0);
	});

	it("includes namespaces known only from message rows with empty meta", async () => {
		const out = await runCoverage(makeRuntime());
		const cov = out.find((n) => n.namespace === "cov.orphan");
		expect(cov).toBeDefined();
		expect(cov?.pluginId).toBe("");
		expect(cov?.defaultLocale).toBe("en");
		expect(cov?.keyCount).toBe(1);
		expect(cov?.translated.en).toBe(1);
	});

	it("registered namespace with zero global rows reports keyCount 0", async () => {
		const out = await runCoverage(makeRuntime());
		const cov = out.find((n) => n.namespace === "cov.empty");
		expect(cov).toBeDefined();
		expect(cov?.keyCount).toBe(0);
		expect(Object.values(cov?.translated ?? {}).every((n) => n === 0)).toBe(true);
	});

	it("excludes non-global rows entirely — registered and unregistered", async () => {
		const out = await runCoverage(makeRuntime());
		// Registered namespace survives via i18n_namespaces but its
		// tenant-scope rows don't count.
		const scoped = out.find((n) => n.namespace === "cov.scoped");
		expect(scoped).toBeDefined();
		expect(scoped?.keyCount).toBe(0);
		// Unregistered namespace with ONLY tenant rows never appears.
		expect(out.find((n) => n.namespace === "cov.tenant-only")).toBeUndefined();
	});

	it("reports manifestDrift yes when the stored hash is stale", async () => {
		const out = await runCoverage(makeRuntime());
		const cov = out.find((n) => n.namespace === "app");
		expect(cov).toBeDefined();
		expect(cov?.manifestHash).toBe("00000000");
		expect(cov?.manifestDrift).toBe("yes");
	});

	it("reports manifestDrift no when the stored hash matches the manifest", async () => {
		const out = await runCoverage(makeRuntime());
		const cov = out.find((n) => n.namespace === "agenda");
		expect(cov).toBeDefined();
		expect(cov?.manifestHash).toBe(i18nManifestHash("agenda"));
		expect(cov?.manifestDrift).toBe("no");
	});

	it("reports manifestDrift unrecorded for empty hash and manifest-less namespaces", async () => {
		const out = await runCoverage(makeRuntime());
		// In the manifest but never hash-recorded.
		expect(out.find((n) => n.namespace === "audit")?.manifestDrift).toBe("unrecorded");
		// cov.* fixtures aren't in I18N_MANIFEST — DB-only orphans.
		expect(out.find((n) => n.namespace === "cov.reg")?.manifestDrift).toBe("unrecorded");
		expect(out.find((n) => n.namespace === "cov.orphan")?.manifestDrift).toBe("unrecorded");
		expect(out.find((n) => n.namespace === "cov.empty")?.manifestDrift).toBe("unrecorded");
	});

	it("fails Forbidden without a read grant or the admin gate", async () => {
		const rt = makeRuntime(denyGate);
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.coverage().pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(Forbidden);
	});

	it("succeeds for a plain read-grant holder without the admin gate", async () => {
		const rt = makeRuntimeWithPermissions(readPermissions, denyGate);
		const out = await runCoverage(rt);
		expect(out.find((n) => n.namespace === "cov.reg")?.keyCount).toBe(4);
	});
});
