import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
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
	KV_TEST_DDL,
	kvAdminServicesPlugin,
	kvChromePlugin,
	kvEntries,
	kvPanelPlugin,
	kvServicesPlugin,
	kvTablesPlugin,
	plugins,
} from "./index.ts";
import { KvAdminLive } from "./admin.ts";

describe("kv plugins", () => {
	it("exposes the five single-concern plugins in order", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"kv.tables",
			"kv.services",
			"kv.admin.services",
			"kv.chrome",
			"kv.panel",
		]);
		expect(kvTablesPlugin.tables?.kvEntries).toBeDefined();
		expect(kvServicesPlugin.services).toBeDefined();
		expect(kvAdminServicesPlugin.services).toBeDefined();
		expect(kvAdminServicesPlugin.requiredDeps).toEqual([platformAdminPlugin.id]);
	});

	it("declares the console sidebar entry in the System group", () => {
		const chrome = kvChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(1);
		const sidebar = chrome[0];
		expect(sidebar?.id).toBe("kv.sidebar");
		expect(sidebar?.region).toBe("portal.sidebar");
		expect(sidebar?.content.kind).toBe("sidebarItem");
		if (sidebar?.content.kind !== "sidebarItem") throw new Error("unreachable");
		expect(sidebar.content.item.to).toBe("/platform/kv");
		expect(sidebar.content.item.group).toBe("System");
	});

	it("declares the admin console page with guard and loader", () => {
		const page = kvPanelPlugin.panel?.pages?.[0];
		expect(page?.id).toBe("kv.entries");
		expect(page?.path).toBe("/platform/kv");
		expect(page?.guard).toBeTypeOf("function");
		expect(page?.loader).toBeTypeOf("function");
		expect(kvPanelPlugin.requiredDeps).toEqual([platformPanelPlugin.id, kvAdminServicesPlugin.id]);
	});
});

describe("kv panel page effects", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let db: ReturnType<typeof makeDb>;

	const asPrincipal = <A, E>(
		principal: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, principal) as Effect.Effect<A, E, never>,
		);

	beforeAll(async () => {
		db = makeDb(makeD1(KV_TEST_DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(
			Layer.mergeAll(KvAdminLive.pipe(Layer.provide(deps)), deps) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		const now = new Date();
		await db.insert(kvEntries).values([
			{
				namespace: "alpha",
				key: "a1",
				value: "1",
				createdAt: now,
				updatedAt: now,
			},
			{
				namespace: "beta",
				key: "b1",
				value: "2",
				tenantId: 3,
				createdAt: now,
				updatedAt: now,
			},
		]);
	});

	afterAll(() => runtime.dispose());

	it("admin page guard allows admins and denies everyone else", async () => {
		const guard = kvPanelPlugin.panel!.pages![0]!.guard!;
		await expect(
			asPrincipal({ userId: "a1", email: "admin@x.com" }, guard("/platform/kv")),
		).resolves.toBe(true);
		await expect(
			asPrincipal({ userId: "u1", email: "doc@x.com" }, guard("/platform/kv")),
		).resolves.toBe(false);
		await expect(asPrincipal(null, guard("/platform/kv"))).resolves.toBe(false);
	});

	it("admin page loader returns entries and namespaces for admins", async () => {
		const loader = kvPanelPlugin.panel!.pages![0]!.loader!;
		const data = (await asPrincipal(
			{ userId: "a1", email: "admin@x.com" },
			loader("/platform/kv"),
		)) as {
			items: readonly { namespace: string; key: string }[];
			total: number;
			namespaces: readonly { namespace: string; count: number }[];
		};
		expect(data.total).toBe(2);
		expect(data.items.map((i) => `${i.namespace}/${i.key}`)).toEqual(["alpha/a1", "beta/b1"]);
		expect(data.namespaces).toEqual([
			{ namespace: "alpha", count: 1 },
			{ namespace: "beta", count: 1 },
		]);
	});

	it("admin page loader empties for non-admins", async () => {
		const loader = kvPanelPlugin.panel!.pages![0]!.loader!;
		const data = (await asPrincipal(
			{ userId: "u1", email: "doc@x.com" },
			loader("/platform/kv"),
		)) as { items: readonly unknown[]; total: number; namespaces: readonly unknown[] };
		expect(data).toEqual({ items: [], total: 0, namespaces: [] });
	});
});
