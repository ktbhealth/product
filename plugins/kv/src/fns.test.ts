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

import { KvAdmin, KvAdminLive, type KvAdminShape } from "./admin.ts";
import { kvDeleteFn, kvGetFn, kvListFn, kvNamespacesFn, kvSetFn } from "./fns.ts";

describe("kv fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));
	const installRuntime = (rt: ManagedRuntime.ManagedRuntime<unknown, never>) =>
		installServerFnRuntime(rt, auth);

	beforeAll(async () => {
		const db = makeDb(makeTestD1());
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(
			Layer.mergeAll(KvAdminLive.pipe(Layer.provide(env)), env) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		installRuntime(runtime);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers on every fn", async () => {
		currentEmail = null;
		await expect(kvListFn()).rejects.toThrow("unauthenticated");
		await expect(kvNamespacesFn()).rejects.toThrow("unauthenticated");
		await expect(kvGetFn({ data: { namespace: "a", key: "k" } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(kvSetFn({ data: { namespace: "a", key: "k", valueJson: "1" } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(kvDeleteFn({ data: { namespace: "a", key: "k" } })).rejects.toThrow(
			"unauthenticated",
		);
	});

	it("rejects every fn when the plugin package is disabled", async () => {
		currentEmail = "admin@x.com";
		installServerFnRuntime(runtime, auth, { pluginEnabled: async () => false });
		try {
			await expect(kvListFn()).rejects.toThrow('plugin "kv.admin.services" is disabled');
			await expect(kvNamespacesFn()).rejects.toThrow('plugin "kv.admin.services" is disabled');
			await expect(kvGetFn({ data: { namespace: "a", key: "k" } })).rejects.toThrow(
				'plugin "kv.admin.services" is disabled',
			);
			await expect(kvSetFn({ data: { namespace: "a", key: "k", valueJson: "1" } })).rejects.toThrow(
				'plugin "kv.admin.services" is disabled',
			);
			await expect(kvDeleteFn({ data: { namespace: "a", key: "k" } })).rejects.toThrow(
				'plugin "kv.admin.services" is disabled',
			);
		} finally {
			installRuntime(runtime);
		}
	});

	it("denies non-admin principals with the documented empty results", async () => {
		currentEmail = "doc@x.com";
		await expect(kvListFn()).resolves.toBeNull();
		await expect(kvNamespacesFn()).resolves.toBeNull();
		await expect(kvGetFn({ data: { namespace: "a", key: "k" } })).resolves.toBeNull();
		await expect(kvSetFn({ data: { namespace: "a", key: "k", valueJson: "1" } })).resolves.toEqual({
			ok: false,
			reason: "forbidden",
		});
		await expect(kvDeleteFn({ data: { namespace: "a", key: "k" } })).resolves.toBe(false);
	});

	it("creates, reads, updates with CAS and deletes as admin", async () => {
		currentEmail = "admin@x.com";
		const created = await kvSetFn({
			data: {
				namespace: "ns",
				key: "k1",
				valueJson: '{"a":1}',
				tenantId: "3",
				ownerId: null,
				ttlMs: null,
			},
		});
		expect(created).toMatchObject({
			ok: true,
			entry: {
				namespace: "ns",
				key: "k1",
				tenantId: 3,
				ownerId: null,
				version: 1,
				expiresAt: null,
				expired: false,
			},
		});
		expect((created as { entry: { value: unknown } }).entry.value).toEqual({ a: 1 });

		const got = await kvGetFn({
			data: { namespace: "ns", key: "k1", tenantId: 3 },
		});
		expect(got).toMatchObject({ key: "k1", tenantId: 3, version: 1 });
		await expect(kvGetFn({ data: { namespace: "ns", key: "missing" } })).resolves.toBeNull();

		const list = await kvListFn({ data: { namespace: "ns" } });
		expect(list).toMatchObject({ total: 1 });
		expect(list?.items[0]?.key).toBe("k1");
		const filtered = await kvListFn({ data: { prefix: "k" } });
		expect(filtered?.total).toBeGreaterThanOrEqual(1);
		const namespaces = await kvNamespacesFn();
		expect(namespaces).toContainEqual({ namespace: "ns", count: 1 });

		const updated = await kvSetFn({
			data: {
				namespace: "ns",
				key: "k1",
				tenantId: 3,
				valueJson: "42",
				expectedVersion: 1,
			},
		});
		expect(updated).toMatchObject({ ok: true, entry: { version: 2, value: 42 } });

		const conflict = await kvSetFn({
			data: {
				namespace: "ns",
				key: "k1",
				tenantId: 3,
				valueJson: "43",
				expectedVersion: 1,
			},
		});
		expect(conflict).toEqual({ ok: false, reason: "conflict", actualVersion: 2 });

		const notfound = await kvSetFn({
			data: {
				namespace: "ns",
				key: "ghost",
				valueJson: "1",
				expectedVersion: 1,
			},
		});
		expect(notfound).toEqual({ ok: false, reason: "notfound" });

		const invalid = await kvSetFn({
			data: { namespace: "", key: "k", valueJson: "1" },
		});
		expect(invalid).toEqual({ ok: false, reason: "invalid" });

		const badJson = await kvSetFn({
			data: { namespace: "ns", key: "k2", valueJson: "{oops" },
		});
		expect(badJson).toEqual({ ok: false, reason: "invalid" });

		expect(await kvDeleteFn({ data: { namespace: "ns", key: "k1", tenantId: 3 } })).toBe(true);
		expect(await kvDeleteFn({ data: { namespace: "ns", key: "k1", tenantId: 3 } })).toBe(false);
	});

	it("validates wire input before the handler runs", async () => {
		currentEmail = "admin@x.com";
		await expect(kvListFn({ data: { limit: "x" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(kvGetFn({ data: { namespace: "a" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(kvSetFn({ data: { namespace: "a", key: "k" } } as never)).rejects.toBeInstanceOf(
			Error,
		);
		await expect(
			kvSetFn({
				data: { namespace: "a", key: "k", valueJson: "1", tenantId: {} },
			} as never),
		).rejects.toBeInstanceOf(Error);
		await expect(kvDeleteFn({ data: {} } as never)).rejects.toBeInstanceOf(Error);
	});

	it("maps service validation errors on reads to null", async () => {
		currentEmail = "admin@x.com";
		// Over-long prefix trips KvValidationError inside the service.
		const long = "x".repeat(201);
		await expect(kvListFn({ data: { prefix: long } })).resolves.toBeNull();
		await expect(kvGetFn({ data: { namespace: "a".repeat(201), key: "k" } })).resolves.toBeNull();
		await expect(kvDeleteFn({ data: { namespace: "a".repeat(201), key: "k" } })).resolves.toBe(
			false,
		);
	});

	it("propagates unexpected service errors instead of mapping them", async () => {
		// Deliberately mistyped failures — the mocks exercise the fns'
		// rethrow paths, so the shape is cast rather than satisfying
		// KvAdminError (which would collapse to handled results).
		const stubAdmin = (impl: object = {}): KvAdminShape =>
			({
				list: () => Effect.fail({ _tag: "Other" }),
				namespaces: () => Effect.fail({ _tag: "Other" }),
				get: () => Effect.fail({ _tag: "Other" }),
				set: () => Effect.fail({ _tag: "Other" }),
				remove: () => Effect.fail({ _tag: "Other" }),
				...impl,
			}) as unknown as KvAdminShape;
		const mkRuntime = (admin: KvAdminShape) =>
			ManagedRuntime.make(
				Layer.mergeAll(
					Layer.succeed(
						PlatformAdmin,
						makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
					),
					Layer.succeed(KvAdmin, KvAdmin.of(admin)),
				) as Layer.Layer<unknown, never, never>,
			);

		// Tagged but unhandled error → propagates through every fn.
		let rt = mkRuntime(stubAdmin({}));
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			await expect(kvListFn()).rejects.toMatchObject({ _tag: "Other" });
			await expect(kvNamespacesFn()).rejects.toMatchObject({ _tag: "Other" });
			await expect(kvGetFn({ data: { namespace: "a", key: "k" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(
				kvSetFn({ data: { namespace: "a", key: "k", valueJson: "1" } }),
			).rejects.toMatchObject({ _tag: "Other" });
			await expect(kvDeleteFn({ data: { namespace: "a", key: "k" } })).rejects.toMatchObject({
				_tag: "Other",
			});
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}

		// Untagged / non-object failures hit the catch's rethrow path.
		rt = mkRuntime(
			stubAdmin({
				list: () => Effect.fail("plain list failure"),
				namespaces: () => Effect.fail(new Error("plain ns failure")),
				get: () => Effect.fail(new Error("plain get failure")),
				set: () => Effect.fail(new Error("plain set failure")),
				remove: () => Effect.fail("plain delete failure"),
			}),
		);
		installRuntime(rt);
		try {
			await expect(kvListFn()).rejects.toBe("plain list failure");
			await expect(kvNamespacesFn()).rejects.toThrow("plain ns failure");
			await expect(kvGetFn({ data: { namespace: "a", key: "k" } })).rejects.toThrow(
				"plain get failure",
			);
			await expect(kvSetFn({ data: { namespace: "a", key: "k", valueJson: "1" } })).rejects.toThrow(
				"plain set failure",
			);
			const delError = await kvDeleteFn({ data: { namespace: "a", key: "k" } }).catch(
				(e: unknown) => e,
			);
			expect(delError).toBe("plain delete failure");
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});

	it("still validates scope coercions end-to-end", async () => {
		currentEmail = "admin@x.com";
		// Numeric-string tenant ids normalize inside the service.
		const res = await kvSetFn({
			data: {
				namespace: "coerce",
				key: "k",
				tenantId: "8",
				valueJson: "1",
			},
		});
		expect(res).toMatchObject({ ok: true, entry: { tenantId: 8 } });
		// Non-numeric tenant id → service validation → invalid.
		const bad = await kvSetFn({
			data: { namespace: "coerce", key: "k2", tenantId: "abc", valueJson: "1" },
		});
		expect(bad).toEqual({ ok: false, reason: "invalid" });
	});
});
