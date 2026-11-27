import { beforeAll, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { AiPrompts, AiPromptsLive, aiPromptPanelPlugin, plugins } from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";

describe("ai-prompt plugin manifests", () => {
	it("declares tables, services, chrome and panel plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"ai.prompt.tables",
			"ai.prompt.services",
			"ai.prompt.chrome",
			"ai.prompt.panel",
		]);
		const tables = plugins.find((p) => p.id === "ai.prompt.tables")?.tables ?? {};
		expect(Object.keys(tables)).toEqual(["aiPrompt"]);
		const panel = plugins.find((p) => p.id === "ai.prompt.panel")?.panel?.pages ?? [];
		expect(panel.map((p) => p.path)).toEqual(["/platform/ai/prompts"]);
	});

	it("client mirror matches the server plugin ids and panel path", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"ai.prompt.tables",
			"ai.prompt.services",
			"ai.prompt.chrome",
			"ai.prompt.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "ai.prompt.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["ai-prompt.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "ai.prompt.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/ai/prompts"]);
	});
});

describe("aiPromptPanelPlugin page", () => {
	const ADMIN = "admin@x.com";
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;

	const runAs = <A, E>(email: string, effect: Effect.Effect<A, E, unknown>) =>
		runtime.runPromise(
			effect.pipe(Effect.provideService(Principal, { userId: `id-${email}`, email } as never)),
		);

	beforeAll(async () => {
		const db = makeDb(makeTestD1());
		const infra = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN))),
		);
		runtime = ManagedRuntime.make(
			Layer.mergeAll(AiPromptsLive.pipe(Layer.provide(infra)), infra) as never,
		);
		await runAs(
			ADMIN,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "p1.prompt", template: "t" })),
		);
	});

	it("declares the prompts page with an admin guard and loader", () => {
		const page = aiPromptPanelPlugin.panel?.pages[0];
		expect(page?.id).toBe("ai-prompts");
		expect(page?.path).toBe("/platform/ai/prompts");
		expect(page?.component).toBeDefined();
		expect(page?.guard).toBeDefined();
		expect(page?.loader).toBeDefined();
	});

	it("guard admits platform admins and denies everyone else", async () => {
		const page = aiPromptPanelPlugin.panel?.pages[0];
		expect(await runAs(ADMIN, page!.guard!() as Effect.Effect<boolean>)).toBe(true);
		expect(await runAs("doc@x.com", page!.guard!() as Effect.Effect<boolean>)).toBe(false);
	});

	it("loader lists platform prompts for admins and degrades to []", async () => {
		const page = aiPromptPanelPlugin.panel?.pages[0];
		const rows = (await runAs(
			ADMIN,
			page!.loader!() as Effect.Effect<readonly { name: string }[], never, unknown>,
		)) as readonly { name: string }[];
		expect(rows.map((r) => r.name)).toContain("p1.prompt");
		const denied = (await runAs(
			"doc@x.com",
			page!.loader!() as Effect.Effect<readonly unknown[], never, unknown>,
		)) as readonly unknown[];
		expect(denied).toEqual([]);
	});
});
