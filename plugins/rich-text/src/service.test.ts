import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type SqlDatabase, type SqlStatement } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	InvalidRichTextValue,
	RichTexts,
	RichTextsLive,
	RichTextNotFound,
	RICH_TEXT_TEST_DDL,
} from "./service.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RichTextsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<RichTexts, never>;

	beforeAll(() => {
		const db = makeDb(makeD1(RICH_TEXT_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(RichTextsLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, RichTexts>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (p: RichTexts["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(RichTexts, f);

	const admin = <A, E>(f: (p: RichTexts["Service"]) => Effect.Effect<A, E>) =>
		asUser("admin-1", call(f), "admin@x.com");

	it("adminCreate seeds an Untitled doc with the canonical empty value", async () => {
		const doc = await admin((p) => p.adminCreate({}));
		expect(doc).not.toBeNull();
		expect(doc!.title).toBe("Untitled");
		expect(doc!.content).toEqual([{ type: "p", children: [{ text: "" }] }]);
		expect(doc!.createdAt).toBeInstanceOf(Date);
		expect(doc!.updatedAt).toBeInstanceOf(Date);
	});

	it("adminCreate honors a trimmed custom title and defaults blank to Untitled", async () => {
		const named = await admin((p) => p.adminCreate({ title: "  Notes  " }));
		expect(named!.title).toBe("Notes");
		const blank = await admin((p) => p.adminCreate({ title: "   " }));
		expect(blank!.title).toBe("Untitled");
	});

	it("adminList returns metas ordered by updatedAt desc (no content)", async () => {
		const first = await admin((p) => p.adminCreate({ title: "first" }));
		await sleep(5);
		const second = await admin((p) => p.adminCreate({ title: "second" }));
		const rows = await admin((p) => p.adminList());
		expect(rows.map((r) => r.id)).toContain(first!.id);
		expect(rows.map((r) => r.id)).toContain(second!.id);
		// Most recently updated first.
		expect(rows.findIndex((r) => r.id === second!.id)).toBeLessThan(
			rows.findIndex((r) => r.id === first!.id),
		);
		// Meta only — the value payload never leaves the service layer.
		expect(rows[0]).not.toHaveProperty("content");
		expect(rows[0]).not.toHaveProperty("value");
	});

	it("adminGet returns the parsed content; missing ids resolve null", async () => {
		const created = await admin((p) => p.adminCreate({ title: "get me" }));
		const doc = await admin((p) => p.adminGet(created!.id));
		expect(doc).toMatchObject({ id: created!.id, title: "get me" });
		expect(doc!.content).toEqual([{ type: "p", children: [{ text: "" }] }]);
		await expect(admin((p) => p.adminGet(9999))).resolves.toBeNull();
	});

	it("adminUpdate patches title and/or value and bumps updatedAt", async () => {
		const created = await admin((p) => p.adminCreate({ title: "before" }));
		const value = JSON.stringify([{ type: "h2", children: [{ text: "Hi" }] }]);
		const updated = await admin((p) => p.adminUpdate(created!.id, { title: "after", value }));
		expect(updated.id).toBe(created!.id);
		expect(updated.title).toBe("after");
		expect(updated.content).toEqual([{ type: "h2", children: [{ text: "Hi" }] }]);
		expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());

		// Title-only update keeps the stored value.
		const retitled = await admin((p) => p.adminUpdate(created!.id, { title: "again" }));
		expect(retitled.title).toBe("again");
		expect(retitled.content).toEqual([{ type: "h2", children: [{ text: "Hi" }] }]);

		// Value-only update keeps the title.
		const newValue = JSON.stringify([{ type: "p", children: [{ text: "new" }] }]);
		const revalued = await admin((p) => p.adminUpdate(created!.id, { value: newValue }));
		expect(revalued.title).toBe("again");
		expect(revalued.content).toEqual([{ type: "p", children: [{ text: "new" }] }]);
	});

	it("adminUpdate rejects malformed values and missing rows", async () => {
		const created = await admin((p) => p.adminCreate({}));
		for (const bad of ["not json", "{}", "[]", '"x"']) {
			await expect(admin((p) => p.adminUpdate(created!.id, { value: bad }))).rejects.toBeInstanceOf(
				InvalidRichTextValue,
			);
		}
		await expect(admin((p) => p.adminUpdate(9999, { title: "ghost" }))).rejects.toBeInstanceOf(
			RichTextNotFound,
		);
	});

	it("adminRemove deletes and reports missing rows", async () => {
		const row = await admin((p) => p.adminCreate({ title: "doomed" }));
		await admin((p) => p.adminRemove(row!.id));
		await expect(admin((p) => p.adminRemove(row!.id))).rejects.toBeInstanceOf(RichTextNotFound);
	});

	it("admin methods are Forbidden for non-admins and anonymous callers", async () => {
		await expect(
			asUser(
				"u1",
				call((p) => p.adminList()),
				"doc@x.com",
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				null,
				call((p) => p.adminList()),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				"u1",
				call((p) => p.adminGet(1)),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u1",
				call((p) => p.adminCreate({})),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u1",
				call((p) => p.adminUpdate(1, {})),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u1",
				call((p) => p.adminRemove(1)),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("getById is a public read returning parsed content", async () => {
		const created = await admin((p) => p.adminCreate({ title: "public" }));
		const doc = await asUser(
			null,
			call((p) => p.getById(created!.id)),
		);
		expect(doc).toMatchObject({ id: created!.id, title: "public" });
		expect(doc!.content).toEqual([{ type: "p", children: [{ text: "" }] }]);
		await expect(
			asUser(
				null,
				call((p) => p.getById(9999)),
			),
		).resolves.toBeNull();
	});

	it("adminCreate resolves null when the insert returning is empty", async () => {
		// A SqlDatabase whose statements always yield zero rows: the
		// INSERT ... RETURNING comes back empty, so adminCreate's
		// `rows[0] ?? null` arm fires.
		const emptyStatement: SqlStatement = {
			bind: () => emptyStatement,
			first: async <T = unknown>() => null as T | null,
			run: async () => ({ success: true, results: [], meta: {} }),
			all: async <T = unknown>() => ({
				success: true,
				results: [] as T[],
				meta: {},
			}),
			raw: async <T = unknown[]>() => [] as unknown as T[],
		};
		const emptySql: SqlDatabase = {
			prepare: () => emptyStatement,
			dump: async () => new ArrayBuffer(0),
			batch: async () => [],
			exec: async () => ({ count: 0, duration: 0 }),
		};
		const deps = Layer.merge(
			Layer.succeed(Db, makeDb(emptySql)),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const rt = ManagedRuntime.make(RichTextsLive.pipe(Layer.provide(deps)));
		try {
			const doc = await rt.runPromise(
				Effect.gen(function* () {
					const richTexts = yield* RichTexts;
					return yield* richTexts.adminCreate({});
				}).pipe(
					Effect.provideService(Principal, {
						userId: "admin-1",
						email: "admin@x.com",
					}),
				),
			);
			expect(doc).toBeNull();
		} finally {
			await rt.dispose();
		}
	});
});
