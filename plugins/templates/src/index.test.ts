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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { TemplateKinds, TemplateKindsLive } from "./kinds.ts";
import {
	plugins,
	templatesChromePlugin,
	templatesPanelPlugin,
	templatesServicesPlugin,
	templatesTablesPlugin,
} from "./index.ts";
import { templates } from "./schema.ts";
import { TemplatesLive } from "./service.ts";

describe("templates plugins", () => {
	it("exposes the four single-concern plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"templates.tables",
			"templates.services",
			"templates.chrome",
			"templates.panel",
		]);
		expect(templatesTablesPlugin.tables?.templates).toBeDefined();
		expect(templatesServicesPlugin.services).toBeDefined();
		expect(templatesServicesPlugin.requiredDeps).toEqual([platformAdminPlugin.id]);
	});

	it("declares the console sidebar entry in the Site group", () => {
		const chrome = templatesChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(1);
		const sidebar = chrome[0];
		expect(sidebar?.id).toBe("templates.sidebar");
		expect(sidebar?.region).toBe("portal.sidebar");
		expect(sidebar?.content.kind).toBe("sidebarItem");
		const item =
			sidebar?.content.kind === "sidebarItem"
				? sidebar.content.item
				: ({ to: "", group: "" } as { to: string; group: string });
		expect(item.to).toBe("/platform/templates");
		expect(item.group).toBe("Site");
	});

	it("declares the admin console page with guard and loader", () => {
		expect(templatesPanelPlugin.requiredDeps).toEqual(["platform.panel", "templates.services"]);
		const admin = templatesPanelPlugin.panel?.pages?.[0];
		expect(admin?.id).toBe("templates.admin");
		expect(admin?.path).toBe("/platform/templates");
		expect(admin?.guard).toBeTypeOf("function");
		expect(admin?.loader).toBeTypeOf("function");
	});
});

describe("templates page effects", () => {
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
		// Production wiring: the shared TemplateKinds registry rides
		// along so the loader can list registered kinds.
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				TemplatesLive.pipe(Layer.provideMerge(TemplateKindsLive), Layer.provide(deps)),
				deps,
			) as Layer.Layer<unknown, never, never>,
		);
		const now = new Date();
		await db.insert(templates).values([
			{
				kind: "layout",
				name: "landing",
				description: "Landing snapshot",
				payload: { sections: [] },
				createdBy: "admin@x.com",
				createdAt: now,
				updatedAt: now,
			},
		]);
		await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* TemplateKinds;
				yield* kinds.register({
					kind: "layout",
					label: "Layout",
					serialize: (s) => Effect.succeed(s),
					deserialize: (p) => Effect.succeed(p),
					validate: () => Effect.succeed([]),
				});
			}),
		);
	});

	afterAll(() => runtime.dispose());

	it("admin page guard allows admins and denies everyone else", async () => {
		const guard = templatesPanelPlugin.panel!.pages![0]!.guard!;
		await expect(
			asPrincipal({ userId: "a1", email: "admin@x.com" }, guard("/platform/templates")),
		).resolves.toBe(true);
		await expect(
			asPrincipal({ userId: "u1", email: "doc@x.com" }, guard("/platform/templates")),
		).resolves.toBe(false);
		await expect(asPrincipal(null, guard("/platform/templates"))).resolves.toBe(false);
	});

	it("admin page loader lists metas + kinds for admins and empties for others", async () => {
		const loader = templatesPanelPlugin.panel!.pages![0]!.loader!;
		const data = (await asPrincipal(
			{ userId: "a1", email: "admin@x.com" },
			loader("/platform/templates"),
		)) as { rows: readonly Record<string, unknown>[]; kinds: readonly { kind: string }[] };
		expect(data.rows).toHaveLength(1);
		expect(data.rows[0]).toMatchObject({
			kind: "layout",
			name: "landing",
			description: "Landing snapshot",
			createdBy: "admin@x.com",
		});
		expect(typeof data.rows[0]!.updatedAt).toBe("string");
		expect(data.kinds.map((k) => k.kind)).toContain("layout");
		const denied = (await asPrincipal(
			{ userId: "u1", email: "doc@x.com" },
			loader("/platform/templates"),
		)) as { rows: readonly unknown[]; kinds: readonly unknown[] };
		expect(denied.rows).toEqual([]);
		// Kinds still list for non-admins — registry metadata is not
		// sensitive; only the rows are gated.
		expect(denied.kinds.length).toBeGreaterThan(0);
	});
});
