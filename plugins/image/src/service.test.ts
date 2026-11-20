import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type SqlDatabase, type SqlStatement } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	ImageNotFound,
	Images,
	ImagesLive,
	IMAGES_TEST_DDL,
	InvalidImageInput,
} from "./service.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const meta = (over: Record<string, unknown> = {}) => ({
	mime: "image/png",
	size: 1024,
	storageKey: "images/abc.png",
	...over,
});

describe("ImagesLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Images, never>;

	beforeAll(() => {
		const db = makeDb(makeD1(IMAGES_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(ImagesLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Images>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (p: Images["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Images, f);

	const admin = <A, E>(f: (p: Images["Service"]) => Effect.Effect<A, E>) =>
		asUser("admin-1", call(f), "admin@x.com");

	it("adminCreate records upload metadata with defaults", async () => {
		const image = await admin((p) => p.adminCreate(meta({ title: "  Hero  ", alt: "Hero alt" })));
		expect(image.id).toBeGreaterThan(0);
		expect(image.title).toBe("Hero");
		expect(image.alt).toBe("Hero alt");
		expect(image.mime).toBe("image/png");
		expect(image.size).toBe(1024);
		expect(image.storageKey).toBe("images/abc.png");
		expect(image.width).toBeNull();
		expect(image.height).toBeNull();
		expect(image.createdAt).toBeInstanceOf(Date);
	});

	it("adminCreate defaults title/alt to empty and keeps dimensions", async () => {
		const image = await admin((p) =>
			p.adminCreate(meta({ title: "   ", width: 640, height: 480 })),
		);
		expect(image.title).toBe("");
		expect(image.alt).toBe("");
		expect(image.width).toBe(640);
		expect(image.height).toBe(480);
	});

	it("adminCreate rejects invalid meta", async () => {
		await expect(admin((p) => p.adminCreate(meta({ mime: "" })))).rejects.toBeInstanceOf(
			InvalidImageInput,
		);
		await expect(admin((p) => p.adminCreate(meta({ size: 0 })))).rejects.toBeInstanceOf(
			InvalidImageInput,
		);
		await expect(admin((p) => p.adminCreate(meta({ size: 1.5 })))).rejects.toBeInstanceOf(
			InvalidImageInput,
		);
		await expect(admin((p) => p.adminCreate(meta({ storageKey: "" })))).rejects.toBeInstanceOf(
			InvalidImageInput,
		);
		await expect(
			admin((p) => p.adminCreate(meta({ storageKey: "a/../b" }))),
		).rejects.toBeInstanceOf(InvalidImageInput);
		await expect(
			admin((p) => p.adminCreate(meta({ title: "x".repeat(201) }))),
		).rejects.toBeInstanceOf(InvalidImageInput);
		await expect(
			admin((p) => p.adminCreate(meta({ alt: "x".repeat(501) }))),
		).rejects.toBeInstanceOf(InvalidImageInput);
		await expect(admin((p) => p.adminCreate(meta({ width: 0 })))).rejects.toBeInstanceOf(
			InvalidImageInput,
		);
		await expect(admin((p) => p.adminCreate(meta({ height: -4 })))).rejects.toBeInstanceOf(
			InvalidImageInput,
		);
		await expect(admin((p) => p.adminCreate(meta({ width: 1.5 })))).rejects.toBeInstanceOf(
			InvalidImageInput,
		);
	});

	it("adminList returns rows newest-first", async () => {
		const first = await admin((p) => p.adminCreate(meta({ title: "first" })));
		await sleep(5);
		const second = await admin((p) => p.adminCreate(meta({ title: "second" })));
		const rows = await admin((p) => p.adminList());
		expect(rows.map((r) => r.id)).toContain(first.id);
		expect(rows.map((r) => r.id)).toContain(second.id);
		expect(rows.findIndex((r) => r.id === second.id)).toBeLessThan(
			rows.findIndex((r) => r.id === first.id),
		);
	});

	it("adminGet returns the row; missing ids resolve null", async () => {
		const created = await admin((p) => p.adminCreate(meta({ title: "get me" })));
		const image = await admin((p) => p.adminGet(created.id));
		expect(image).toMatchObject({ id: created.id, title: "get me" });
		await expect(admin((p) => p.adminGet(9999))).resolves.toBeNull();
	});

	it("adminUpdate patches title and/or alt", async () => {
		const created = await admin((p) => p.adminCreate(meta({ title: "before", alt: "a" })));
		const updated = await admin((p) => p.adminUpdate(created.id, { title: "after", alt: "b" }));
		expect(updated).toMatchObject({ id: created.id, title: "after", alt: "b" });
		const retitled = await admin((p) => p.adminUpdate(created.id, { title: "again" }));
		expect(retitled.alt).toBe("b");
		// Alt-only patch leaves title untouched (covers the undefined
		// branch of each normText guard).
		const realted = await admin((p) => p.adminUpdate(created.id, { alt: "c" }));
		expect(realted).toMatchObject({ title: "again", alt: "c" });
		await expect(admin((p) => p.adminUpdate(9999, { title: "ghost" }))).rejects.toBeInstanceOf(
			ImageNotFound,
		);
		await expect(
			admin((p) => p.adminUpdate(created.id, { title: "x".repeat(201) })),
		).rejects.toBeInstanceOf(InvalidImageInput);
	});

	it("adminRemove deletes and reports missing rows", async () => {
		const row = await admin((p) => p.adminCreate(meta()));
		await admin((p) => p.adminRemove(row.id));
		await expect(admin((p) => p.adminRemove(row.id))).rejects.toBeInstanceOf(ImageNotFound);
	});

	it("admin methods are Forbidden for non-admins and anonymous callers", async () => {
		await expect(
			asUser(
				"u1",
				call((p) => p.adminList()),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
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
				call((p) => p.adminCreate(meta())),
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

	it("getById is a public read", async () => {
		const created = await admin((p) => p.adminCreate(meta({ title: "public" })));
		const image = await asUser(
			null,
			call((p) => p.getById(created.id)),
		);
		expect(image).toMatchObject({ id: created.id, title: "public" });
		await expect(
			asUser(
				null,
				call((p) => p.getById(9999)),
			),
		).resolves.toBeNull();
	});

	it("adminCreate surfaces a defect when the insert returns no row", async () => {
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
		const rt = ManagedRuntime.make(ImagesLive.pipe(Layer.provide(deps)));
		try {
			await expect(
				rt.runPromise(
					Effect.gen(function* () {
						const images = yield* Images;
						return yield* images.adminCreate(meta());
					}).pipe(
						Effect.provideService(Principal, {
							userId: "admin-1",
							email: "admin@x.com",
						}),
					),
				),
			).rejects.toBeInstanceOf(InvalidImageInput);
		} finally {
			await rt.dispose();
		}
	});
});
