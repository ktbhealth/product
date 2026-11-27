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
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformAdminPlugin,
	platformPanelPlugin,
	platformRoutesPlugin,
} from "@ktb/platform";
import {
	makePluginStatesLive,
	PluginStates,
	type PluginStatesShape,
} from "@ktb/platform/plugin-states";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { deleteImageFn, imageUsageFn, listImagesFn, updateImageFn } from "./fns.ts";
import { images } from "./schema.ts";
import { ImageDeleteHooks, ImageDeleteHooksLive } from "./delete-hooks.ts";
import { plugins } from "./index.ts";
import { Images, ImagesLive, IMAGES_TEST_DDL } from "./service.ts";

const PLUGIN_STATE_DDL = `
CREATE TABLE plugin_state (
	plugin_id TEXT PRIMARY KEY NOT NULL,
	enabled INTEGER DEFAULT true NOT NULL,
	config TEXT,
	updated_at INTEGER NOT NULL
);
`;

// The image plugins depend on the platform markers — the test
// registry includes them so dep edges and PluginStates resolve like the
// host.
const registry = [platformAdminPlugin, platformRoutesPlugin, platformPanelPlugin, ...plugins];

const insertImage = (db: ReturnType<typeof makeDb>, over: Record<string, unknown> = {}) =>
	db.insert(images).values({
		title: "Pic",
		alt: "alt",
		mime: "image/png",
		size: 10,
		storageKey: "images/pic.png",
		createdAt: new Date(),
		...over,
	} as never);

describe("image fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let db: ReturnType<typeof makeDb>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));
	// In-memory bucket double — deleteImageFn's best-effort object
	// cleanup resolves through ServerRuntime.images.
	const deletedKeys: string[] = [];
	const fakeBucket = {
		head: async () => null,
		get: async () => null,
		put: async () => ({}),
		delete: async (keys: string[]) => {
			deletedKeys.push(...keys);
		},
	};

	beforeAll(async () => {
		db = makeDb(makeD1(IMAGES_TEST_DDL + PLUGIN_STATE_DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const states = makePluginStatesLive(registry);
		const imagesLive = ImagesLive.pipe(Layer.provide(env));
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				states.pipe(Layer.provide(env)),
				imagesLive,
				ImageDeleteHooksLive,
				env,
			) as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(runtime, auth, { images: fakeBucket });
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous admin callers", async () => {
		currentEmail = null;
		await expect(listImagesFn()).rejects.toThrow("unauthenticated");
		await expect(updateImageFn({ data: { id: 1, title: "x" } })).rejects.toThrow("unauthenticated");
		await expect(deleteImageFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(imageUsageFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
	});

	it("rejects admin fns when the plugin package is disabled", async () => {
		currentEmail = "admin@x.com";
		installServerFnRuntime(runtime, auth, {
			images: fakeBucket,
			pluginEnabled: async () => false,
		});
		try {
			await expect(listImagesFn()).rejects.toThrow('plugin "image.panel" is disabled');
			await expect(updateImageFn({ data: { id: 1, title: "x" } })).rejects.toThrow(
				'plugin "image.panel" is disabled',
			);
			await expect(deleteImageFn({ data: { id: 1 } })).rejects.toThrow(
				'plugin "image.panel" is disabled',
			);
			await expect(imageUsageFn({ data: { id: 1 } })).rejects.toThrow(
				'plugin "image.panel" is disabled',
			);
		} finally {
			installServerFnRuntime(runtime, auth, { images: fakeBucket });
		}
	});

	it("denies non-admin principals", async () => {
		currentEmail = "doc@x.com";
		await expect(listImagesFn()).resolves.toEqual([]);
		await expect(updateImageFn({ data: { id: 1, title: "x" } })).resolves.toBeNull();
		await expect(deleteImageFn({ data: { id: 1 } })).resolves.toBe(false);
		await expect(imageUsageFn({ data: { id: 1 } })).resolves.toEqual([]);
	});

	it("lists, updates, reports usage and deletes as admin", async () => {
		currentEmail = "admin@x.com";
		const rows = await insertImage(db, { title: "Pic", alt: "alt text" }).returning();
		const created = rows[0]!;

		const list = await listImagesFn();
		const meta = list.find((row) => row.id === created.id);
		expect(meta).toMatchObject({
			id: created.id,
			title: "Pic",
			alt: "alt text",
			mime: "image/png",
			src: `/api/images/${created.id}`,
		});
		expect(typeof meta!.createdAt).toBe("string");

		const updated = await updateImageFn({
			data: { id: created.id, title: "New title", alt: "new alt" },
		});
		expect(updated).toMatchObject({ id: created.id, title: "New title", alt: "new alt" });
		await expect(updateImageFn({ data: { id: 999, title: "ghost" } })).resolves.toBeNull();
		// Overlong title → InvalidImageInput → handled → null.
		await expect(
			updateImageFn({ data: { id: created.id, title: "x".repeat(201) } }),
		).resolves.toBeNull();

		expect(await imageUsageFn({ data: { id: created.id } })).toEqual([]);
		deletedKeys.length = 0;
		expect(await deleteImageFn({ data: { id: created.id } })).toBe(true);
		// Row gone + best-effort object cleanup ran.
		expect(deletedKeys).toEqual(["images/pic.png"]);
		expect(await deleteImageFn({ data: { id: created.id } })).toBe(false);
		expect(await listImagesFn()).toHaveLength(list.length - 1);
	});

	it("runs referencer cleanup before deleting when actionId is present", async () => {
		currentEmail = "admin@x.com";
		const rows = await insertImage(db, { storageKey: "images/hooked.png" }).returning();
		const created = rows[0]!;
		const seen: string[] = [];
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* ImageDeleteHooks;
				yield* hooks.register({
					id: "builder",
					usage: () => Effect.succeed([{ id: 1, title: "block" }]),
					cleanup: (_imageId, actionId) => Effect.sync(() => seen.push(actionId)),
				});
			}),
		);
		// Usage now reports the registered owner.
		expect(await imageUsageFn({ data: { id: created.id } })).toEqual([
			{ id: "builder", items: [{ id: 1, title: "block" }] },
		]);
		deletedKeys.length = 0;
		expect(await deleteImageFn({ data: { id: created.id, actionId: "builder.unlink" } })).toBe(
			true,
		);
		expect(seen).toEqual(["builder.unlink"]);
		expect(deletedKeys).toEqual(["images/hooked.png"]);
	});

	it("still returns true when the best-effort object delete fails", async () => {
		currentEmail = "admin@x.com";
		const rows = await insertImage(db, { storageKey: "images/stuck.png" }).returning();
		const created = rows[0]!;
		const failingBucket = {
			head: async () => null,
			get: async () => null,
			put: async () => ({}),
			delete: async () => {
				throw new Error("bucket down");
			},
		};
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		installServerFnRuntime(runtime, auth, { images: failingBucket });
		try {
			expect(await deleteImageFn({ data: { id: created.id } })).toBe(true);
			expect(spy).toHaveBeenCalledWith(
				"image object delete failed",
				expect.objectContaining({ storageKey: "images/stuck.png" }),
			);
		} finally {
			spy.mockRestore();
			installServerFnRuntime(runtime, auth, { images: fakeBucket });
		}
	});

	it("skips object cleanup entirely when no bucket is bound", async () => {
		currentEmail = "admin@x.com";
		const rows = await insertImage(db, { storageKey: "images/nobucket.png" }).returning();
		const created = rows[0]!;
		installServerFnRuntime(runtime, auth, { images: undefined });
		try {
			expect(await deleteImageFn({ data: { id: created.id } })).toBe(true);
		} finally {
			installServerFnRuntime(runtime, auth, { images: fakeBucket });
		}
	});

	it("validates wire input before the handler runs", async () => {
		currentEmail = "admin@x.com";
		await expect(updateImageFn({ data: { title: "x" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(deleteImageFn({ data: { id: "1" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(imageUsageFn({ data: { id: "1" } } as never)).rejects.toBeInstanceOf(Error);
	});

	it("propagates unexpected service errors instead of mapping them", async () => {
		const stubImages = Images.of({
			adminList: () => Effect.fail({ _tag: "Other" }),
			adminGet: () => Effect.fail({ _tag: "Other" }),
			adminCreate: () => Effect.fail({ _tag: "Other" }),
			adminUpdate: () => Effect.fail({ _tag: "Other" }),
			adminRemove: () => Effect.fail({ _tag: "Other" }),
			getById: () => Effect.fail({ _tag: "Other" }),
		} as unknown as Images["Service"]);
		const stubHooks = ImageDeleteHooks.of({
			register: () => Effect.void,
			usage: () => Effect.fail({ _tag: "Other" }),
			cleanup: () => Effect.fail({ _tag: "Other" }),
		});
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(PluginStates, {
					isEnabled: () => Effect.succeed(true),
					enabledIds: () => Effect.succeed(new Set<string>()),
					config: () => Effect.succeed({}),
					setEnabled: () => Effect.void,
					setConfig: () => Effect.void,
					entries: () => Effect.succeed([]),
				} as unknown as PluginStatesShape),
				Layer.succeed(Images, stubImages),
				Layer.succeed(ImageDeleteHooks, stubHooks),
			) as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(rt, auth, { images: fakeBucket });
		currentEmail = "admin@x.com";
		try {
			await expect(listImagesFn()).rejects.toMatchObject({ _tag: "Other" });
			await expect(updateImageFn({ data: { id: 1, title: "x" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(deleteImageFn({ data: { id: 1 } })).rejects.toMatchObject({ _tag: "Other" });
			await expect(imageUsageFn({ data: { id: 1 } })).rejects.toMatchObject({ _tag: "Other" });
		} finally {
			installServerFnRuntime(runtime, auth, { images: fakeBucket });
			await rt.dispose();
		}
	});
});
