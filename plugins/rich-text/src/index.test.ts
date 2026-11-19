import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Principal } from "@ktb/authz";
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformAdminPlugin,
} from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	plugins,
	richTextChromePlugin,
	richTextPanelPlugin,
	richTextServicesPlugin,
	richTextTablesPlugin,
} from "./index.ts";
import { richText } from "./schema.ts";
import { RichTextsLive, RICH_TEXT_TEST_DDL } from "./service.ts";

describe("rich-text plugins", () => {
	it("exposes the four single-concern plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"rich-text.tables",
			"rich-text.services",
			"rich-text.chrome",
			"rich-text.panel",
		]);
		expect(richTextTablesPlugin.tables?.richText).toBeDefined();
		expect(richTextServicesPlugin.services).toBeDefined();
		expect(richTextServicesPlugin.requiredDeps).toEqual([platformAdminPlugin.id]);
	});

	it("declares the console sidebar entry in the Content group", () => {
		const chrome = richTextChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(1);
		const sidebar = chrome[0];
		expect(sidebar?.id).toBe("rich-text.sidebar");
		expect(sidebar?.region).toBe("portal.sidebar");
		expect(sidebar?.content.kind).toBe("sidebarItem");
		const item =
			sidebar?.content.kind === "sidebarItem"
				? sidebar.content.item
				: ({ to: "", group: "" } as { to: string; group: string });
		expect(item.to).toBe("/platform/rich-text");
		expect(item.group).toBe("Site");
	});

	it("declares the admin console page with guard and loader", () => {
		expect(richTextPanelPlugin.requiredDeps).toEqual(["platform.panel", "rich-text.services"]);
		const admin = richTextPanelPlugin.panel?.pages?.[0];
		expect(admin?.id).toBe("rich-text.admin");
		expect(admin?.path).toBe("/platform/rich-text");
		expect(admin?.guard).toBeTypeOf("function");
		expect(admin?.loader).toBeTypeOf("function");
	});
});

describe("rich-text page effects", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;

	const asPrincipal = <A, E>(
		principal: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, principal) as Effect.Effect<A, E, never>,
		);

	beforeAll(async () => {
		const db = makeDb(makeD1(RICH_TEXT_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		// Merge `deps` into the runtime too: the admin page guard yields
		// PlatformAdmin directly, not just through RichTexts.
		runtime = ManagedRuntime.make(
			Layer.mergeAll(RichTextsLive.pipe(Layer.provide(deps)), deps) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		const now = new Date();
		await db.insert(richText).values([
			{
				title: "Doc",
				value: JSON.stringify([{ type: "p", children: [{ text: "body" }] }]),
				createdAt: now,
				updatedAt: now,
			},
		]);
	});

	afterAll(() => runtime.dispose());

	it("admin page guard allows admins and denies everyone else", async () => {
		const guard = richTextPanelPlugin.panel!.pages![0]!.guard!;
		await expect(
			asPrincipal({ userId: "a1", email: "admin@x.com" }, guard("/platform/rich-text")),
		).resolves.toBe(true);
		await expect(
			asPrincipal({ userId: "u1", email: "doc@x.com" }, guard("/platform/rich-text")),
		).resolves.toBe(false);
		await expect(asPrincipal(null, guard("/platform/rich-text"))).resolves.toBe(false);
	});

	it("admin page loader lists metas for admins and empties for others", async () => {
		const loader = richTextPanelPlugin.panel!.pages![0]!.loader!;
		const rows = (await asPrincipal(
			{ userId: "a1", email: "admin@x.com" },
			loader("/platform/rich-text"),
		)) as readonly { id: number; title: string; updatedAt: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ title: "Doc" });
		expect(typeof rows[0]!.updatedAt).toBe("string");
		const denied = (await asPrincipal(
			{ userId: "u1", email: "doc@x.com" },
			loader("/platform/rich-text"),
		)) as readonly unknown[];
		expect(denied).toEqual([]);
	});
});
