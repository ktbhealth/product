import { beforeAll, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	MACHINES_TEST_DDL,
	Machines,
	MachinesLive,
	machinesPanelPlugin,
	plugins,
} from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";

describe("machines plugin manifests", () => {
	it("declares tables, services, chrome and panel plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"machines.tables",
			"machines.services",
			"machines.chrome",
			"machines.panel",
		]);
		const tables = plugins.find((p) => p.id === "machines.tables")?.tables ?? {};
		expect(Object.keys(tables)).toEqual(["machine"]);
		const panel = plugins.find((p) => p.id === "machines.panel")?.panel?.pages ?? [];
		expect(panel.map((p) => p.path)).toEqual(["/platform/ai/machines"]);
	});

	it("client mirror matches the server plugin ids and panel path", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"machines.tables",
			"machines.services",
			"machines.chrome",
			"machines.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "machines.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["machines.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "machines.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/ai/machines"]);
	});
});

describe("machinesPanelPlugin page", () => {
	const ADMIN = "admin@x.com";
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;

	const runAs = <A, E>(email: string, effect: Effect.Effect<A, E, unknown>) =>
		runtime.runPromise(
			effect.pipe(Effect.provideService(Principal, { userId: `id-${email}`, email } as never)),
		);

	beforeAll(async () => {
		const db = makeDb(makeD1(MACHINES_TEST_DDL));
		const infra = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN))),
		);
		runtime = ManagedRuntime.make(
			Layer.mergeAll(MachinesLive.pipe(Layer.provide(infra)), infra) as never,
		);
		await runAs(
			ADMIN,
			Effect.flatMap(Machines, (m) => m.create({ name: "p1", host: "p1.local" })),
		);
	});

	it("declares the machines page with an admin guard and loader", () => {
		const page = machinesPanelPlugin.panel?.pages[0];
		expect(page?.id).toBe("machines");
		expect(page?.path).toBe("/platform/ai/machines");
		expect(page?.component).toBeDefined();
		expect(page?.guard).toBeDefined();
		expect(page?.loader).toBeDefined();
	});

	it("guard admits platform admins and denies everyone else", async () => {
		const page = machinesPanelPlugin.panel?.pages[0];
		expect(await runAs(ADMIN, page!.guard!() as Effect.Effect<boolean>)).toBe(true);
		expect(await runAs("doc@x.com", page!.guard!() as Effect.Effect<boolean>)).toBe(false);
	});

	it("loader lists platform machines for admins and degrades to []", async () => {
		const page = machinesPanelPlugin.panel?.pages[0];
		const rows = (await runAs(
			ADMIN,
			page!.loader!() as Effect.Effect<readonly { name: string }[], never, unknown>,
		)) as readonly { name: string }[];
		expect(rows.map((r) => r.name)).toContain("p1");
		const denied = (await runAs(
			"doc@x.com",
			page!.loader!() as Effect.Effect<readonly unknown[], never, unknown>,
		)) as readonly unknown[];
		expect(denied).toEqual([]);
	});
});
