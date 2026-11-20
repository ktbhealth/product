import { describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Layouts } from "@ktb/layouts/service";
import { Pages } from "@ktb/pages/service";
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

import { plugins, siteBuilderPanelPlugin } from "./index.ts";

const ADMIN = { userId: "a1", email: "admin@x.com" };
const NON_ADMIN = { userId: "u1", email: "doc@x.com" };

const pageRow = {
	id: 7,
	path: "/about",
	title: "About",
	richTextId: null,
	searchSchemaId: null,
	layoutId: null,
	builderJson: '{"version":1,"data":{"content":[]}}',
	published: true,
	showInNav: false,
	sortOrder: 0,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const layoutDoc = {
	id: 3,
	name: "Landing",
	description: "Landing body",
	sectionCount: 2,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	config: '{"sections":[]}',
	builderJson: null,
};

/** Partial Pages/Layouts stubs — the editor paths only touch
 * `adminGet`; cast keeps the test focused on the plugin's own logic. */
const pagesStub = (adminGet: (id: number) => Effect.Effect<unknown>) => ({ adminGet }) as never;
const layoutsStub = (adminGet: (id: number) => Effect.Effect<unknown>) => ({ adminGet }) as never;

// `never` service set is the top of the contravariant Layer R —
// every concrete stub layer is assignable to it.
const makeRuntime = (services: Layer.Layer<never, never, never>) =>
	ManagedRuntime.make(
		Layer.mergeAll(
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			services as Layer.Layer<unknown, never, never>,
		) as Layer.Layer<unknown, never, never>,
	);

const runAs = <A, E>(
	rt: ManagedRuntime.ManagedRuntime<unknown, never>,
	principal: { userId: string; email?: string } | null,
	effect: Effect.Effect<A, E, unknown>,
) =>
	rt.runPromise(Effect.provideService(effect, Principal, principal) as Effect.Effect<A, E, never>);

const pageDescriptor = () => siteBuilderPanelPlugin.panel!.pages![0]!;
const layoutDescriptor = () => siteBuilderPanelPlugin.panel!.pages![1]!;

describe("site-builder plugins", () => {
	it("exposes the single panel plugin with platform + optional service deps", () => {
		expect(plugins.map((p) => p.id)).toEqual(["site-builder.panel"]);
		expect(siteBuilderPanelPlugin.requiredDeps).toEqual([platformPanelPlugin.id]);
		expect(siteBuilderPanelPlugin.optionalDeps).toEqual(["pages.services", "layouts.services"]);
	});

	it("declares typed route keys for both edit paths", () => {
		const routes = siteBuilderPanelPlugin.contributions ?? [];
		const defs = routes.filter((c) => c.kind === "route").map((c) => ({ id: c.id, meta: c.meta }));
		expect(defs).toEqual([
			{
				id: "site-builder.page.edit",
				meta: { path: "/platform/pages/:id/edit", params: ["id"], portal: "platform" },
			},
			{
				id: "site-builder.layout.edit",
				meta: { path: "/platform/layouts/:id/edit", params: ["id"], portal: "platform" },
			},
		]);
	});

	it("registers wildcard panel pages for both consoles", () => {
		const pages = siteBuilderPanelPlugin.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/pages/*", "/platform/layouts/*"]);
		expect(pages.every((p) => p.guard !== undefined && p.loader !== undefined)).toBe(true);
	});
});

describe("editor guard", () => {
	it("404s non-edit paths before touching services", async () => {
		const rt = makeRuntime(Layer.empty);
		try {
			for (const path of [
				"/platform/pages",
				"/platform/pages/abc/edit",
				"/platform/pages/1",
				"/platform/pages/1/edit/extra",
				"/platform/layouts/x/edit",
				"/platform/other/1/edit",
			]) {
				await expect(runAs(rt, ADMIN, pageDescriptor().guard!(path))).resolves.toBe(false);
			}
		} finally {
			await rt.dispose();
		}
	});

	it("denies non-admin principals", async () => {
		const rt = makeRuntime(
			Layer.mergeAll(
				Layer.succeed(
					Pages,
					pagesStub(() => Effect.succeed(pageRow)),
				),
				Layer.succeed(
					Layouts,
					layoutsStub(() => Effect.succeed(layoutDoc)),
				),
			),
		);
		try {
			await expect(
				runAs(rt, NON_ADMIN, pageDescriptor().guard!("/platform/pages/7/edit")),
			).resolves.toBe(false);
			await expect(
				runAs(rt, null, layoutDescriptor().guard!("/platform/layouts/3/edit")),
			).resolves.toBe(false);
		} finally {
			await rt.dispose();
		}
	});

	it("admits admins when the target entity exists", async () => {
		const rt = makeRuntime(
			Layer.mergeAll(
				Layer.succeed(
					Pages,
					pagesStub(() => Effect.succeed(pageRow)),
				),
				Layer.succeed(
					Layouts,
					layoutsStub(() => Effect.succeed(layoutDoc)),
				),
			),
		);
		try {
			await expect(
				runAs(rt, ADMIN, pageDescriptor().guard!("/platform/pages/7/edit")),
			).resolves.toBe(true);
			await expect(
				runAs(rt, ADMIN, layoutDescriptor().guard!("/platform/layouts/3/edit")),
			).resolves.toBe(true);
			// Trailing slash tolerated.
			await expect(
				runAs(rt, ADMIN, pageDescriptor().guard!("/platform/pages/7/edit/")),
			).resolves.toBe(true);
		} finally {
			await rt.dispose();
		}
	});

	it("denies when the entity is missing or the service is absent", async () => {
		const rt = makeRuntime(
			Layer.mergeAll(
				Layer.succeed(
					Pages,
					pagesStub(() => Effect.succeed(null)),
				),
				// No Layouts layer at all → serviceOption degrades to None.
			),
		);
		try {
			await expect(
				runAs(rt, ADMIN, pageDescriptor().guard!("/platform/pages/7/edit")),
			).resolves.toBe(false);
			await expect(
				runAs(rt, ADMIN, layoutDescriptor().guard!("/platform/layouts/3/edit")),
			).resolves.toBe(false);
		} finally {
			await rt.dispose();
		}
	});
});

describe("editor loader", () => {
	it("returns null for non-edit paths and absent services", async () => {
		const rt = makeRuntime(Layer.empty);
		try {
			await expect(
				runAs(rt, ADMIN, pageDescriptor().loader!("/platform/pages")),
			).resolves.toBeNull();
			await expect(
				runAs(rt, ADMIN, layoutDescriptor().loader!("/platform/layouts/3/edit")),
			).resolves.toBeNull();
		} finally {
			await rt.dispose();
		}
	});

	it("loads the page's builder document wire shape", async () => {
		const rt = makeRuntime(
			Layer.succeed(
				Pages,
				pagesStub(() => Effect.succeed(pageRow)),
			),
		);
		try {
			const data = await runAs(rt, ADMIN, pageDescriptor().loader!("/platform/pages/7/edit"));
			expect(data).toEqual({
				kind: "page",
				id: 7,
				title: "About",
				subtitle: "/about",
				builderJson: pageRow.builderJson,
			});
		} finally {
			await rt.dispose();
		}
	});

	it("loads the layout's builder document wire shape", async () => {
		const rt = makeRuntime(
			Layer.succeed(
				Layouts,
				layoutsStub(() => Effect.succeed(layoutDoc)),
			),
		);
		try {
			const data = await runAs(rt, ADMIN, layoutDescriptor().loader!("/platform/layouts/3/edit"));
			expect(data).toEqual({
				kind: "layout",
				id: 3,
				title: "Landing",
				subtitle: "Landing body",
				builderJson: null,
			});
		} finally {
			await rt.dispose();
		}
	});

	it("returns null when the entity row is missing", async () => {
		const rt = makeRuntime(
			Layer.succeed(
				Pages,
				pagesStub(() => Effect.succeed(null)),
			),
		);
		try {
			await expect(
				runAs(rt, ADMIN, pageDescriptor().loader!("/platform/pages/7/edit")),
			).resolves.toBeNull();
		} finally {
			await rt.dispose();
		}
	});
});
