import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant } from "@ktb/tenant";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { DocumentCollections, defineCollection } from "./collection.ts";
import { f } from "./fields.ts";
import { documentCollections, documentRecords } from "./schema.ts";
import { DocumentStoreAdmin, DocumentStoreAdminLive, type AdminCollectionInfo } from "./admin.ts";
import { DocumentStore, DocumentStoreLive, DOCUMENT_STORE_TEST_DDL } from "./service.ts";

/** Minimal groups stub — document_records.tenant_id FKs to groups.id. */
const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
INSERT INTO groups (id, name) VALUES (1, 'clinic-a'), (2, 'clinic-b');
`;

const targets = defineCollection({
	name: "admin.targets",
	fields: { label: f.string({ required: true }) },
});

const notes = defineCollection({
	name: "admin.notes",
	fields: {
		title: f.string({ required: true }),
		body: f.string(),
		kind: f.enum(["x", "y"] as const),
		when: f.date(),
		meta: f.json(),
		flag: f.boolean(),
		ref: f.ref({ collection: "admin.targets" }),
	},
});

/** Contributed but never registered — lists with zero records. */
const lazy = defineCollection({
	name: "admin.lazy",
	fields: { v: f.string() },
});

/** Contributed, unregistered and owner-stamped — covers the
 * infoFromDef owner path. */
const lazyOwned = defineCollection({
	name: "admin.lazy-owned",
	owner: "some.plugin",
	fields: { v: f.string() },
});

const DEFS = [targets, notes, lazy, lazyOwned];

const tenantA = { id: 1, kind: "clinic", slug: "a", role: "member" } as const;

describe("DocumentStoreAdminLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStoreAdmin, never>;
	let store: ManagedRuntime.ManagedRuntime<DocumentStore, never>;
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: DEFS }),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const storeLive = DocumentStoreLive.pipe(Layer.provide(deps));
		store = ManagedRuntime.make(storeLive as Layer.Layer<DocumentStore, never, never>);
		runtime = ManagedRuntime.make(
			DocumentStoreAdminLive.pipe(Layer.provide(Layer.mergeAll(storeLive, deps))) as Layer.Layer<
				DocumentStoreAdmin,
				never,
				never
			>,
		);
	});

	afterAll(() => Promise.all([runtime.dispose(), store.dispose()]));

	const asAdmin = <A, E>(effect: Effect.Effect<A, E, DocumentStoreAdmin>) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, { userId: "admin1", email: "admin@x.com" }),
		);

	const asUser = <A, E>(effect: Effect.Effect<A, E, DocumentStoreAdmin>) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, { userId: "u1", email: "doc@x.com" }),
		);

	const storeAs = <A, E>(
		userId: string,
		effect: Effect.Effect<A, E, DocumentStore>,
		tenant?: typeof tenantA,
	) => {
		let eff = Effect.provideService(effect, Principal, { userId });
		if (tenant !== undefined) eff = Effect.provideService(eff, Tenant, tenant);
		return store.runPromise(eff);
	};

	const viaStore = <A, E>(f: (s: DocumentStore["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(DocumentStore, f);

	it("denies non-admin principals on every method", async () => {
		const eff = Effect.gen(function* () {
			const admin = yield* DocumentStoreAdmin;
			yield* admin.listCollections();
		});
		await expect(asUser(eff)).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(Effect.flatMap(DocumentStoreAdmin, (a) => a.getCollection("admin.notes"))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(Effect.flatMap(DocumentStoreAdmin, (a) => a.listDocuments("admin.notes"))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("lists contributed defs, DB rows and record counts", async () => {
		// Seed records across two scopes: a personal row and a tenant row.
		await storeAs(
			"u1",
			viaStore((s) => s.insert(notes, { title: "personal" })),
		);
		await storeAs(
			"u2",
			viaStore((s) => s.insert(notes, { title: "tenant-doc" })),
			tenantA,
		);
		// A DB-only collection row (no contribution) — exercises the
		// schema_json decode path, plus one record under it.
		const now = new Date();
		const legacyRows = await db
			.insert(documentCollections)
			.values({
				name: "legacy.thing",
				ownerPluginId: "old.plugin",
				schemaJson: JSON.stringify({
					name: "legacy.thing",
					version: 4,
					fields: { a: { kind: "string" } },
				}),
				version: 4,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		await db.insert(documentRecords).values({
			collectionId: legacyRows[0]!.id,
			data: JSON.stringify({ a: "legacy" }),
			ownerId: "sys",
			createdAt: now,
			updatedAt: now,
		});

		const infos = (await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) => a.listCollections()),
		)) as readonly AdminCollectionInfo[];
		const byName = new Map(infos.map((i) => [i.name, i]));
		expect(byName.get("admin.notes")).toMatchObject({
			contributed: true,
			registered: true,
			recordCount: 2,
			version: 1,
		});
		expect(Object.keys(byName.get("admin.notes")!.fields)).toContain("title");
		expect(byName.get("admin.lazy")).toMatchObject({
			contributed: true,
			registered: false,
			recordCount: 0,
		});
		expect(byName.get("legacy.thing")).toMatchObject({
			contributed: false,
			registered: true,
			owner: "old.plugin",
			version: 4,
			recordCount: 1,
		});
	});

	it("getCollection resolves contributed, DB-only and unknown names", async () => {
		const get = (name: string) =>
			asAdmin(Effect.flatMap(DocumentStoreAdmin, (a) => a.getCollection(name)));
		expect((await get("admin.notes"))?.name).toBe("admin.notes");
		expect((await get("legacy.thing"))?.fields).toEqual({ a: { kind: "string" } });
		expect((await get("admin.lazy-owned"))?.owner).toBe("some.plugin");
		await expect(get("nope.missing")).resolves.toBeNull();
	});

	it("surfaces DB rows whose schema_json fails to decode", async () => {
		const now = new Date();
		await db.insert(documentCollections).values({
			name: "broken.schema",
			ownerPluginId: "",
			schemaJson: "{not json",
			version: 2,
			createdAt: now,
			updatedAt: now,
		});
		const get = (name: string) =>
			asAdmin(Effect.flatMap(DocumentStoreAdmin, (a) => a.getCollection(name)));
		expect(await get("broken.schema")).toMatchObject({
			contributed: false,
			registered: true,
			fields: {},
			owner: "",
			version: 2,
			recordCount: 0,
		});
		const infos = (await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) => a.listCollections()),
		)) as readonly AdminCollectionInfo[];
		expect(infos.find((i) => i.name === "broken.schema")?.fields).toEqual({});

		// Remove the corrupt row — DocumentStore's ref checks parse every
		// collection's schema_json and would choke on it in later tests.
		await db.delete(documentCollections).where(eq(documentCollections.name, "broken.schema"));
	});

	it("reads and writes documents across every scope", async () => {
		// admin.notes already holds one personal (u1) + one tenant (u2,
		// clinic-a) row from the previous test — the admin sees both
		// even though neither belongs to the admin's personal scope.
		const page = await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) => a.listDocuments("admin.notes", { limit: 50 })),
		);
		expect(page.total).toBe(2);
		expect(
			page.rows.map((r) => r.data.title).sort((a, b) => String(a).localeCompare(String(b))),
		).toEqual(["personal", "tenant-doc"]);

		// Update the tenant-owned row — invisible to a scoped caller.
		const tenantRow = page.rows.find((r) => r.data.title === "tenant-doc")!;
		const updated = await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) =>
				a.updateDocument("admin.notes", tenantRow.id, { body: "edited" }),
			),
		);
		expect(updated.data.body).toBe("edited");
		expect(updated.ownerId).toBe("u2");
		expect(updated.tenantId).toBe(1);

		// Validation still applies: bad enum + unknown field.
		await expect(
			asAdmin(
				Effect.flatMap(DocumentStoreAdmin, (a) =>
					a.insertDocument("admin.notes", { title: "t", kind: "zzz" }),
				),
			),
		).rejects.toMatchObject({ _tag: "DocumentValidationError" });

		// Create + delete round-trip.
		const created = await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) =>
				a.insertDocument("admin.notes", {
					title: "admin-made",
					kind: "y",
					when: 1700000000000,
					meta: { k: [1, 2] },
					flag: true,
				}),
			),
		);
		expect(created.collection).toBe("admin.notes");
		expect(created.data.flag).toBe(true);
		await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) => a.deleteDocument("admin.notes", created.id)),
		);
		await expect(
			asAdmin(Effect.flatMap(DocumentStoreAdmin, (a) => a.getDocument("admin.notes", created.id))),
		).resolves.toBeNull();
	});

	it("surfaces ref onDelete policies unscoped", async () => {
		// Point a notes row at a target, then delete the target — the
		// restrict policy sees the reference even across scopes.
		const target = await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) => a.insertDocument("admin.targets", { label: "t1" })),
		);
		const holder = await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) =>
				a.insertDocument("admin.notes", { title: "holder", ref: target.id }),
			),
		);
		await expect(
			asAdmin(
				Effect.flatMap(DocumentStoreAdmin, (a) => a.deleteDocument("admin.targets", target.id)),
			),
		).rejects.toMatchObject({ _tag: "DocumentInUse" });
		await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) => a.deleteDocument("admin.notes", holder.id)),
		);
		await asAdmin(
			Effect.flatMap(DocumentStoreAdmin, (a) => a.deleteDocument("admin.targets", target.id)),
		);
	});
});
