import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";

import {
	plugins,
	wizardsChromePlugin,
	wizardsPanelPlugin,
	wizardsRenderPlugin,
	wizardsServicesPlugin,
	wizardsTablesPlugin,
} from "./index.ts";
import type { WizardDefinition } from "./definition.ts";
import { Wizards } from "./service.ts";

const DEF: WizardDefinition = {
	id: "intake",
	steps: [{ kind: "info", id: "s" }],
};

const defRow = {
	key: "intake",
	title: "Intake",
	description: "",
	definition: DEF,
	published: true,
	updatedAt: new Date("2024-01-02T03:04:05Z"),
};

const wizardsStub = (over: Partial<Wizards["Service"]> = {}) =>
	Wizards.of({
		publishedDefs: () => Effect.succeed([]),
		adminList: () => Effect.succeed([defRow]),
		adminUpsert: () => Effect.succeed(defRow),
		adminSetPublished: () => Effect.void,
		adminRemove: () => Effect.void,
		startRun: () => Effect.die("unused"),
		getRun: () => Effect.succeed(null),
		advance: () => Effect.die("unused"),
		back: () => Effect.die("unused"),
		abandon: () => Effect.void,
		complete: () => Effect.die("unused"),
		...over,
	} as Wizards["Service"]);

describe("wizards plugins", () => {
	it("exports the five single-concern plugins in order", () => {
		expect(plugins).toEqual([
			wizardsTablesPlugin,
			wizardsServicesPlugin,
			wizardsChromePlugin,
			wizardsRenderPlugin,
			wizardsPanelPlugin,
		]);
		expect(plugins.map((p) => p.id)).toEqual([
			"wizards.tables",
			"wizards.services",
			"wizards.chrome",
			"wizards.render",
			"wizards.panel",
		]);
	});

	it("declares the expected dependency edges", () => {
		expect("requiredDeps" in wizardsTablesPlugin).toBe(false);
		expect(wizardsServicesPlugin.requiredDeps).toEqual([platformAdminPlugin.id]);
		expect(wizardsServicesPlugin.optionalDeps).toEqual(["rbac.services"]);
		expect(wizardsChromePlugin.requiredDeps).toEqual([platformPanelPlugin.id]);
		expect(wizardsRenderPlugin.requiredDeps).toEqual(["wizards.services"]);
		expect(wizardsPanelPlugin.requiredDeps).toEqual([platformPanelPlugin.id, "wizards.services"]);
	});

	it("contributes the two tables", () => {
		expect(Object.keys(wizardsTablesPlugin.tables ?? {})).toEqual(["wizardDefs", "wizardRuns"]);
	});

	it("contributes the sidebar chrome entry", () => {
		const entry = wizardsChromePlugin.chrome?.[0];
		expect(entry?.id).toBe("wizards.sidebar");
		expect(entry?.region).toBe("portal.sidebar");
		expect(entry?.content.kind).toBe("sidebarItem");
		if (entry?.content.kind === "sidebarItem") {
			expect(entry.content.item.to).toBe("/platform/wizards");
			expect(entry.content.item.group).toBe("System");
		}
	});

	it("contributes the /wizards/* app page whose loader echoes the path", async () => {
		const page = wizardsRenderPlugin.pages?.[0];
		expect(page?.id).toBe("wizards.runner");
		expect(page?.path).toBe("/wizards/*");
		expect(page?.context).toBe("app");
		await expect(Effect.runPromise(page?.loader?.("/wizards/intake") as never)).resolves.toBe(
			"/wizards/intake",
		);
	});

	it("panel page guard admits admins and 404s others", async () => {
		const page = wizardsPanelPlugin.panel?.pages[0];
		expect(page?.id).toBe("wizards.admin");
		expect(page?.path).toBe("/platform/wizards");

		// The host binds Principal via runAs; the guard delegates to
		// PlatformAdmin.requireAdmin, so stub the gate directly.
		const guardWith = (allowed: boolean) =>
			Effect.runPromise(
				(page?.guard?.("/platform/wizards") as Effect.Effect<boolean>).pipe(
					Effect.provideService(PlatformAdmin, {
						requireAdmin: () => (allowed ? Effect.void : Effect.fail({ _tag: "Forbidden" })),
					} as never),
				),
			);
		await expect(guardWith(true)).resolves.toBe(true);
		await expect(guardWith(false)).resolves.toBe(false);
	});

	it("panel loader maps admin rows to wires and swallows Forbidden", async () => {
		const page = wizardsPanelPlugin.panel?.pages[0];
		const runLoader = (wizards: Wizards["Service"]) =>
			Effect.runPromise(
				(page?.loader?.("/platform/wizards") as Effect.Effect<unknown>).pipe(
					Effect.provideService(Wizards, wizards),
				),
			);
		const rows = (await runLoader(wizardsStub())) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			key: "intake",
			title: "Intake",
			published: true,
			updatedAt: "2024-01-02T03:04:05.000Z",
		});

		const forbidden = wizardsStub({
			adminList: () => Effect.fail({ _tag: "Forbidden" }),
		} as unknown as Partial<Wizards["Service"]>);
		await expect(runLoader(forbidden)).resolves.toEqual([]);
	});
});
