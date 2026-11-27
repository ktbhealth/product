import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { Principal } from "@ktb/authz";
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformAdminPlugin,
	platformPanelPlugin,
} from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	plugins,
	imageChromePlugin,
	imageElementsPlugin,
	imagePanelPlugin,
	imageServicesPlugin,
	imageTablesPlugin,
} from "./index.ts";
import { ImageDeleteHooksLive } from "./delete-hooks.ts";
import { images } from "./schema.ts";
import { ImagesLive } from "./service.ts";

describe("image plugins", () => {
	it("exposes the six single-concern plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"image.tables",
			"image.services",
			"image.chrome",
			"image.panel",
			"image.elements",
			"image.routes",
		]);
		expect(imageTablesPlugin.tables?.images).toBeDefined();
		expect(imageServicesPlugin.services).toBeDefined();
		expect(imageServicesPlugin.requiredDeps).toEqual([platformAdminPlugin.id]);
		expect(imagePanelPlugin.requiredDeps).toEqual([platformPanelPlugin.id, imageServicesPlugin.id]);
	});

	it("declares the media library sidebar entry in the Site group", () => {
		const chrome = imageChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(1);
		const sidebar = chrome[0];
		expect(sidebar?.id).toBe("image.sidebar");
		expect(sidebar?.region).toBe("portal.sidebar");
		expect(sidebar?.content.kind).toBe("sidebarItem");
		const item =
			sidebar?.content.kind === "sidebarItem"
				? sidebar.content.item
				: ({ to: "", group: "" } as { to: string; group: string });
		expect(item.to).toBe("/platform/images");
		expect(item.group).toBe("Site");
	});

	it("declares the image element kind with renderer and editor (P-111)", () => {
		const kinds = imageElementsPlugin.elementKinds ?? [];
		expect(kinds).toHaveLength(1);
		const kind = kinds[0]!;
		expect(kind.kind).toBe("image");
		expect(kind.label).toBe("Image");
		expect(kind.renderer).toBeTypeOf("function");
		expect(kind.editor).toBeTypeOf("function");
		expect(kind.icon).toBeDefined();
	});

	it("declares the admin console page with guard and loader", () => {
		const admin = imagePanelPlugin.panel?.pages?.[0];
		expect(admin?.id).toBe("image.admin");
		expect(admin?.path).toBe("/platform/images");
		expect(admin?.guard).toBeTypeOf("function");
		expect(admin?.loader).toBeTypeOf("function");
	});
});

describe("image page effects", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;

	const asPrincipal = <A, E>(
		principal: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, principal) as Effect.Effect<A, E, never>,
		);

	beforeAll(async () => {
		const db = makeDb(makeTestD1());
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		// Merge `deps` into the runtime too: the admin page guard yields
		// PlatformAdmin directly, not just through Images.
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				ImagesLive.pipe(Layer.provide(deps)),
				ImageDeleteHooksLive,
				deps,
			) as Layer.Layer<unknown, never, never>,
		);
		await db.insert(images).values({
			title: "Pic",
			alt: "alt",
			mime: "image/png",
			size: 10,
			storageKey: "images/pic.png",
			createdAt: new Date(),
		});
	});

	afterAll(() => runtime.dispose());

	it("admin page guard allows admins and denies everyone else", async () => {
		const guard = imagePanelPlugin.panel!.pages![0]!.guard!;
		await expect(
			asPrincipal({ userId: "a1", email: "admin@x.com" }, guard("/platform/images")),
		).resolves.toBe(true);
		await expect(
			asPrincipal({ userId: "u1", email: "doc@x.com" }, guard("/platform/images")),
		).resolves.toBe(false);
		await expect(asPrincipal(null, guard("/platform/images"))).resolves.toBe(false);
	});

	it("admin page loader lists metas for admins and empties for others", async () => {
		const loader = imagePanelPlugin.panel!.pages![0]!.loader!;
		const rows = (await asPrincipal(
			{ userId: "a1", email: "admin@x.com" },
			loader("/platform/images"),
		)) as readonly { id: number; title: string; src: string; createdAt: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ title: "Pic", src: expect.stringMatching(/^\/api\/images\//) });
		expect(typeof rows[0]!.createdAt).toBe("string");
		const denied = (await asPrincipal(
			{ userId: "u1", email: "doc@x.com" },
			loader("/platform/images"),
		)) as readonly unknown[];
		expect(denied).toEqual([]);
	});
});
