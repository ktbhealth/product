import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { promptsApi } from "./apis.ts";
import { promptsCreateFn, promptsListFn, promptsRemoveFn, promptsUpdateFn } from "./fns.ts";
import { AiPromptsLive } from "./index.ts";

const ADMIN = "admin@x.com";

describe("ai-prompt fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));

	beforeAll(() => {
		const db = makeDb(makeTestD1());
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN))),
		);
		runtime = ManagedRuntime.make(AiPromptsLive.pipe(Layer.provide(env)) as never);
		installServerFnRuntime(runtime, auth);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		expect(await promptsListFn()).toEqual([]);
		await expect(promptsCreateFn({ data: { name: "x", template: "t" } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(promptsUpdateFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(promptsRemoveFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
	});

	it("denies non-admin principals with { ok: false } / []", async () => {
		currentEmail = "doc@x.com";
		expect(await promptsListFn()).toEqual([]);
		expect(await promptsCreateFn({ data: { name: "x", template: "t" } })).toEqual({
			ok: false,
		});
		expect(await promptsUpdateFn({ data: { id: 1, template: "t" } })).toEqual({ ok: false });
		expect(await promptsRemoveFn({ data: { id: 1 } })).toEqual({ ok: false });
	});

	it("drives the prompt CRUD through the fn surface", async () => {
		currentEmail = ADMIN;

		// Minimal create — optional fields absent.
		const bare = await promptsCreateFn({ data: { name: "bare.prompt", template: "t-bare" } });
		expect(bare.ok).toBe(true);
		if (!bare.ok) return;
		expect(bare.data.version).toBe(1);
		expect(bare.data.locale).toBe("");
		expect(bare.data.variables).toEqual([]);

		// Full create — every optional field on the wire.
		const full = await promptsCreateFn({
			data: {
				name: "full.prompt",
				template: "t-full",
				version: 3,
				locale: "pt-BR",
				variables: [{ name: "transcript", required: true, description: "d" }],
				modelHint: "chat",
				isSystem: true,
				isDefault: true,
			},
		});
		expect(full.ok).toBe(true);
		if (!full.ok) return;
		expect(full.data).toMatchObject({
			version: 3,
			locale: "pt-BR",
			modelHint: "chat",
			isSystem: true,
			isDefault: true,
		});
		expect(full.data.variables).toEqual([{ name: "transcript", required: true, description: "d" }]);

		// Auto-increment create on the same name appends v2? No — pinned
		// v3 exists, so the next unpinned create lands on v4.
		const next = await promptsCreateFn({ data: { name: "full.prompt", template: "t-next" } });
		expect(next.ok).toBe(true);
		if (!next.ok) return;
		expect(next.data.version).toBe(4);

		// List filters by name when provided.
		const listed = await promptsListFn({ data: { name: "bare.prompt" } });
		expect(listed.map((p) => p.name)).toEqual(["bare.prompt"]);
		expect((await promptsListFn()).length).toBeGreaterThanOrEqual(3);
		// Blank name behaves like no filter.
		expect((await promptsListFn({ data: { name: "" } })).length).toBeGreaterThanOrEqual(3);

		// Update with every field set, then a minimal update.
		const updated = await promptsUpdateFn({
			data: {
				id: bare.data.id,
				template: "t-bare-2",
				variables: [{ name: "x" }],
				modelHint: "judge",
				isSystem: true,
				isDefault: true,
				enabled: false,
			},
		});
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.data).toMatchObject({
			template: "t-bare-2",
			modelHint: "judge",
			isSystem: true,
			isDefault: true,
			enabled: false,
		});
		expect((await promptsUpdateFn({ data: { id: bare.data.id, enabled: true } })).ok).toBe(true);

		// Remove roundtrip.
		expect(await promptsRemoveFn({ data: { id: bare.data.id } })).toEqual({
			ok: true,
			data: null,
		});
	});

	it("collapses service denials to { ok: false }", async () => {
		currentEmail = ADMIN;
		// Duplicate (scope,name,version,locale) → PromptError.
		expect(
			await promptsCreateFn({
				data: { name: "full.prompt", template: "dup", version: 3, locale: "pt-BR" },
			}),
		).toEqual({ ok: false });
		// Unknown id → not-found on update and remove.
		expect(await promptsUpdateFn({ data: { id: 9999, template: "x" } })).toEqual({ ok: false });
		expect(await promptsRemoveFn({ data: { id: 9999 } })).toEqual({ ok: false });
		// Blank name/template → invalid PromptError.
		expect(await promptsCreateFn({ data: { name: "  ", template: "t" } })).toEqual({
			ok: false,
		});
		expect(await promptsCreateFn({ data: { name: "x", template: " " } })).toEqual({
			ok: false,
		});
	});

	it("promptsApi delegates to the server fns", async () => {
		currentEmail = ADMIN;
		const created = await promptsApi.create({ name: "via-api", template: "t-api" });
		expect(created.ok).toBe(true);
		const id = created.data?.id;
		expect(id).toBeTypeOf("number");
		expect((await promptsApi.update({ id: id!, template: "t-api-2" })).ok).toBe(true);
		expect((await promptsApi.remove(id!)).ok).toBe(true);
	});
});
