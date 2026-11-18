import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	defineCollection,
	DOCUMENT_STORE_TEST_DDL,
	DocumentCollections,
	DocumentStore,
	DocumentStoreLive,
	f,
	InvalidDocumentQuery,
	type DocumentStoreShape,
} from "@ktb/document-store";
import { PluginStates } from "@ktb/platform/plugin-states";
import { Permissions } from "@ktb/rbac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { ApiExposures, type ApiExposure } from "./exposure.ts";
import { ApiError } from "./http.ts";
import { Api, ApiLive, type ApiRequest } from "./service.ts";

/** Minimal groups stub — document_records.tenant_id FKs to groups.id. */
const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
INSERT INTO groups (id, name) VALUES (1, 'clinic-a');
`;

const notes = defineCollection({
	name: "test.notes",
	fields: {
		title: f.string({ required: true, maxLength: 50 }),
		status: f.string(),
		count: f.number(),
		code: f.string({ unique: true }),
	},
});

const things = defineCollection({
	name: "test.things",
	fields: { label: f.string({ required: true }) },
});

const secret = defineCollection({
	name: "test.secret",
	fields: { value: f.string() },
});

const targets = defineCollection({
	name: "test.targets",
	fields: { name: f.string({ required: true }) },
});

const refs = defineCollection({
	name: "test.refs",
	fields: {
		target: f.ref({ collection: "test.targets" }),
	},
});

const DEFS = [notes, things, secret, targets, refs];

const ALL_METHODS = ["list", "get", "create", "update", "delete"] as const;

const EXPOSURES: readonly ApiExposure[] = [
	// Full CRUD, session required, no permission.
	{ collection: "test.notes", methods: ALL_METHODS },
	// Public read-only alias of the same collection.
	{ collection: "test.notes", basePath: "/api/documents/notes", public: true },
	// Read-only default methods.
	{ collection: "test.things" },
	// Permission-gated full CRUD.
	{
		collection: "test.things",
		basePath: "/api/documents/permthings",
		permission: "things.all",
		methods: ALL_METHODS,
	},
	// Public WITH writes + permission — writes still need session+grant.
	{
		collection: "test.refs",
		basePath: "/api/documents/publicrefs",
		public: true,
		permission: "refs.all",
		methods: ALL_METHODS,
	},
	// Write-only exposure for ref-target setup (DocumentInUse path).
	{ collection: "test.targets", methods: ["create", "delete"] },
	// Exposed but the collection is unknown to the store.
	{ collection: "test.ghost" },
	// Enablement fixtures: plugin.on is enabled, plugin.off disabled
	// (only when the gated runtime binds PluginStates).
	{ collection: "test.things", basePath: "/api/documents/onthings", owner: "plugin.on" },
	{
		collection: "test.things",
		basePath: "/api/documents/offthings",
		owner: "plugin.off",
	},
	// Anonymous-read exposure owned by the disabled plugin — the
	// enablement gate must beat `public: true`.
	{
		collection: "test.notes",
		basePath: "/api/documents/offpub",
		public: true,
		owner: "plugin.off",
	},
];

/** PluginStates stub — only `enabledIds` is read by the Api gate. */
const pluginStatesStub = (enabled: readonly string[]) =>
	({
		isEnabled: () => Effect.succeed(true),
		enabledIds: () => Effect.succeed(new Set(enabled)),
		config: () => Effect.succeed(null),
		setEnabled: () => Effect.void,
		setConfig: () => Effect.void,
		entries: () => Effect.succeed([]),
	}) as unknown as PluginStates["Service"];

// Mutable grant switch for the Permissions stub.
let grantsAllow = true;

const permissionsStub = Permissions.of({
	can: () => Effect.succeed(grantsAllow),
	requirePermission: () =>
		grantsAllow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "x" } as never),
} as never);

const buildRuntime = (withPermissions: boolean, states?: PluginStates["Service"]) => {
	const db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
	const storeDeps = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(DocumentCollections, { collections: DEFS }),
	);
	const documentStore = DocumentStoreLive.pipe(Layer.provide(storeDeps));
	const apiDeps = Layer.mergeAll(
		documentStore,
		Layer.succeed(ApiExposures, { exposures: EXPOSURES }),
		...(withPermissions ? [Layer.succeed(Permissions, permissionsStub)] : []),
		...(states === undefined ? [] : [Layer.succeed(PluginStates, states)]),
	);
	// DocumentStore is merged out too so tests can seed rows directly.
	return ManagedRuntime.make(Layer.mergeAll(ApiLive.pipe(Layer.provide(apiDeps)), documentStore));
};

describe("Api service", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Api | DocumentStore, never>;
	let runtimeNoRbac: ManagedRuntime.ManagedRuntime<Api | DocumentStore, never>;
	let runtimeGated: ManagedRuntime.ManagedRuntime<Api | DocumentStore, never>;

	beforeAll(() => {
		runtime = buildRuntime(true);
		runtimeNoRbac = buildRuntime(false);
		// plugin.on enabled, plugin.off (and every other id) disabled.
		runtimeGated = buildRuntime(true, pluginStatesStub(["plugin.on"]));
	});

	afterAll(async () => {
		await Promise.all([runtime.dispose(), runtimeNoRbac.dispose(), runtimeGated.dispose()]);
	});

	const call = (
		rt: ManagedRuntime.ManagedRuntime<Api | DocumentStore, never>,
		userId: string | null,
		req: ApiRequest,
	) =>
		rt.runPromise(
			Effect.flatMap(Api, (api) => api.handle(req)).pipe(
				Effect.provideService(Principal, userId === null ? null : { userId }),
			),
		);

	/** Seed a record straight through DocumentStore (test setup only). */
	const seed = (collection: string, data: Record<string, unknown>, ownerId = "u1") =>
		runtime.runPromise(
			Effect.flatMap(DocumentStore, (store) => store.insert(collection, data as never)).pipe(
				Effect.provideService(Principal, { userId: ownerId }),
			),
		);

	const expectApiError = async (promise: Promise<unknown>, status: number, kind?: string) => {
		const error = await promise.then(
			() => {
				throw new Error("expected ApiError");
			},
			(e) => e,
		);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(status);
		if (kind !== undefined) expect((error as ApiError).kind).toBe(kind);
		return error as ApiError;
	};

	it("creates, lists, gets, updates and deletes an exposed collection", async () => {
		const created = await call(runtime, "u1", {
			key: "test.notes",
			id: null,
			method: "POST",
			body: { title: "first", status: "open", count: 2 },
		});
		expect(created.status).toBe(201);
		const createdBody = created.body as {
			id: number;
			data: { title: string };
			createdAt: string;
			updatedAt: string;
		};
		expect(createdBody.data.title).toBe("first");
		expect(createdBody.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		const list = await call(runtime, "u1", {
			key: "test.notes",
			id: null,
			method: "GET",
		});
		expect(list.status).toBe(200);
		const page = list.body as { rows: unknown[]; total: number; limit: number; offset: number };
		expect(page.total).toBe(1);
		expect(page.limit).toBe(50);
		expect(page.rows[0]).toMatchObject({ collection: "test.notes" });

		const got = await call(runtime, "u1", {
			key: "test.notes",
			id: createdBody.id,
			method: "GET",
		});
		expect(got.status).toBe(200);
		expect((got.body as { data: { title: string } }).data.title).toBe("first");

		const updated = await call(runtime, "u1", {
			key: "test.notes",
			id: createdBody.id,
			method: "PATCH",
			body: { status: "done" },
		});
		expect(updated.status).toBe(200);
		expect((updated.body as { data: { status: string } }).data.status).toBe("done");

		const del = await call(runtime, "u1", {
			key: "test.notes",
			id: createdBody.id,
			method: "DELETE",
		});
		expect(del).toEqual({ status: 204 });

		await expectApiError(
			call(runtime, "u1", { key: "test.notes", id: createdBody.id, method: "GET" }),
			404,
			"not_found",
		);
	});

	it("404s unknown keys, unexposed collections and unknown store collections alike", async () => {
		for (const key of ["nope", "test.secret", "test.ghost"]) {
			await expectApiError(call(runtime, "u1", { key, id: null, method: "GET" }), 404, "not_found");
		}
	});

	it("404s exposures owned by disabled plugins — even public ones", async () => {
		// Same indistinguishable 404 as an unexposed key.
		await expectApiError(
			call(runtimeGated, "u1", { key: "offthings", id: null, method: "GET" }),
			404,
			"not_found",
		);
		await expectApiError(
			call(runtimeGated, null, { key: "offpub", id: null, method: "GET" }),
			404,
			"not_found",
		);
		// Enabled-owner and ownerless exposures stay live.
		const on = await call(runtimeGated, "u1", { key: "onthings", id: null, method: "GET" });
		expect(on.status).toBe(200);
		const plain = await call(runtimeGated, "u1", {
			key: "test.things",
			id: null,
			method: "GET",
		});
		expect(plain.status).toBe(200);
		// Without PluginStates bound there is no gate — owner is ignored.
		const ungated = await call(runtime, "u1", { key: "offthings", id: null, method: "GET" });
		expect(ungated.status).toBe(200);
	});

	it("answers 404 for methods an exposure does not publish (no oracle)", async () => {
		// test.things publishes only list+get — writes get the SAME 404
		// as an unknown/unexposed key so anonymous callers cannot probe
		// which collections are exposed.
		await expectApiError(
			call(runtime, "u1", {
				key: "test.things",
				id: null,
				method: "POST",
				body: { label: "x" },
			}),
			404,
			"not_found",
		);
		// delete is not published either (default methods are list+get).
		await expectApiError(
			call(runtime, "u1", { key: "test.things", id: 1, method: "DELETE" }),
			404,
			"not_found",
		);
		// The 404 is indistinguishable from a genuinely unknown key.
		await expectApiError(
			call(runtime, "u1", { key: "test.secret", id: null, method: "POST", body: {} }),
			404,
			"not_found",
		);
		// get IS published — a missing record 404s through the store.
		await expectApiError(
			call(runtime, "u1", { key: "test.things", id: 99999, method: "GET" }),
			404,
			"not_found",
		);
		// list IS published.
		const list = await call(runtime, "u1", { key: "test.things", id: null, method: "GET" });
		expect(list.status).toBe(200);
	});

	it("rejects invalid method/path combos with 405", async () => {
		for (const req of [
			{ key: "test.notes", id: 1, method: "POST", body: {} },
			{ key: "test.notes", id: null, method: "PATCH", body: {} },
			{ key: "test.notes", id: null, method: "DELETE" },
			{ key: "test.notes", id: null, method: "PUT" },
		] as const) {
			await expectApiError(call(runtime, "u1", req), 405, "method_not_allowed");
		}
	});

	it("requires a session for non-public exposures", async () => {
		await expectApiError(
			call(runtime, null, { key: "test.notes", id: null, method: "GET" }),
			401,
			"unauthenticated",
		);
		await expectApiError(
			call(runtime, null, {
				key: "test.notes",
				id: null,
				method: "POST",
				body: { title: "x" },
			}),
			401,
			"unauthenticated",
		);
	});

	it("serves public list/get anonymously — system-owned rows only", async () => {
		// ownerId "" = system-owned personal row: the only kind an
		// anonymous (principal-less) caller can see through the store's
		// fencing. User-owned rows need a session.
		const seeded = await seed("test.notes", { title: "pub" }, "");
		const list = await call(runtime, null, { key: "notes", id: null, method: "GET" });
		expect(list.status).toBe(200);
		const page = list.body as { rows: { id: number; data: { title: string } }[]; total: number };
		expect(page.rows.map((r) => r.data.title)).toContain("pub");
		const got = await call(runtime, null, {
			key: "notes",
			id: (seeded as { id: number }).id,
			method: "GET",
		});
		expect(got.status).toBe(200);
	});

	it("fences rows by owner across sessions", async () => {
		await seed("test.notes", { title: "mine-u1" }, "u1");
		await seed("test.notes", { title: "mine-u2" }, "u2");
		const asU1 = await call(runtime, "u1", { key: "test.notes", id: null, method: "GET" });
		const titlesU1 = (asU1.body as { rows: { data: { title: string } }[] }).rows.map(
			(r) => r.data.title,
		);
		expect(titlesU1).toContain("mine-u1");
		expect(titlesU1).not.toContain("mine-u2");
		// Anonymous public reads see neither user's personal rows.
		const anon = await call(runtime, null, { key: "notes", id: null, method: "GET" });
		const anonTitles = (anon.body as { rows: { data: { title: string } }[] }).rows.map(
			(r) => r.data.title,
		);
		expect(anonTitles).not.toContain("mine-u1");
		expect(anonTitles).not.toContain("mine-u2");
	});

	it("never allows anonymous writes even on public exposures", async () => {
		await expectApiError(
			call(runtime, null, {
				key: "publicrefs",
				id: null,
				method: "POST",
				body: {},
			}),
			401,
			"unauthenticated",
		);
	});

	it("enforces declared permissions and fails closed without rbac", async () => {
		grantsAllow = false;
		await expectApiError(
			call(runtime, "u1", { key: "permthings", id: null, method: "GET" }),
			403,
			"forbidden",
		);
		grantsAllow = true;
		const ok = await call(runtime, "u1", { key: "permthings", id: null, method: "GET" });
		expect(ok.status).toBe(200);

		// No Permissions service at all → permission'd exposures fail closed.
		await expectApiError(
			call(runtimeNoRbac, "u1", { key: "permthings", id: null, method: "GET" }),
			403,
			"forbidden",
		);
		// …while permission-less exposures still work.
		const plain = await call(runtimeNoRbac, "u1", {
			key: "test.notes",
			id: null,
			method: "GET",
		});
		expect(plain.status).toBe(200);
	});

	it("checks the permission on public exposures' write methods", async () => {
		grantsAllow = false;
		await expectApiError(
			call(runtime, "u1", {
				key: "publicrefs",
				id: null,
				method: "POST",
				body: {},
			}),
			403,
			"forbidden",
		);
		grantsAllow = true;
	});

	it("404s missing records on get/update/delete", async () => {
		await expectApiError(
			call(runtime, "u1", { key: "test.notes", id: 99999, method: "GET" }),
			404,
			"not_found",
		);
		await expectApiError(
			call(runtime, "u1", {
				key: "test.notes",
				id: 99999,
				method: "PATCH",
				body: { title: "x" },
			}),
			404,
			"not_found",
		);
		await expectApiError(
			call(runtime, "u1", { key: "test.notes", id: 99999, method: "DELETE" }),
			404,
			"not_found",
		);
	});

	it("maps validation failures to 400 with issues", async () => {
		const error = await expectApiError(
			call(runtime, "u1", {
				key: "test.notes",
				id: null,
				method: "POST",
				body: { status: "no title" },
			}),
			400,
			"bad_request",
		);
		expect(error.issues?.length).toBeGreaterThan(0);
	});

	it("rejects non-object bodies", async () => {
		for (const body of [[], "str", 5, null]) {
			await expectApiError(
				call(runtime, "u1", { key: "test.notes", id: null, method: "POST", body }),
				400,
				"bad_request",
			);
		}
	});

	it("maps duplicate unique values to 409", async () => {
		await call(runtime, "u1", {
			key: "test.notes",
			id: null,
			method: "POST",
			body: { title: "a", code: "dup" },
		});
		await expectApiError(
			call(runtime, "u1", {
				key: "test.notes",
				id: null,
				method: "POST",
				body: { title: "b", code: "dup" },
			}),
			409,
			"conflict",
		);
	});

	it("maps broken refs to 400", async () => {
		const error = await expectApiError(
			call(runtime, "u1", {
				key: "publicrefs",
				id: null,
				method: "POST",
				body: { target: 424242 },
			}),
			400,
			"bad_request",
		);
		expect(error.message).toContain("target");
	});

	it("maps in-use deletes to 409", async () => {
		const target = await call(runtime, "u1", {
			key: "test.targets",
			id: null,
			method: "POST",
			body: { name: "t1" },
		});
		const targetId = (target.body as { id: number }).id;
		await call(runtime, "u1", {
			key: "publicrefs",
			id: null,
			method: "POST",
			body: { target: targetId },
		});
		const error = await expectApiError(
			call(runtime, "u1", { key: "test.targets", id: targetId, method: "DELETE" }),
			409,
			"conflict",
		);
		expect(error.message).toContain("test.refs.target");
	});

	it("applies list query params end-to-end", async () => {
		await call(runtime, "u1", {
			key: "test.notes",
			id: null,
			method: "POST",
			body: { title: "alpha", count: 1 },
		});
		await call(runtime, "u1", {
			key: "test.notes",
			id: null,
			method: "POST",
			body: { title: "beta", count: 9 },
		});

		const filtered = await call(runtime, "u1", {
			key: "test.notes",
			id: null,
			method: "GET",
			query: new URLSearchParams({ filter: '{"title":"beta"}' }),
		});
		expect(filtered.status).toBe(200);
		const page = filtered.body as { rows: { data: { title: string } }[]; total: number };
		expect(page.total).toBe(1);
		expect(page.rows[0]?.data.title).toBe("beta");

		const sorted = await call(runtime, "u1", {
			key: "test.notes",
			id: null,
			method: "GET",
			query: new URLSearchParams({ sort: "-count", limit: "1" }),
		});
		const sortedPage = sorted.body as { rows: { data: { title: string } }[] };
		expect(sortedPage.rows[0]?.data.title).toBe("beta");

		await expectApiError(
			call(runtime, "u1", {
				key: "test.notes",
				id: null,
				method: "GET",
				query: new URLSearchParams({ filter: '{"x":{"$nope":1}}' }),
			}),
			400,
			"bad_request",
		);
	});

	it("maps a store-side InvalidDocumentQuery to 400 (defense in depth)", async () => {
		// parseListQuery pre-validates with the same rules, so the real
		// store can never emit this tag through handle — a stubbed store
		// exercises the mapping anyway so a future store-side loosening
		// still surfaces a clean 400 instead of a 500.
		const die = () => Effect.die("unused") as never;
		const stubStore = {
			ensureCollection: die,
			insert: die,
			get: die,
			find: () =>
				Effect.fail(new InvalidDocumentQuery({ collection: "test.notes", issues: ["bad sort"] })),
			update: die,
			delete: die,
		} as unknown as DocumentStoreShape;
		const api = await Effect.runPromise(
			Effect.service(Api).pipe(
				Effect.provide(
					ApiLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								Layer.succeed(DocumentStore, stubStore),
								Layer.succeed(ApiExposures, {
									exposures: [{ collection: "test.notes" }],
								}),
							),
						),
					),
				),
			),
		);
		const error = await Effect.runPromise(
			api
				.handle({ key: "test.notes", id: null, method: "GET" })
				.pipe(Effect.provideService(Principal, { userId: "u1" }), Effect.flip),
		);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(400);
		expect((error as ApiError).kind).toBe("bad_request");
	});
});
