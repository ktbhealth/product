import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { DocumentCollections, defineCollection } from "./collection.ts";
import { f } from "./fields.ts";
import { DocumentStoreAdmin, DocumentStoreAdminLive } from "./admin.ts";
import { DocumentStoreLive, DOCUMENT_STORE_TEST_DDL } from "./service.ts";
import {
	browseDocumentsFn,
	createDocumentFn,
	deleteDocumentFn,
	documentsFn,
	listCollectionsFn,
	migrateCollectionFn,
	updateDocumentFn,
} from "./fns.ts";

const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
`;

const notes = defineCollection({
	name: "fns.notes",
	fields: {
		title: f.string({ required: true }),
		kind: f.enum(["a", "b"] as const),
	},
});

const uniq = defineCollection({
	name: "fns.uniq",
	fields: { code: f.string({ required: true, unique: true }) },
});

const refs = defineCollection({
	name: "fns.refs",
	fields: { target: f.ref({ collection: "fns.uniq" }) },
});

const big = defineCollection({
	name: "fns.big",
	fields: { payload: f.json() },
});

const DEFS = [notes, uniq, refs, big];

describe("document-store fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));
	const installRuntime = (rt: ManagedRuntime.ManagedRuntime<unknown, never>) =>
		installServerFnRuntime(rt, auth);

	beforeAll(async () => {
		const db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: DEFS }),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const storeLive = DocumentStoreLive.pipe(Layer.provide(deps));
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				DocumentStoreAdminLive.pipe(Layer.provide(Layer.mergeAll(storeLive, deps))),
				deps,
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(runtime);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		await expect(listCollectionsFn()).rejects.toThrow("unauthenticated");
		await expect(documentsFn({ data: { collection: "fns.notes" } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(browseDocumentsFn({ data: {} })).rejects.toThrow("unauthenticated");
		await expect(
			createDocumentFn({ data: { collection: "fns.notes", data: { title: "x" } } }),
		).rejects.toThrow("unauthenticated");
	});

	it("rejects every fn when the plugin package is disabled", async () => {
		currentEmail = "admin@x.com";
		installServerFnRuntime(runtime, auth, { pluginEnabled: async () => false });
		try {
			await expect(listCollectionsFn()).rejects.toThrow(
				'plugin "document-store.admin" is disabled',
			);
			await expect(documentsFn({ data: { collection: "fns.notes" } })).rejects.toThrow(
				'plugin "document-store.admin" is disabled',
			);
			await expect(browseDocumentsFn({ data: {} })).rejects.toThrow(
				'plugin "document-store.admin" is disabled',
			);
			await expect(
				createDocumentFn({ data: { collection: "fns.notes", data: {} } }),
			).rejects.toThrow('plugin "document-store.admin" is disabled');
		} finally {
			installRuntime(runtime);
		}
	});

	it("denies non-admin principals", async () => {
		currentEmail = "doc@x.com";
		await expect(listCollectionsFn()).resolves.toBeNull();
		await expect(documentsFn({ data: { collection: "fns.notes" } })).resolves.toBeNull();
		await expect(browseDocumentsFn({ data: {} })).resolves.toBeNull();
		await expect(
			createDocumentFn({ data: { collection: "fns.notes", data: { title: "x" } } }),
		).resolves.toEqual({ status: "denied" });
		await expect(
			updateDocumentFn({ data: { collection: "fns.notes", id: 1, data: {} } }),
		).resolves.toEqual({ status: "denied" });
		await expect(deleteDocumentFn({ data: { collection: "fns.notes", id: 1 } })).resolves.toEqual({
			status: "denied",
		});
	});

	it("creates, lists, updates and deletes documents as admin", async () => {
		currentEmail = "admin@x.com";
		const collections = await listCollectionsFn();
		expect(collections).toHaveLength(4);
		const notesInfo = collections!.find((c) => c.name === "fns.notes");
		expect(notesInfo).toMatchObject({
			contributed: true,
			registered: false,
			recordCount: 0,
		});
		expect(Object.keys(notesInfo!.fields)).toContain("title");

		const created = await createDocumentFn({
			data: {
				collection: "fns.notes",
				data: { title: "first", kind: "a" },
				idempotencyKey: "fns-k1",
			},
		});
		expect(created.status).toBe("saved");
		if (created.status !== "saved") return;
		expect(created.record.data).toMatchObject({ title: "first", kind: "a" });
		expect(created.record.createdAt).toMatch(/^\d{4}-/);
		// Idempotent replay through the wire: same key returns the
		// stored record, no second row.
		const replayed = await createDocumentFn({
			data: {
				collection: "fns.notes",
				data: { title: "ignored" },
				idempotencyKey: "fns-k1",
			},
		});
		expect(replayed.status).toBe("saved");
		const replayedRecord = replayed.status === "saved" ? replayed.record : null;
		expect(replayedRecord?.id).toBe(created.record.id);

		// Non-object data collapses to {} → required-field validation.
		const badData = await createDocumentFn({
			data: { collection: "fns.notes", data: "junk" },
		});
		expect(badData.status).toBe("invalid");

		// Invalid field values surface issues.
		const invalid = await createDocumentFn({
			data: { collection: "fns.notes", data: { title: "t", kind: "zzz" } },
		});
		expect(invalid.status).toBe("invalid");
		expect(invalid.status === "invalid" ? invalid.issues.join(" ") : "").toContain("kind");

		const page = await documentsFn({
			data: { collection: "fns.notes", limit: 10, offset: 0 },
		});
		expect(page).not.toBeNull();
		expect(page!.total).toBe(1);
		expect(page!.rows[0]!.id).toBe(created.record.id);

		const updated = await updateDocumentFn({
			data: {
				collection: "fns.notes",
				id: created.record.id,
				data: { title: "second" },
				expectedVersion: created.record.version,
			},
		});
		expect(updated.status).toBe("saved");
		expect(updated.status === "saved" ? updated.record.data.title : null).toBe("second");

		// Missing row → denied.
		await expect(
			updateDocumentFn({ data: { collection: "fns.notes", id: 999, data: { title: "x" } } }),
		).resolves.toEqual({ status: "denied" });
		// Unknown collection → denied.
		await expect(createDocumentFn({ data: { collection: "nope.x", data: {} } })).resolves.toEqual({
			status: "denied",
		});

		expect(
			await deleteDocumentFn({ data: { collection: "fns.notes", id: created.record.id } }),
		).toEqual({ status: "deleted" });
		await expect(deleteDocumentFn({ data: { collection: "fns.notes", id: 1 } })).resolves.toEqual({
			status: "denied",
		});
	});

	it("browses documents across collections with filter and paging", async () => {
		currentEmail = "admin@x.com";
		await createDocumentFn({ data: { collection: "fns.notes", data: { title: "b1" } } });
		await createDocumentFn({ data: { collection: "fns.uniq", data: { code: "browse-1" } } });

		const all = await browseDocumentsFn({ data: {} });
		expect(all).not.toBeNull();
		const collections = new Set(all!.rows.map((r) => r.collection));
		expect(collections.has("fns.notes")).toBe(true);
		expect(collections.has("fns.uniq")).toBe(true);

		const filtered = await browseDocumentsFn({ data: { collection: "fns.uniq" } });
		expect(filtered!.rows.every((r) => r.collection === "fns.uniq")).toBe(true);
		expect(filtered!.total).toBeGreaterThan(0);

		// Unknown filter → empty page, not an error.
		const none = await browseDocumentsFn({ data: { collection: "no.such" } });
		expect(none).toEqual({ rows: [], total: 0 });

		const paged = await browseDocumentsFn({ data: { limit: 1, offset: 0 } });
		expect(paged!.rows).toHaveLength(1);
		expect(paged!.total).toBe(all!.total);
	});

	it("maps unique and ref violations to invalid results", async () => {
		currentEmail = "admin@x.com";
		const first = await createDocumentFn({
			data: { collection: "fns.uniq", data: { code: "c1" } },
		});
		expect(first.status).toBe("saved");
		const id = first.status === "saved" ? first.record.id : -1;

		const dup = await createDocumentFn({
			data: { collection: "fns.uniq", data: { code: "c1" } },
		});
		expect(dup.status).toBe("invalid");
		expect(dup.status === "invalid" ? dup.issues.join(" ") : "").toContain("code");

		const bad = await createDocumentFn({
			data: { collection: "fns.refs", data: { target: 999999 } },
		});
		expect(bad.status).toBe("invalid");
		expect(bad.status === "invalid" ? bad.issues.join(" ") : "").toContain("target");
		expect(id).toBeGreaterThan(0);
	});

	it("maps oversized documents to invalid results", async () => {
		currentEmail = "admin@x.com";
		const res = await createDocumentFn({
			data: { collection: "fns.big", data: { payload: "x".repeat(70 * 1024) } },
		});
		expect(res.status).toBe("invalid");
		expect(res.status === "invalid" ? res.issues.join(" ") : "").toContain("too large");
	});

	it("returns in-use with referrers when a restricted delete is blocked", async () => {
		currentEmail = "admin@x.com";
		const target = await createDocumentFn({
			data: { collection: "fns.uniq", data: { code: "c2" } },
		});
		const id = target.status === "saved" ? target.record.id : -1;
		await createDocumentFn({ data: { collection: "fns.refs", data: { target: id } } });
		const del = await deleteDocumentFn({ data: { collection: "fns.uniq", id } });
		expect(del).toEqual({ status: "in-use", referencedBy: ["fns.refs.target"] });
	});

	it("migrates a collection and reports the sweep (T-130)", async () => {
		currentEmail = "admin@x.com";
		const res = await migrateCollectionFn({ data: { collection: "fns.notes" } });
		expect(res.status).toBe("migrated");
		if (res.status === "migrated") {
			expect(res.report.collection).toBe("fns.notes");
			expect(res.report.failed).toEqual([]);
		}
		// Unknown collection → denied (isHandled maps it).
		await expect(migrateCollectionFn({ data: { collection: "no.such" } })).resolves.toEqual({
			status: "denied",
		});
	});

	it("validates wire input before the handler runs", async () => {
		currentEmail = "admin@x.com";
		await expect(documentsFn({ data: {} } as never)).rejects.toBeInstanceOf(Error);
		await expect(createDocumentFn({ data: { collection: 1 } } as never)).rejects.toBeInstanceOf(
			Error,
		);
		await expect(
			updateDocumentFn({ data: { collection: "fns.notes", id: "1" } } as never),
		).rejects.toBeInstanceOf(Error);
		await expect(deleteDocumentFn({ data: { id: 1 } } as never)).rejects.toBeInstanceOf(Error);
		await expect(migrateCollectionFn({ data: {} } as never)).rejects.toBeInstanceOf(Error);
		await expect(browseDocumentsFn({ data: { limit: "x" } } as never)).rejects.toBeInstanceOf(
			Error,
		);
	});

	it("propagates unexpected service errors instead of mapping them", async () => {
		const stubAdmin = DocumentStoreAdmin.of({
			listCollections: () => Effect.fail({ _tag: "Other" }),
			getCollection: () => Effect.fail({ _tag: "Other" }),
			listDocuments: () => Effect.fail({ _tag: "Other" }),
			browseDocuments: () => Effect.fail({ _tag: "Other" }),
			getDocument: () => Effect.fail({ _tag: "Other" }),
			insertDocument: () => Effect.fail({ _tag: "Other" }),
			updateDocument: () => Effect.fail({ _tag: "Other" }),
			deleteDocument: () => Effect.fail({ _tag: "Other" }),
			migrateCollection: () => Effect.fail({ _tag: "Other" }),
		} as unknown as DocumentStoreAdmin["Service"]);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(DocumentStoreAdmin, stubAdmin),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			await expect(listCollectionsFn()).rejects.toMatchObject({ _tag: "Other" });
			await expect(documentsFn({ data: { collection: "fns.notes" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(browseDocumentsFn({ data: {} })).rejects.toMatchObject({ _tag: "Other" });
			await expect(
				createDocumentFn({ data: { collection: "fns.notes", data: {} } }),
			).rejects.toMatchObject({ _tag: "Other" });
			await expect(
				updateDocumentFn({ data: { collection: "fns.notes", id: 1, data: {} } }),
			).rejects.toMatchObject({ _tag: "Other" });
			await expect(
				deleteDocumentFn({ data: { collection: "fns.notes", id: 1 } }),
			).rejects.toMatchObject({ _tag: "Other" });
			await expect(
				migrateCollectionFn({ data: { collection: "fns.notes" } }),
			).rejects.toMatchObject({ _tag: "Other" });
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});

	it("propagates non-tagged failures untouched", async () => {
		const stubAdmin = DocumentStoreAdmin.of({
			listCollections: () => Effect.fail(new Error("plain-boom")),
			getCollection: () => Effect.fail(new Error("plain-boom")),
			listDocuments: () => Effect.fail("str-boom" as never),
			browseDocuments: () => Effect.fail(new Error("plain-boom")),
			getDocument: () => Effect.fail(new Error("plain-boom")),
			insertDocument: () => Effect.fail(new Error("plain-boom")),
			updateDocument: () => Effect.fail(new Error("plain-boom")),
			deleteDocument: () => Effect.fail(new Error("plain-boom")),
			migrateCollection: () => Effect.fail(new Error("plain-boom")),
		} as unknown as DocumentStoreAdmin["Service"]);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(DocumentStoreAdmin, stubAdmin),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			await expect(listCollectionsFn()).rejects.toThrow("plain-boom");
			await expect(documentsFn({ data: { collection: "fns.notes" } })).rejects.toBe("str-boom");
			await expect(browseDocumentsFn({ data: {} })).rejects.toThrow("plain-boom");
			await expect(migrateCollectionFn({ data: { collection: "fns.notes" } })).rejects.toThrow(
				"plain-boom",
			);
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});
});
