import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { Principal } from "@ktb/authz";
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformAdminPlugin,
} from "@ktb/platform";
import { richTextServicesPlugin } from "@ktb/rich-text";
import { templatesServicesPlugin } from "@ktb/templates";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	layoutsChromePlugin,
	layoutsPanelPlugin,
	layoutsServicesPlugin,
	layoutsTablesPlugin,
	plugins,
} from "./index.ts";
import { layouts } from "./schema.ts";
import { LayoutsLive } from "./service.ts";

describe("layouts plugins", () => {
	it("exposes the four single-concern plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"layouts.tables",
			"layouts.services",
			"layouts.chrome",
			"layouts.panel",
		]);
		expect(layoutsTablesPlugin.tables?.layouts).toBeDefined();
		expect(layoutsServicesPlugin.services).toBeDefined();
		expect(layoutsServicesPlugin.requiredDeps).toEqual([platformAdminPlugin.id]);
		// Slots resolve through @ktb/rich-text and the delete-hook
		// registry lives in its service layer — optional, never a hard
		// dep. Same contract for the "layout" template kind registered
		// into TemplateKinds.
		expect(layoutsServicesPlugin.optionalDeps).toEqual([
			richTextServicesPlugin.id,
			templatesServicesPlugin.id,
		]);
	});

	it("declares the console sidebar entry and the delete dialog actions", () => {
		const chrome = layoutsChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(3);
		const sidebar = chrome.find((c) => c.id === "layouts.sidebar");
		expect(sidebar?.region).toBe("portal.sidebar");
		expect(sidebar?.content.kind).toBe("sidebarItem");
		const item =
			sidebar?.content.kind === "sidebarItem"
				? sidebar.content.item
				: ({ to: "", group: "" } as { to: string; group: string });
		expect(item.to).toBe("/platform/layouts");
		expect(item.group).toBe("Site");

		// The rich-text delete dialog collects these from the
		// "rich-text.delete.actions" region — ids/owner are the hook
		// contract, keep them exact.
		const actions = chrome
			.filter((c) => c.region === "rich-text.delete.actions")
			.map((c) => (c.content.kind === "dialogAction" ? c.content.action : null));
		expect(actions).toEqual([
			{
				id: "layouts.unlink-slots",
				owner: "layouts",
				label: "Empty layout slots",
				description: "Layouts keep their settings but the slots using this document render empty.",
				destructive: false,
			},
			{
				id: "layouts.delete-layouts",
				owner: "layouts",
				label: "Delete layouts too",
				description: "Permanently deletes every layout using this document.",
				destructive: true,
			},
		]);
	});

	it("declares the admin console page with guard and loader", () => {
		expect(layoutsPanelPlugin.requiredDeps).toEqual(["platform.panel", "layouts.services"]);
		const admin = layoutsPanelPlugin.panel?.pages?.[0];
		expect(admin?.id).toBe("layouts.admin");
		expect(admin?.path).toBe("/platform/layouts");
		expect(admin?.guard).toBeTypeOf("function");
		expect(admin?.loader).toBeTypeOf("function");
	});
});

describe("layouts page effects", () => {
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
		// PlatformAdmin directly, not just through Layouts.
		runtime = ManagedRuntime.make(
			Layer.mergeAll(LayoutsLive.pipe(Layer.provide(deps)), deps) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		const now = new Date();
		await db.insert(layouts).values([
			{
				name: "landing",
				description: "Landing body",
				config: JSON.stringify({
					sections: [{ id: "s1", title: "Hero", kind: "rich-text", refId: 1 }],
				}),
				createdAt: now,
				updatedAt: now,
			},
		]);
	});

	afterAll(() => runtime.dispose());

	it("admin page guard allows admins and denies everyone else", async () => {
		const guard = layoutsPanelPlugin.panel!.pages![0]!.guard!;
		await expect(
			asPrincipal({ userId: "a1", email: "admin@x.com" }, guard("/platform/layouts")),
		).resolves.toBe(true);
		await expect(
			asPrincipal({ userId: "u1", email: "doc@x.com" }, guard("/platform/layouts")),
		).resolves.toBe(false);
		await expect(asPrincipal(null, guard("/platform/layouts"))).resolves.toBe(false);
	});

	it("admin page loader lists metas for admins and empties for others", async () => {
		const loader = layoutsPanelPlugin.panel!.pages![0]!.loader!;
		const rows = (await asPrincipal(
			{ userId: "a1", email: "admin@x.com" },
			loader("/platform/layouts"),
		)) as readonly {
			id: number;
			name: string;
			description: string | null;
			sectionCount: number;
			updatedAt: string;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			name: "landing",
			description: "Landing body",
			sectionCount: 1,
		});
		expect(typeof rows[0]!.updatedAt).toBe("string");
		const denied = (await asPrincipal(
			{ userId: "u1", email: "doc@x.com" },
			loader("/platform/layouts"),
		)) as readonly unknown[];
		expect(denied).toEqual([]);
	});
});
