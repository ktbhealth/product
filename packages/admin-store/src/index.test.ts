import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { integer, sqliteTable, text } from "@ktb/db/table";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { resetServerRuntime, setServerRuntime } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { asAdmin, defineAdminStore, isHandledError, orHandled } from "./index.ts";
import * as Data from "effect/Data";

/**
 * Fixture-only table — no drizzle definition ships with the package,
 * so the DDL is exec'd through `makeTestD1`'s `sql` channel and the
 * `sqliteTable` ref below only shapes the query builder.
 */
const widgets = sqliteTable("widgets", {
	id: integer().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	description: text(),
	payload: text().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

const WIDGETS_DDL = `
CREATE TABLE widgets (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	description TEXT,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);`;

type WidgetRow = typeof widgets.$inferSelect;

const toMeta = (row: WidgetRow) => ({
	id: row.id,
	name: row.name,
	description: row.description,
	updatedAt: row.updatedAt,
});

const toDoc = (row: WidgetRow) => ({ ...toMeta(row), payload: row.payload });

const store = defineAdminStore({
	serviceName: "Widgets",
	table: widgets,
	columns: { id: widgets.id, name: widgets.name, updatedAt: widgets.updatedAt },
	payloadField: "payload",
	defaultPayload: "{}",
	errors: {
		notFound: "WidgetNotFound",
		invalidName: "InvalidWidgetName",
		nameTaken: "WidgetNameTaken",
		invalidPayload: "InvalidWidget",
	},
	toMeta,
	toDoc,
	validatePayload: (value) => value.startsWith("{"),
	naturalKey: {
		columns: [widgets.name],
		// `skipKey` exercises the "probe returns undefined" path — the
		// write proceeds without a uniqueness check.
		values: (name, input) =>
			(input as { skipKey?: boolean }).skipKey === true ? undefined : [name],
	},
});

/** Minimal store: no natural key, no payload gate. */
const plainStore = defineAdminStore({
	serviceName: "Plain",
	table: widgets,
	columns: { id: widgets.id, name: widgets.name, updatedAt: widgets.updatedAt },
	payloadField: "payload",
	defaultPayload: "",
	errors: {
		notFound: "PlainNotFound",
		invalidName: "PlainInvalidName",
		nameTaken: "PlainNameTaken",
		invalidPayload: "PlainInvalid",
	},
	toMeta,
	toDoc,
});

const ADMIN = { userId: "admin-1", email: "admin@x.com" } as const;
const USER = { userId: "user-1", email: "user@x.com" } as const;

const deps = Layer.merge(
	Layer.succeed(Db, makeDb(makeTestD1(WIDGETS_DDL))),
	Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
);

describe("defineAdminStore", () => {
	let methods: (typeof store.build extends Effect.Effect<infer B, unknown, unknown>
		? B
		: never)["methods"];

	beforeAll(async () => {
		const built = await Effect.runPromise(store.build.pipe(Effect.provide(deps)));
		methods = built.methods;
	});

	const asUser = <A, E>(user: typeof ADMIN | typeof USER | null, eff: Effect.Effect<A, E>) =>
		Effect.runPromise(user === null ? eff : eff.pipe(Effect.provideService(Principal, user)));

	const admin = <A, E>(eff: Effect.Effect<A, E>) => asUser(ADMIN, eff);

	it("adminCreate trims the name, applies defaults and returns the doc", async () => {
		const doc = await admin(methods.adminCreate({ name: "  alpha  " }));
		expect(doc).toMatchObject({
			name: "alpha",
			description: null,
			payload: "{}",
		});
		expect(doc!.updatedAt).toBeInstanceOf(Date);
	});

	it("adminCreate rejects blank names, taken keys and bad payloads", async () => {
		await expect(admin(methods.adminCreate({ name: "   " }))).rejects.toMatchObject({
			_tag: "InvalidWidgetName",
		});
		await expect(admin(methods.adminCreate({ name: "alpha" }))).rejects.toMatchObject({
			_tag: "WidgetNameTaken",
		});
		await expect(
			admin(methods.adminCreate({ name: "beta", payload: "not-json" })),
		).rejects.toMatchObject({ _tag: "InvalidWidget", payload: "not-json" });
	});

	it("adminCreate stores an explicit payload and description", async () => {
		const doc = await admin(
			methods.adminCreate({
				name: "beta",
				description: "  a note  ",
				payload: '{"x":1}',
			}),
		);
		expect(doc).toMatchObject({ name: "beta", description: "a note", payload: '{"x":1}' });
	});

	it("adminList returns metas newest-first without the payload", async () => {
		const list = await admin(methods.adminList());
		expect(list.map((m) => m.name)).toEqual(["beta", "alpha"]);
		expect(list[0]).not.toHaveProperty("payload");
	});

	it("adminGet returns the doc or null", async () => {
		const alpha = (await admin(methods.adminList()))[1]!;
		const doc = await admin(methods.adminGet(alpha.id));
		expect(doc).toMatchObject({ id: alpha.id, name: "alpha", payload: "{}" });
		expect(await admin(methods.adminGet(9999))).toBeNull();
	});

	it("adminUpdate applies partial writes and clears blank descriptions", async () => {
		const alpha = (await admin(methods.adminList())).find((m) => m.name === "alpha")!;
		const updated = await admin(
			methods.adminUpdate(alpha.id, { description: "   ", payload: '{"y":2}' }),
		);
		expect(updated).toMatchObject({ name: "alpha", description: null, payload: '{"y":2}' });
		// Untouched fields survive; a rename to self is not a conflict.
		const renamed = await admin(
			methods.adminUpdate(alpha.id, { name: " alpha ", description: "kept" }),
		);
		expect(renamed).toMatchObject({ name: "alpha", description: "kept" });
	});

	it("adminUpdate rejects bad names, taken keys, bad payloads and missing rows", async () => {
		const alpha = (await admin(methods.adminList())).find((m) => m.name === "alpha")!;
		await expect(admin(methods.adminUpdate(alpha.id, { name: " " }))).rejects.toMatchObject({
			_tag: "InvalidWidgetName",
		});
		await expect(admin(methods.adminUpdate(alpha.id, { name: "beta" }))).rejects.toMatchObject({
			_tag: "WidgetNameTaken",
		});
		await expect(admin(methods.adminUpdate(alpha.id, { payload: "nope" }))).rejects.toMatchObject({
			_tag: "InvalidWidget",
		});
		await expect(admin(methods.adminUpdate(9999, { name: "ghost" }))).rejects.toMatchObject({
			_tag: "WidgetNotFound",
		});
	});

	it("adminRemove deletes and reports missing rows", async () => {
		const beta = (await admin(methods.adminList())).find((m) => m.name === "beta")!;
		await admin(methods.adminRemove(beta.id));
		expect(await admin(methods.adminGet(beta.id))).toBeNull();
		await expect(admin(methods.adminRemove(beta.id))).rejects.toMatchObject({
			_tag: "WidgetNotFound",
		});
	});

	it("getById is public — no admin gate", async () => {
		const alpha = (await admin(methods.adminList()))[0]!;
		const doc = await asUser(null, methods.getById(alpha.id));
		expect(doc).toMatchObject({ name: "alpha" });
		expect(await asUser(null, methods.getById(9999))).toBeNull();
	});

	it("admin methods fail Forbidden for non-admin principals", async () => {
		await expect(asUser(USER, methods.adminList())).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(asUser(null, methods.adminList())).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("naturalKey.values → undefined skips the uniqueness probe", async () => {
		// `skipKey` bypasses the probe, so a duplicate name inserts.
		const first = await admin(methods.adminCreate({ name: "dup" }));
		const second = await admin(methods.adminCreate({ name: "dup", skipKey: true } as never));
		expect(first!.id).not.toBe(second!.id);
	});

	it("adminUpdate with skipKey bypasses the rename probe", async () => {
		const created = await admin(methods.adminCreate({ name: "pre-rename" }));
		// `values` returns undefined → no probe → the rename to an
		// existing name ("dup") succeeds.
		const updated = await admin(
			methods.adminUpdate(created!.id, { name: "dup", skipKey: true } as never),
		);
		expect(updated).toMatchObject({ name: "dup" });
	});
});

describe("defineAdminStore without naturalKey/validatePayload", () => {
	let methods: (typeof plainStore.build extends Effect.Effect<infer B, unknown, unknown>
		? B
		: never)["methods"];

	beforeAll(async () => {
		const built = await Effect.runPromise(plainStore.build.pipe(Effect.provide(deps)));
		methods = built.methods;
	});

	it("accepts any payload and duplicate names", async () => {
		const doc = await Effect.runPromise(
			methods
				.adminCreate({ name: "free", payload: "anything" })
				.pipe(Effect.provideService(Principal, ADMIN)),
		);
		expect(doc).toMatchObject({ name: "free", payload: "anything" });
		const dup = await Effect.runPromise(
			methods.adminCreate({ name: "free" }).pipe(Effect.provideService(Principal, ADMIN)),
		);
		// No probe → no nameTaken; payload omitted → defaultPayload "".
		expect(dup).toMatchObject({ name: "free", payload: "" });
	});

	it("adminUpdate renames without a natural-key probe", async () => {
		const doc = await Effect.runPromise(
			methods.adminCreate({ name: "old" }).pipe(Effect.provideService(Principal, ADMIN)),
		);
		const updated = await Effect.runPromise(
			methods.adminUpdate(doc!.id, { name: "new" }).pipe(Effect.provideService(Principal, ADMIN)),
		);
		expect(updated).toMatchObject({ name: "new" });
	});
});

describe("asAdmin", () => {
	// `asAdmin` delegates to the registered ServerRuntime's `runAs`,
	// which in the composed app binds Principal/Tenant. The stub binds
	// the user as Principal and provides the same Db + PlatformAdmin
	// deps the service tests use.
	beforeAll(() => {
		setServerRuntime({
			run: (effect) =>
				Effect.runPromise(Effect.provide(effect as Effect.Effect<never, unknown, never>, deps)),
			runAs: (user, effect) =>
				Effect.runPromise(
					(effect as Effect.Effect<never, unknown, never>).pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
						}),
						Effect.provide(deps),
					),
				),
			getLocale: () => "en",
			audioTranscribeModel: "test-model",
		});
	});

	afterAll(() => resetServerRuntime());

	it("runs the effect as the user after the PlatformAdmin gate", async () => {
		const built = await Effect.runPromise(store.build.pipe(Effect.provide(deps)));
		const list = await asAdmin({ id: "admin-1", email: "admin@x.com" }, built.methods.adminList());
		expect(list.length).toBeGreaterThan(0);
		// A non-admin principal fails the in-service gate.
		await expect(
			asAdmin({ id: "user-1", email: "user@x.com" }, built.methods.adminList()),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});
});

/** Custom-write store: exercises `writes`, `orderBy`, `names` and
 * error-class injection — the shape plugins like rich-text/pages/
 * templates/image migrate to. */
class GadgetMissing extends Data.TaggedError("GadgetMissing")<{ readonly id: number }> {}

const customStore = defineAdminStore({
	serviceName: "Gadgets",
	table: widgets,
	columns: { id: widgets.id },
	orderBy: [widgets.name],
	errors: {
		notFound: GadgetMissing,
		invalidName: "GadgetInvalidName",
		nameTaken: "GadgetNameTaken",
		invalidPayload: "GadgetInvalid",
	},
	toMeta,
	toDoc,
	writes: {
		create: (input: { readonly label?: string }, ctx) =>
			Effect.gen(function* () {
				const now = new Date();
				const rows = yield* Effect.promise(() =>
					ctx.db
						.insert(widgets)
						.values({
							name: input.label?.trim() || "unlabeled",
							description: null,
							payload: "{}",
							createdAt: now,
							updatedAt: now,
						})
						.returning(),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
		update: (id: number, input: { readonly note?: string }, ctx) =>
			Effect.gen(function* () {
				const rows = yield* Effect.promise(() =>
					ctx.db
						.update(widgets)
						.set({ description: input.note ?? null, updatedAt: new Date() })
						.where(ctx.byId(id))
						.returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new GadgetMissing({ id });
				return toDoc(row);
			}),
	},
	names: { create: "register" },
});

describe("defineAdminStore custom writes", () => {
	let methods: (typeof customStore.build extends Effect.Effect<infer B, unknown, unknown>
		? B
		: never)["methods"];

	beforeAll(async () => {
		const built = await Effect.runPromise(customStore.build.pipe(Effect.provide(deps)));
		methods = built.methods;
	});

	const admin = <A, E>(eff: Effect.Effect<A, E>) =>
		Effect.runPromise(eff.pipe(Effect.provideService(Principal, ADMIN)));

	it("writes.create/update run behind the admin gate with plugin contracts", async () => {
		const doc = await admin(methods.adminCreate({ label: "  contraption  " }));
		expect(doc).toMatchObject({ name: "contraption", payload: "{}" });
		const blank = await admin(methods.adminCreate({ label: "   " }));
		expect(blank).toMatchObject({ name: "unlabeled" });
		const updated = await admin(methods.adminUpdate(doc!.id, { note: "hi" }));
		expect(updated).toMatchObject({ name: "contraption", description: "hi" });
		await expect(admin(methods.adminUpdate(9999, {}))).rejects.toBeInstanceOf(GadgetMissing);
		// The injected not-found class is what generated adminRemove throws.
		await admin(methods.adminRemove(doc!.id));
		await expect(admin(methods.adminRemove(doc!.id))).rejects.toBeInstanceOf(GadgetMissing);
	});

	it("orderBy drives adminList ordering", async () => {
		await admin(methods.adminCreate({ label: "zeta" }));
		await admin(methods.adminCreate({ label: "alpha" }));
		const list = await admin(methods.adminList());
		const names = list.map((m) => m.name);
		expect(names.indexOf("alpha")).toBeLessThan(names.indexOf("zeta"));
	});

	it("custom writes are Forbidden for non-admins", async () => {
		await expect(
			Effect.runPromise(methods.adminCreate({}).pipe(Effect.provideService(Principal, USER))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});
});

describe("orHandled / isHandledError", () => {
	const tags = ["Forbidden", "WidgetNotFound"] as const;

	it("collapses handled tags to the fallback", () => {
		const catchFn = orHandled(tags, null);
		expect(catchFn({ _tag: "WidgetNotFound" })).toBeNull();
		expect(isHandledError(new Error("x"), tags)).toBe(false);
		expect(isHandledError("Forbidden", tags)).toBe(false);
		expect(isHandledError(null, tags)).toBe(false);
	});

	it("rethrows unhandled failures", () => {
		const catchFn = orHandled(tags, null);
		const boom = new Error("boom");
		expect(() => catchFn(boom)).toThrow(boom);
		const other = Object.assign(new Error("other"), { _tag: "SomethingElse" });
		expect(() => catchFn(other)).toThrow("other");
	});
});
