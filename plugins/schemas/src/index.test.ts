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
	schemasChromePlugin,
	schemasPanelPlugin,
	schemasServicesPlugin,
	schemasTablesPlugin,
} from "./index.ts";
import { schemas } from "./schema.ts";
import { SCHEMAS_TEST_DDL, SchemasLive } from "./service.ts";

describe("schemas plugins", () => {
	it("exposes the four single-concern plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"schemas.tables",
			"schemas.services",
			"schemas.chrome",
			"schemas.panel",
		]);
		expect(schemasTablesPlugin.tables?.schemas).toBeDefined();
		expect(schemasServicesPlugin.services).toBeDefined();
		expect(schemasServicesPlugin.requiredDeps).toEqual([platformAdminPlugin.id]);
	});

	it("declares the console sidebar entry in the Site group", () => {
		const chrome = schemasChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(1);
		const sidebar = chrome[0];
		expect(sidebar?.id).toBe("schemas.sidebar");
		expect(sidebar?.region).toBe("portal.sidebar");
		expect(sidebar?.content.kind).toBe("sidebarItem");
		const item =
			sidebar?.content.kind === "sidebarItem"
				? sidebar.content.item
				: ({ to: "", group: "" } as { to: string; group: string });
		expect(item.to).toBe("/platform/schemas");
		expect(item.group).toBe("Site");
	});

	it("declares the admin console page with guard and loader", () => {
		expect(schemasPanelPlugin.requiredDeps).toEqual(["platform.panel", "schemas.services"]);
		const admin = schemasPanelPlugin.panel?.pages?.[0];
		expect(admin?.id).toBe("schemas.admin");
		expect(admin?.path).toBe("/platform/schemas");
		expect(admin?.guard).toBeTypeOf("function");
		expect(admin?.loader).toBeTypeOf("function");
	});
});

describe("schemas page effects", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;

	const asPrincipal = <A, E>(
		principal: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, principal) as Effect.Effect<A, E, never>,
		);

	beforeAll(async () => {
		const db = makeDb(makeD1(SCHEMAS_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		// Merge `deps` into the runtime too: the admin page guard yields
		// PlatformAdmin directly, not just through Schemas.
		runtime = ManagedRuntime.make(
			Layer.mergeAll(SchemasLive.pipe(Layer.provide(deps)), deps) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		const now = new Date();
		await db.insert(schemas).values([
			{
				name: "page-search",
				description: "Page search params",
				schema: JSON.stringify({ type: "object" }),
				createdAt: now,
				updatedAt: now,
			},
		]);
	});

	afterAll(() => runtime.dispose());

	it("admin page guard allows admins and denies everyone else", async () => {
		const guard = schemasPanelPlugin.panel!.pages![0]!.guard!;
		await expect(
			asPrincipal({ userId: "a1", email: "admin@x.com" }, guard("/platform/schemas")),
		).resolves.toBe(true);
		await expect(
			asPrincipal({ userId: "u1", email: "doc@x.com" }, guard("/platform/schemas")),
		).resolves.toBe(false);
		await expect(asPrincipal(null, guard("/platform/schemas"))).resolves.toBe(false);
	});

	it("admin page loader lists metas for admins and empties for others", async () => {
		const loader = schemasPanelPlugin.panel!.pages![0]!.loader!;
		const rows = (await asPrincipal(
			{ userId: "a1", email: "admin@x.com" },
			loader("/platform/schemas"),
		)) as readonly { id: number; name: string; updatedAt: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: "page-search", description: "Page search params" });
		expect(typeof rows[0]!.updatedAt).toBe("string");
		const denied = (await asPrincipal(
			{ userId: "u1", email: "doc@x.com" },
			loader("/platform/schemas"),
		)) as readonly unknown[];
		expect(denied).toEqual([]);
	});
});
