import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { Forbidden, Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";

import {
	plugins,
	themeBrandPlugin,
	themeChromePlugin,
	themeHeaderPlugin,
	themePanelPlugin,
	themeRoutesPlugin,
	themeServicesPlugin,
} from "./index.ts";
import { Theme } from "./theme.ts";
import type { ThemeSummary } from "./types.ts";

describe("theme plugin declarations", () => {
	it("declares the services contribution behind the admin dep", () => {
		expect(themeServicesPlugin.id).toBe("theme.services");
		expect(themeServicesPlugin.requiredDeps).toEqual(["platform.admin"]);
		expect(themeServicesPlugin.services).toBeDefined();
	});

	it("declares the panel page with guard and loader", () => {
		expect(themePanelPlugin.id).toBe("theme.panel");
		expect(themePanelPlugin.requiredDeps).toEqual(["platform.panel", "theme.services"]);
		const page = themePanelPlugin.panel?.pages?.[0];
		expect(page).toMatchObject({ id: "theme.admin", path: "/platform/theme" });
		expect(typeof page?.guard).toBe("function");
		expect(typeof page?.loader).toBe("function");
	});

	it("declares header, brand, chrome and routes contributions", () => {
		expect(themeHeaderPlugin.id).toBe("theme.header");
		expect(themeHeaderPlugin.optionalDeps).toEqual(["platform.header"]);
		expect(themeHeaderPlugin.chrome?.[0]).toMatchObject({
			region: "portal.header.actions",
			content: { kind: "headerAction", id: "theme" },
		});
		expect(themeBrandPlugin.id).toBe("theme.brand");
		expect(themeBrandPlugin.chrome?.[0]).toMatchObject({
			region: "app.header.brand",
			content: { kind: "component" },
		});
		expect(themeChromePlugin.chrome?.[0]).toMatchObject({
			region: "portal.sidebar",
			content: { kind: "sidebarItem" },
		});
		expect(themeRoutesPlugin.id).toBe("theme.routes");
		expect(themeRoutesPlugin.routes?.length).toBeGreaterThan(0);
	});

	it("is discoverable through the plugins export", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"theme.services",
			"theme.brand",
			"theme.panel",
			"theme.header",
			"theme.chrome",
			"theme.routes",
		]);
	});
});

describe("theme.panel page guard", () => {
	const guard = themePanelPlugin.panel!.pages![0]!.guard as (
		path: string,
	) => Effect.Effect<boolean, unknown, PlatformAdmin>;
	const gate = (admin: boolean) =>
		makePlatformAdminGate(parsePlatformAdminEmails(admin ? "admin@x.com" : ""));

	it("returns true for allowlisted admins", async () => {
		const result = await Effect.runPromise(
			guard("/platform/theme").pipe(
				Effect.provideService(PlatformAdmin, gate(true)),
				Effect.provideService(Principal, {
					userId: "u1",
					email: "admin@x.com",
				}),
			),
		);
		expect(result).toBe(true);
	});

	it("returns false for non-admins", async () => {
		const result = await Effect.runPromise(
			guard("/platform/theme").pipe(
				Effect.provideService(PlatformAdmin, gate(true)),
				Effect.provideService(Principal, { userId: "u1", email: "doc@x.com" }),
			),
		);
		expect(result).toBe(false);
	});
});

describe("theme.panel page loader", () => {
	const loader = themePanelPlugin.panel!.pages![0]!.loader as (
		path: string,
	) => Effect.Effect<{ themes: readonly ThemeSummary[] }, unknown, Theme>;

	const themeStub = (list: Theme["Service"]["list"]): Theme["Service"] =>
		({
			resolve: () => Effect.succeed({} as never),
			list,
			get: () => Effect.succeed(null),
			publish: () => Effect.succeed({} as never),
			setEnabled: () => Effect.void,
			previewRow: () => Effect.succeed(null),
		}) as Theme["Service"];

	it("returns the theme list", async () => {
		const rows: ThemeSummary[] = [
			{
				id: 1,
				scope: "platform",
				scopeId: "",
				appName: "P",
				enabled: true,
				version: 1,
			},
		];
		const result = await Effect.runPromise(
			loader("/platform/theme").pipe(
				Effect.provideService(
					Theme,
					themeStub(() => Effect.succeed(rows)),
				),
			),
		);
		expect(result).toEqual({ themes: rows });
	});

	it("degrades a Forbidden failure to an empty list", async () => {
		const result = await Effect.runPromise(
			loader("/platform/theme").pipe(
				Effect.provideService(
					Theme,
					themeStub(() => Effect.fail(new Forbidden({ path: "theme.list" }))),
				),
			),
		);
		expect(result).toEqual({ themes: [] });
	});
});
