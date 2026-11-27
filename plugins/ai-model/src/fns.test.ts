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

import { AiModelsLive } from "./index.ts";
import { modelsApi } from "./apis.ts";
import { modelsCreateFn, modelsListFn, modelsRemoveFn, modelsUpdateFn } from "./fns.ts";

const ADMIN = "admin@x.com";

describe("ai-model fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));

	beforeAll(() => {
		const db = makeDb(makeTestD1());
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN))),
		);
		runtime = ManagedRuntime.make(AiModelsLive.pipe(Layer.provide(env)) as never);
		installServerFnRuntime(runtime, auth);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		expect(await modelsListFn()).toEqual([]);
		await expect(modelsCreateFn({ data: { name: "x", modelId: "y" } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(modelsUpdateFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(modelsRemoveFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
	});

	it("denies non-admin principals with { ok: false } / []", async () => {
		currentEmail = "doc@x.com";
		expect(await modelsListFn()).toEqual([]);
		expect(await modelsCreateFn({ data: { name: "x", modelId: "y" } })).toEqual({
			ok: false,
		});
		expect(await modelsUpdateFn({ data: { id: 1, name: "z" } })).toEqual({ ok: false });
		expect(await modelsRemoveFn({ data: { id: 1 } })).toEqual({ ok: false });
	});

	it("drives the model CRUD through the fn surface", async () => {
		currentEmail = ADMIN;

		// Minimal create — optional fields absent.
		const bare = await modelsCreateFn({ data: { name: "bare", modelId: "m-bare" } });
		expect(bare.ok).toBe(true);
		if (!bare.ok) return;
		expect(bare.data.kind).toBe("chat");
		expect(bare.data.capabilities).toEqual([]);

		// Full create — every optional field on the wire.
		const full = await modelsCreateFn({
			data: {
				name: "full",
				modelId: "m-full",
				endpointId: 9,
				kind: "vision",
				capabilities: ["chat", "vision"],
				contextTokens: 8192,
				costTier: "low",
				isDefault: true,
			},
		});
		expect(full.ok).toBe(true);
		if (!full.ok) return;
		expect(full.data).toMatchObject({
			endpointId: 9,
			kind: "vision",
			contextTokens: 8192,
			costTier: "low",
			isDefault: true,
		});

		// List returns both platform rows.
		const listed = await modelsListFn();
		expect(listed.map((m) => m.name).sort()).toEqual(["bare", "full"]);

		// Update with every field set, then a minimal update.
		const updated = await modelsUpdateFn({
			data: {
				id: bare.data.id,
				name: "bare-2",
				modelId: "m-bare-2",
				endpointId: null,
				kind: "embed",
				capabilities: ["embed"],
				contextTokens: 1024,
				costTier: "free",
				isDefault: false,
				enabled: false,
			},
		});
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.data).toMatchObject({
			name: "bare-2",
			modelId: "m-bare-2",
			kind: "embed",
			enabled: false,
		});
		expect((await modelsUpdateFn({ data: { id: bare.data.id, enabled: true } })).ok).toBe(true);

		// Remove roundtrip.
		expect(await modelsRemoveFn({ data: { id: bare.data.id } })).toEqual({
			ok: true,
			data: null,
		});
		expect((await modelsListFn()).map((m) => m.name)).toEqual(["full"]);
	});

	it("collapses service denials to { ok: false }", async () => {
		currentEmail = ADMIN;
		// Duplicate name → ModelError.
		expect(await modelsCreateFn({ data: { name: "full", modelId: "other" } })).toEqual({
			ok: false,
		});
		// Unknown id → ModelError not-found on update and remove.
		expect(await modelsUpdateFn({ data: { id: 9999, name: "x" } })).toEqual({ ok: false });
		expect(await modelsRemoveFn({ data: { id: 9999 } })).toEqual({ ok: false });
		// Blank name → invalid ModelError (against the surviving "full" row).
		expect(await modelsCreateFn({ data: { name: "  ", modelId: "x" } })).toEqual({
			ok: false,
		});
		const survivor = (await modelsListFn())[0]!;
		expect(await modelsUpdateFn({ data: { id: survivor.id, name: " " } })).toEqual({
			ok: false,
		});
		expect(await modelsUpdateFn({ data: { id: survivor.id, modelId: " " } })).toEqual({
			ok: false,
		});
	});

	it("modelsApi delegates to the server fns", async () => {
		currentEmail = ADMIN;
		const created = await modelsApi.create({ name: "via-api", modelId: "m-api" });
		expect(created.ok).toBe(true);
		const id = created.data?.id;
		expect(id).toBeTypeOf("number");
		expect((await modelsApi.update({ id: id!, name: "via-api-2" })).ok).toBe(true);
		expect((await modelsApi.remove(id!)).ok).toBe(true);
	});
});
