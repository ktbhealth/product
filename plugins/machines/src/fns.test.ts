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
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { machinesApi } from "./apis.ts";
import {
	machinesBeatFn,
	machinesCheckAllFn,
	machinesCheckFn,
	machinesCreateFn,
	machinesListFn,
	machinesRemoveFn,
	machinesUpdateFn,
} from "./fns.ts";
import { MACHINES_TEST_DDL, MachinesLive } from "./index.ts";

const ADMIN = "admin@x.com";

describe("machines fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));

	beforeAll(() => {
		// checkAll probes healthUrls — keep probes off the network.
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
		const db = makeDb(makeD1(MACHINES_TEST_DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN))),
		);
		runtime = ManagedRuntime.make(MachinesLive.pipe(Layer.provide(env)) as never);
		installServerFnRuntime(runtime, auth);
	});

	afterAll(() => {
		vi.unstubAllGlobals();
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		expect(await machinesListFn()).toEqual([]);
		await expect(machinesCreateFn({ data: { name: "x", host: "h" } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(machinesUpdateFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(machinesRemoveFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(machinesCheckFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(machinesCheckAllFn()).rejects.toThrow("unauthenticated");
		await expect(machinesBeatFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
	});

	it("denies non-admin principals with { ok: false } / []", async () => {
		currentEmail = "doc@x.com";
		expect(await machinesListFn()).toEqual([]);
		expect(await machinesCreateFn({ data: { name: "x", host: "h" } })).toEqual({ ok: false });
		expect(await machinesUpdateFn({ data: { id: 1, name: "z" } })).toEqual({ ok: false });
		expect(await machinesRemoveFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await machinesCheckFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await machinesCheckAllFn()).toEqual({ ok: false });
		expect(await machinesBeatFn({ data: { id: 1 } })).toEqual({ ok: false });
	});

	it("drives the machine CRUD + health fns", async () => {
		currentEmail = ADMIN;

		// Minimal create — optional fields absent.
		const bare = await machinesCreateFn({ data: { name: "bare-box", host: "bare.local" } });
		expect(bare.ok).toBe(true);
		if (!bare.ok) return;
		expect(bare.data.kind).toBe("other");
		expect(bare.data.capabilities).toEqual([]);

		// Full create — every optional field on the wire.
		const full = await machinesCreateFn({
			data: {
				name: "full-box",
				kind: "gpu",
				host: "gpu.local",
				port: 22,
				capabilities: ["acp", "eval-runner"],
				secretRef: "vault:3",
				healthUrl: "http://gpu.local/health",
			},
		});
		expect(full.ok).toBe(true);
		if (!full.ok) return;
		expect(full.data).toMatchObject({
			kind: "gpu",
			port: 22,
			secretRef: "vault:3",
			healthUrl: "http://gpu.local/health",
		});

		const listed = await machinesListFn();
		expect(listed.map((m) => m.name).sort()).toEqual(["bare-box", "full-box"]);

		// Update with every field, then a minimal update.
		const updated = await machinesUpdateFn({
			data: {
				id: bare.data.id,
				name: "bare-box-2",
				kind: "vm",
				host: "bare2.local",
				port: null,
				capabilities: ["llm"],
				secretRef: "env:TOKEN",
				healthUrl: null,
				enabled: false,
			},
		});
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.data).toMatchObject({
			name: "bare-box-2",
			kind: "vm",
			enabled: false,
			secretRef: "env:TOKEN",
		});
		expect((await machinesUpdateFn({ data: { id: bare.data.id, enabled: true } })).ok).toBe(true);

		// Health fns — no healthUrl → staleness path, no fetch needed.
		const checked = await machinesCheckFn({ data: { id: bare.data.id } });
		expect(checked.ok).toBe(true);
		if (checked.ok) expect(checked.data?.status).toBe("unknown");
		const all = await machinesCheckAllFn();
		expect(all.ok).toBe(true);
		if (all.ok) expect(all.data.length).toBeGreaterThanOrEqual(2);
		expect(await machinesBeatFn({ data: { id: bare.data.id } })).toEqual({
			ok: true,
			data: null,
		});

		// Remove roundtrip.
		expect(await machinesRemoveFn({ data: { id: bare.data.id } })).toEqual({
			ok: true,
			data: null,
		});
		expect((await machinesListFn()).map((m) => m.name)).toEqual(["full-box"]);
	});

	it("collapses service denials to { ok: false }", async () => {
		currentEmail = ADMIN;
		// Duplicate name → MachineError.
		expect(await machinesCreateFn({ data: { name: "full-box", host: "h" } })).toEqual({
			ok: false,
		});
		// Unknown id → not-found on update/remove/check/beat.
		expect(await machinesUpdateFn({ data: { id: 9999, name: "x" } })).toEqual({ ok: false });
		expect(await machinesRemoveFn({ data: { id: 9999 } })).toEqual({ ok: false });
		expect(await machinesCheckFn({ data: { id: 9999 } })).toEqual({ ok: false });
		expect(await machinesBeatFn({ data: { id: 9999 } })).toEqual({ ok: false });
		// Malformed vault ref + blank name/host → invalid.
		expect(
			await machinesCreateFn({ data: { name: "x", host: "h", secretRef: "vault:abc" } }),
		).toEqual({ ok: false });
		expect(await machinesUpdateFn({ data: { id: 1, secretRef: "vault:" } })).toEqual({
			ok: false,
		});
	});

	it("machinesApi delegates to the server fns", async () => {
		currentEmail = ADMIN;
		const created = await machinesApi.create({ name: "via-api", host: "api.local" });
		expect(created.ok).toBe(true);
		const id = created.data?.id;
		expect(id).toBeTypeOf("number");
		expect((await machinesApi.update({ id: id!, name: "via-api-2" })).ok).toBe(true);
		expect((await machinesApi.check(id!)).ok).toBe(true);
		expect((await machinesApi.checkAll()).ok).toBe(true);
		expect((await machinesApi.beat(id!)).ok).toBe(true);
		expect((await machinesApi.remove(id!)).ok).toBe(true);
	});
});
