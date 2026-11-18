import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformAdminPlugin,
	platformPanelPlugin,
} from "@ktb/platform";
import { Tenant } from "@ktb/tenant";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { DocumentCollections, defineCollection } from "./collection.ts";
import { f } from "./fields.ts";
import { DocumentStoreAdmin, DocumentStoreAdminLive, type AdminCollectionInfo } from "./admin.ts";
import {
	documentStoreAdminPlugin,
	documentStoreChromePlugin,
	documentStorePanelPlugin,
	documentStoreServicesPlugin,
	documentStoreTablesPlugin,
	plugins,
} from "./index.ts";
import { DocumentStoreLive, DOCUMENT_STORE_TEST_DDL } from "./service.ts";

const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
`;

const notes = defineCollection({
	name: "idx.notes",
	fields: { title: f.string({ required: true }) },
});

describe("document-store plugins", () => {
	it("exposes the five single-concern plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"document-store.tables",
			"document-store.services",
			"document-store.admin",
			"document-store.chrome",
			"document-store.panel",
		]);
		expect(documentStoreTablesPlugin.tables?.documentCollections).toBeDefined();
		expect(documentStoreTablesPlugin.tables?.documentRecords).toBeDefined();
		expect(documentStoreServicesPlugin.services).toBeDefined();
		expect(documentStoreAdminPlugin.services).toBeDefined();
		expect(documentStoreAdminPlugin.requiredDeps).toEqual([
			platformAdminPlugin.id,
			"document-store.services",
		]);
	});

	it("declares the console sidebar entry", () => {
		const chrome = documentStoreChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(1);
		const sidebar = chrome[0];
		expect(sidebar?.id).toBe("document-store.sidebar");
		expect(sidebar?.region).toBe("portal.sidebar");
		expect(sidebar?.content.kind).toBe("sidebarItem");
		const item =
			sidebar !== undefined && sidebar.content.kind === "sidebarItem" ? sidebar.content.item : null;
		expect(item?.to).toBe("/platform/document-store");
		expect(item?.group).toBe("Clinical data");
	});

	it("declares the collections page and the wildcard browser", () => {
		const pages = documentStorePanelPlugin.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual([
			"/platform/document-store",
			"/platform/document-store/*",
		]);
		for (const page of pages) {
			expect(page.guard).toBeTypeOf("function");
			expect(page.loader).toBeTypeOf("function");
		}
		expect(documentStorePanelPlugin.requiredDeps).toEqual([
			platformPanelPlugin.id,
			"document-store.admin",
		]);
	});
});

describe("document-store page effects", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;

	beforeAll(() => {
		const db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: [notes] }),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const storeLive = DocumentStoreLive.pipe(Layer.provide(deps));
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				DocumentStoreAdminLive.pipe(Layer.provide(Layer.mergeAll(storeLive, deps))),
				deps,
			) as Layer.Layer<unknown, never, never>,
		);
	});

	afterAll(() => runtime.dispose());

	const pages = documentStorePanelPlugin.panel!.pages!;
	const collectionsPage = pages[0]!;
	const browserPage = pages[1]!;

	const asPrincipal = <A, E>(
		principal: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
		tenant?: { id: number; kind: string; slug: string; role: "member" },
	) => {
		let eff = Effect.provideService(effect, Principal, principal);
		if (tenant !== undefined) {
			eff = Effect.provideService(eff, Tenant, tenant as never);
		}
		return runtime.runPromise(eff as Effect.Effect<A, E, never>);
	};

	it("collections guard allows admins and denies everyone else", async () => {
		await expect(
			asPrincipal(
				{ userId: "a1", email: "admin@x.com" },
				collectionsPage.guard!("/platform/document-store"),
			),
		).resolves.toBe(true);
		await expect(
			asPrincipal(
				{ userId: "u1", email: "doc@x.com" },
				collectionsPage.guard!("/platform/document-store"),
			),
		).resolves.toBe(false);
		await expect(
			asPrincipal(null, collectionsPage.guard!("/platform/document-store")),
		).resolves.toBe(false);
	});

	it("collections loader lists collections for admins and empties for others", async () => {
		const rows = (await asPrincipal(
			{ userId: "a1", email: "admin@x.com" },
			collectionsPage.loader!("/platform/document-store"),
		)) as readonly { name: string }[];
		expect(rows.map((r) => r.name)).toEqual(["idx.notes"]);
		const denied = (await asPrincipal(
			{ userId: "u1", email: "doc@x.com" },
			collectionsPage.loader!("/platform/document-store"),
		)) as readonly unknown[];
		expect(denied).toEqual([]);
	});

	it("browser guard 404s bad paths, unknown collections and non-admins", async () => {
		const admin = { userId: "a1", email: "admin@x.com" };
		// Contributed-but-unregistered collection still resolves.
		await expect(
			asPrincipal(admin, browserPage.guard!("/platform/document-store/idx.notes")),
		).resolves.toBe(true);
		await expect(
			asPrincipal(admin, browserPage.guard!("/platform/document-store/nope.missing")),
		).resolves.toBe(false);
		await expect(asPrincipal(admin, browserPage.guard!("/platform/document-store"))).resolves.toBe(
			false,
		);
		await expect(
			asPrincipal(admin, browserPage.guard!("/platform/document-store/a/b")),
		).resolves.toBe(false);
		await expect(
			asPrincipal(
				{ userId: "u1", email: "doc@x.com" },
				browserPage.guard!("/platform/document-store/idx.notes"),
			),
		).resolves.toBe(false);
	});

	it("browser loader returns the collection and first documents page", async () => {
		const admin = { userId: "a1", email: "admin@x.com" };
		const data = (await asPrincipal(
			admin,
			browserPage.loader!("/platform/document-store/idx.notes"),
		)) as { collection: { name: string } | null; page: { rows: unknown[]; total: number } | null };
		expect(data.collection?.name).toBe("idx.notes");
		expect(data.page).toEqual({ rows: [], total: 0 });

		// Bad path / unknown collection / non-admin → null payload.
		const empty = { collection: null, page: null };
		await expect(
			asPrincipal(admin, browserPage.loader!("/platform/document-store")),
		).resolves.toEqual(empty);
		await expect(
			asPrincipal(admin, browserPage.loader!("/platform/document-store/nope.missing")),
		).resolves.toEqual(empty);
		await expect(
			asPrincipal(
				{ userId: "u1", email: "doc@x.com" },
				browserPage.loader!("/platform/document-store/idx.notes"),
			),
		).resolves.toEqual(empty);
	});
});

describe("document-store page effects with a failing admin service", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;

	const info: AdminCollectionInfo = {
		name: "stub.collection",
		owner: "",
		version: 1,
		fields: {},
		contributed: false,
		registered: true,
		recordCount: 0,
		hasMigrations: false,
	};

	beforeAll(() => {
		// getCollection succeeds for "stub.*" names (Forbidden otherwise);
		// listDocuments fails with a tag derived from the collection name
		// suffix so each catchTag branch is exercised.
		const stubAdmin = DocumentStoreAdmin.of({
			listCollections: () => Effect.succeed([]),
			getCollection: (name: string) =>
				name.startsWith("stub.")
					? Effect.succeed({ ...info, name })
					: Effect.fail({ _tag: "Forbidden" } as never),
			listDocuments: (collection: string) =>
				Effect.fail({
					_tag: collection.endsWith("forbidden")
						? "Forbidden"
						: collection.endsWith("invalid")
							? "InvalidDocumentQuery"
							: "UnknownCollection",
				} as never),
			getDocument: () => Effect.fail({ _tag: "Forbidden" } as never),
			insertDocument: () => Effect.fail({ _tag: "Forbidden" } as never),
			updateDocument: () => Effect.fail({ _tag: "Forbidden" } as never),
			deleteDocument: () => Effect.fail({ _tag: "Forbidden" } as never),
		} as unknown as DocumentStoreAdmin["Service"]);
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(DocumentStoreAdmin, stubAdmin),
			) as Layer.Layer<unknown, never, never>,
		);
	});

	afterAll(() => runtime.dispose());

	const pages = documentStorePanelPlugin.panel!.pages!;
	const browserPage = pages[1]!;
	const admin = { userId: "a1", email: "admin@x.com" };

	const asPrincipal = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		runtime.runPromise(Effect.provideService(effect, Principal, admin));

	it("browser guard returns false when getCollection is denied", async () => {
		// adminGuard passes (admin email) but the service denies the read.
		await expect(
			asPrincipal(browserPage.guard!("/platform/document-store/idx.notes")),
		).resolves.toBe(false);
	});

	it("browser loader degrades on Forbidden, unknown and invalid collections", async () => {
		const empty = { collection: null, page: null };
		// getCollection Forbidden → null payload.
		await expect(
			asPrincipal(browserPage.loader!("/platform/document-store/idx.notes")),
		).resolves.toEqual(empty);
		// getCollection ok, listDocuments failing per tag → empty page.
		for (const suffix of ["unknown", "forbidden", "invalid"]) {
			const data = (await asPrincipal(
				browserPage.loader!(`/platform/document-store/stub.${suffix}`),
			)) as {
				collection: { name: string } | null;
				page: { rows: unknown[]; total: number } | null;
			};
			expect(data.collection?.name).toBe(`stub.${suffix}`);
			expect(data.page).toEqual({ rows: [], total: 0 });
		}
	});
});
