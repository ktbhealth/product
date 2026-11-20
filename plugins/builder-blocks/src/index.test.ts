import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformPanelPlugin,
} from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	builderBlocksChromePlugin,
	builderBlocksElementsPlugin,
	builderBlocksPanelPlugin,
	builderBlocksServicesPlugin,
	plugins,
} from "./index.ts";

/**
 * Manifest contract tests (same shape as plugins/rich-text/src/index.test.ts):
 * plugin ids/order, the Site-group sidebar entry, the element-kind
 * manifest and the /platform/components panel page — plus the page
 * guard/loader Effects run under a test runtime with a real
 * PlatformAdmin gate.
 */

describe("builder-blocks plugins", () => {
	it("exposes the four single-concern plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"builder-blocks.services",
			"builder-blocks.chrome",
			"builder-blocks.panel",
			"builder-blocks.elements",
		]);
		expect(builderBlocksServicesPlugin.services).toBeDefined();
	});

	it("declares the console sidebar entry in the Site group", () => {
		const chrome = builderBlocksChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(1);
		const sidebar = chrome[0];
		expect(sidebar?.id).toBe("builder-blocks.sidebar");
		expect(sidebar?.region).toBe("portal.sidebar");
		expect(sidebar?.content.kind).toBe("sidebarItem");
		const item =
			sidebar?.content.kind === "sidebarItem"
				? sidebar.content.item
				: ({ to: "", group: "" } as { to: string; group: string });
		expect(item.to).toBe("/platform/components");
		expect(item.group).toBe("Site");
	});

	it("declares the nine element kinds with renderer/editor/fields", () => {
		const kinds = builderBlocksElementsPlugin.elementKinds ?? [];
		expect(kinds).toHaveLength(9);
		for (const kind of kinds) {
			expect(kind.kind.length).toBeGreaterThan(0);
			expect(kind.renderer).toBeTypeOf("function");
			expect(kind.editor).toBeTypeOf("function");
			expect(kind.fields?.type).toBe("object");
		}
	});

	it("declares the catalog page with guard and loader", () => {
		expect(builderBlocksPanelPlugin.requiredDeps).toEqual([platformPanelPlugin.id]);
		const page = builderBlocksPanelPlugin.panel?.pages?.[0];
		expect(page?.id).toBe("builder-blocks.catalog");
		expect(page?.path).toBe("/platform/components");
		expect(page?.guard).toBeTypeOf("function");
		expect(page?.loader).toBeTypeOf("function");
	});
});

describe("builder-blocks page effects", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;

	const asPrincipal = <A, E>(
		principal: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, principal) as Effect.Effect<A, E, never>,
		);

	beforeAll(() => {
		// The guard yields PlatformAdmin directly — provide the gate with
		// a single allowlisted admin, same shape the composition root uses.
		const deps = Layer.succeed(
			PlatformAdmin,
			makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
		);
		runtime = ManagedRuntime.make(deps as Layer.Layer<unknown, never, never>);
	});

	afterAll(() => runtime.dispose());

	it("catalog guard allows admins and denies everyone else", async () => {
		const guard = builderBlocksPanelPlugin.panel!.pages![0]!.guard!;
		await expect(
			asPrincipal({ userId: "a1", email: "admin@x.com" }, guard("/platform/components")),
		).resolves.toBe(true);
		await expect(
			asPrincipal({ userId: "u1", email: "doc@x.com" }, guard("/platform/components")),
		).resolves.toBe(false);
		await expect(asPrincipal(null, guard("/platform/components"))).resolves.toBe(false);
	});

	it("catalog loader yields null — kinds are client-manifest data", async () => {
		const loader = builderBlocksPanelPlugin.panel!.pages![0]!.loader!;
		await expect(asPrincipal(null, loader("/platform/components"))).resolves.toBeNull();
	});
});
