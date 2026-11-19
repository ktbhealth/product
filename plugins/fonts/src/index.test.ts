import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { Forbidden, Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";

import { fontsChromePlugin, fontsPanelPlugin, fontsServicesPlugin, plugins } from "./index.ts";
import { Fonts } from "./service.ts";
import type { FontProviderSummary } from "./types.ts";

const adminGate = makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"));
const admin = { userId: "u-admin", email: "admin@x.com" };

describe("fonts plugin declarations", () => {
	it("declares the services contribution behind the admin dep", () => {
		expect(fontsServicesPlugin.id).toBe("fonts.services");
		expect(fontsServicesPlugin.requiredDeps).toEqual(["platform.admin"]);
		expect(fontsServicesPlugin.services).toBeDefined();
	});

	it("declares both panel pages with guard and loader", () => {
		expect(fontsPanelPlugin.id).toBe("fonts.panel");
		expect(fontsPanelPlugin.requiredDeps).toEqual(["platform.panel", "fonts.services"]);
		const pages = fontsPanelPlugin.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/fonts/providers", "/platform/fonts"]);
		for (const page of pages) {
			expect(typeof page.guard).toBe("function");
			expect(typeof page.loader).toBe("function");
		}
	});

	it("declares the Site sidebar chrome items", () => {
		expect(fontsChromePlugin.id).toBe("fonts.chrome");
		const items = fontsChromePlugin.chrome ?? [];
		expect(items).toHaveLength(2);
		for (const c of items) {
			expect(c.region).toBe("portal.sidebar");
			expect(c.content).toMatchObject({ kind: "sidebarItem" });
		}
		const tos = items.map((c) => (c.content as { item: { to: string; group?: string } }).item);
		expect(tos.map((i) => i.to)).toEqual(["/platform/fonts/providers", "/platform/fonts"]);
		expect(tos.every((i) => i.group === "Site")).toBe(true);
	});

	it("is discoverable through the plugins export", () => {
		expect(plugins.map((p) => p.id)).toEqual(["fonts.services", "fonts.panel", "fonts.chrome"]);
	});
});

describe("fonts panel guard + loaders", () => {
	const pages = fontsPanelPlugin.panel?.pages ?? [];
	const guard = pages[0]!.guard!;
	const providersLoader = pages[0]!.loader!;
	const catalogLoader = pages[1]!.loader!;

	const fontsStub = Fonts.of({
		listProviders: () => Effect.succeed([] as FontProviderSummary[]),
		providerKinds: () => Effect.succeed(["local", "googlefonts"]),
		createProvider: () => Effect.succeed({} as FontProviderSummary),
		updateProvider: () => Effect.succeed({} as FontProviderSummary),
		setProviderEnabled: () => Effect.void,
		removeProvider: () => Effect.void,
		listFamilies: () => Effect.succeed([]),
		syncProvider: () => Effect.succeed([]),
	});

	const runGuard = (user: { userId: string; email: string } | null) =>
		(user === null ? guard() : guard().pipe(Effect.provideService(Principal, user))).pipe(
			Effect.provideService(PlatformAdmin, adminGate),
		);

	it("guard admits admins and 404s everyone else", async () => {
		await expect(Effect.runPromise(runGuard(admin))).resolves.toBe(true);
		await expect(
			Effect.runPromise(runGuard({ userId: "u-plain", email: "plain@x.com" })),
		).resolves.toBe(false);
	});

	it("providers loader returns providers + kinds", async () => {
		const data = await Effect.runPromise(
			providersLoader().pipe(
				Effect.provideService(PlatformAdmin, adminGate),
				Effect.provideService(Fonts, fontsStub),
				Effect.provideService(Principal, admin),
			),
		);
		expect(data).toEqual({ providers: [], kinds: ["local", "googlefonts"] });
	});

	it("catalog loader returns providers + families", async () => {
		const data = await Effect.runPromise(
			catalogLoader().pipe(
				Effect.provideService(PlatformAdmin, adminGate),
				Effect.provideService(Fonts, fontsStub),
				Effect.provideService(Principal, admin),
			),
		);
		expect(data).toEqual({ providers: [], families: [] });
	});

	it("loaders degrade to empty payloads when the service denies", async () => {
		const forbidden = Effect.fail(new Forbidden({ path: "fonts.list" }));
		const deniedStub = Fonts.of({
			listProviders: () => forbidden,
			providerKinds: () => forbidden,
			createProvider: () => forbidden,
			updateProvider: () => forbidden,
			setProviderEnabled: () => forbidden,
			removeProvider: () => forbidden,
			listFamilies: () => forbidden,
			syncProvider: () => forbidden,
		});
		const provide = <A, E>(effect: Effect.Effect<A, E, Fonts>) =>
			effect.pipe(Effect.provideService(Fonts, deniedStub));
		expect(await Effect.runPromise(provide(providersLoader()))).toEqual({
			providers: [],
			kinds: [],
		});
		expect(await Effect.runPromise(provide(catalogLoader()))).toEqual({
			providers: [],
			families: [],
		});
	});
});
