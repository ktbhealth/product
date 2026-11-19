import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartServerMock,
	serverFnRequestHeaders,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Auth } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import type { ServerRuntime } from "@ktb/server-fns";

import { Route as AssetsRoute } from "./api-routes/theme.assets.ts";
import { Route as FontsRoute } from "./api-routes/theme.fonts.ts";

const handlersOf = (r: unknown) =>
	(
		r as {
			options: {
				server: { handlers: Record<string, (a: never) => Promise<Response>> };
			};
		}
	).options.server.handlers;

const DDL = `
CREATE TABLE theme_assets (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	theme_id integer,
	kind text NOT NULL,
	r2_key text,
	status text DEFAULT 'pending' NOT NULL,
	variants text,
	created_at integer NOT NULL,
	FOREIGN KEY (theme_id) REFERENCES theme_definitions(id) ON UPDATE no action ON DELETE set null
);
CREATE TABLE theme_definitions (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	scope text NOT NULL,
	scope_id text DEFAULT '' NOT NULL,
	app_name text,
	seeds text NOT NULL,
	tokens text NOT NULL,
	fonts text,
	brand text,
	enabled integer DEFAULT true NOT NULL,
	version integer DEFAULT 1 NOT NULL,
	created_at integer NOT NULL,
	updated_at integer
);
INSERT INTO theme_definitions (scope, scope_id, seeds, tokens, created_at)
	VALUES ('platform', '', '{}', '{}', 0);
`;

const USERS = new Map([
	["admin", { id: "u-admin", email: "admin@x.com", name: "Admin" }],
	["plain", { id: "u-plain", email: "plain@x.com", name: "Plain" }],
]);

/** Cookie "session=<key>" authenticates as USERS[key]; else anonymous. */
const authStub = Auth.of({
	setUserBanned: async () => {},
	updateUser: async () => ({ ok: true as const }),
	deleteUser: async () => {},
	getSession: async (h: Headers) => {
		const key = /session=([^;]+)/.exec(h.get("cookie") ?? "")?.[1];
		const user = key ? USERS.get(key) : undefined;
		if (!user) return null;
		return {
			user,
			sessionId: `sess-${key}`,
			expiresAt: new Date(Date.now() + 3_600_000),
		};
	},
} as never);

const db = makeDb(makeD1(DDL));

const infra = Layer.mergeAll(
	Layer.succeed(Db, db),
	Layer.succeed(Auth, authStub),
	Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
);

const runtime = ManagedRuntime.make(infra as Layer.Layer<unknown, never, never>);

// Edge-case runtimes: missing Db (repo reads reject), a dying admin
// gate (isAdmin catch paths) and a Db whose inserts yield no rows.
const runtimeNoDb = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.succeed(Auth, authStub),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
	) as Layer.Layer<unknown, never, never>,
);

const runtimeGateDown = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(Auth, authStub),
		Layer.succeed(PlatformAdmin, {
			isAdmin: () => Effect.die(new Error("gate down")),
			requireAdmin: () => Effect.die(new Error("gate down")),
		} as never),
	) as Layer.Layer<unknown, never, never>,
);

const fakeDb = {
	select: () => ({
		from: () => ({ where: () => ({ limit: async () => [{ id: 1 }] }) }),
	}),
	insert: () => ({ values: () => ({ returning: async () => [] }) }),
} as unknown as DbClient;

const runtimeFakeDb = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.succeed(Db, fakeDb),
		Layer.succeed(Auth, authStub),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
	) as Layer.Layer<unknown, never, never>,
);

// Insert path rejects outright — exercises `.catch(() => null)` guards.
const throwDb = {
	select: fakeDb.select,
	insert: () => ({
		values: () => ({
			returning: async () => {
				throw new Error("insert boom");
			},
		}),
	}),
} as unknown as DbClient;

const runtimeThrowDb = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.succeed(Db, throwDb),
		Layer.succeed(Auth, authStub),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
	) as Layer.Layer<unknown, never, never>,
);

const runAsOn =
	(rt: ManagedRuntime.ManagedRuntime<unknown, never>): ServerRuntime["runAs"] =>
	<A, E>(
		user: { readonly id: string; readonly email?: string; readonly actorId?: string },
		effect: Effect.Effect<A, E, unknown>,
	) =>
		rt.runPromise(
			effect.pipe(
				Effect.provideService(Principal, {
					userId: user.id,
					email: user.email,
				}),
			) as never,
		) as Promise<A>;

afterAll(async () => {
	await Promise.all([
		runtime.dispose(),
		runtimeNoDb.dispose(),
		runtimeGateDown.dispose(),
		runtimeFakeDb.dispose(),
		runtimeThrowDb.dispose(),
	]);
});

// In-memory R2/queue doubles — same shapes as the apps/web test env.
const bucketStore = new Map<string, { data: Uint8Array; contentType?: string }>();
const jobsSent: { kind: string; payload: unknown; options?: unknown }[] = [];
let enqueueFails = false;

const fakeBucket = {
	put: async (
		key: string,
		value: ArrayBuffer | Uint8Array | ReadableStream,
		options?: { httpMetadata?: { contentType?: string } },
	) => {
		const data =
			value instanceof Uint8Array
				? value
				: value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(await new Response(value).arrayBuffer());
		bucketStore.set(key, {
			data,
			contentType: options?.httpMetadata?.contentType,
		});
		return {};
	},
	get: async (key: string) => {
		const object = bucketStore.get(key);
		if (!object) return null;
		const { data, contentType } = object;
		const bytes = data.slice();
		return {
			key,
			size: bytes.byteLength,
			httpMetadata: { contentType },
			body: new Response(bytes).body!,
		};
	},
	delete: async () => {},
};

const useSession = (key: string) => {
	serverFnRequestHeaders.current = new Headers({ cookie: `session=${key}` });
};

const runtimeOverrides: Partial<ServerRuntime> = {
	themeAssets: fakeBucket,
	themeJobs: {
		enqueue: async (kind: string, payload: unknown, options?: unknown) => {
			if (enqueueFails) throw new Error("queue down");
			jobsSent.push({ kind, payload, options });
			return { id: "env-1" };
		},
	},
	pluginEnabled: async () => true,
};

const publishRuntime = () => installServerFnRuntime(runtime, authStub, runtimeOverrides);

beforeAll(() => {
	publishRuntime();
});

/** Swap the published runtime for edge-case tests; restores base. */
const withRuntime = async <T>(patch: Partial<ServerRuntime>, fn: () => Promise<T>) => {
	installServerFnRuntime(runtime, authStub, { ...runtimeOverrides, ...patch });
	try {
		return await fn();
	} finally {
		publishRuntime();
	}
};

const postAsset = (fields: Record<string, string>, file?: File) => {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	if (file !== undefined) form.set("file", file);
	return handlersOf(AssetsRoute).POST!({
		request: new Request("http://x/api/theme/assets", {
			method: "POST",
			body: form,
		}),
	} as never);
};

const png = () =>
	new File([new Uint8Array([137, 80, 78, 71])], "logo.png", {
		type: "image/png",
	});

describe("POST /api/theme/assets", () => {
	it("rejects anonymous and non-admin callers", async () => {
		serverFnRequestHeaders.current = new Headers();
		expect((await postAsset({ themeId: "1", kind: "favicon" }, png())).status).toBe(401);
		useSession("plain");
		expect((await postAsset({ themeId: "1", kind: "favicon" }, png())).status).toBe(403);
		useSession("admin");
	});

	it("rejects non-multipart, bad kind/themeId and missing file", async () => {
		const json = await handlersOf(AssetsRoute).POST!({
			request: new Request("http://x/api/theme/assets", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		} as never);
		expect(json.status).toBe(400);
		expect((await postAsset({ themeId: "1", kind: "nope" }, png())).status).toBe(400);
		expect((await postAsset({ themeId: "abc", kind: "favicon" }, png())).status).toBe(400);
		expect((await postAsset({ themeId: "1", kind: "favicon" })).status).toBe(400);
	});

	it("404s when the theme row does not exist", async () => {
		expect((await postAsset({ themeId: "999", kind: "favicon" }, png())).status).toBe(404);
	});

	it("rejects unsupported extensions, MIME mismatches and oversize files", async () => {
		const txt = new File([new Uint8Array([1])], "x.txt", {
			type: "text/plain",
		});
		expect((await postAsset({ themeId: "1", kind: "favicon" }, txt)).status).toBe(415);
		const html = new File([new Uint8Array([1])], "x.png", {
			type: "text/html",
		});
		expect((await postAsset({ themeId: "1", kind: "favicon" }, html)).status).toBe(415);
		const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", {
			type: "image/png",
		});
		expect((await postAsset({ themeId: "1", kind: "favicon" }, big)).status).toBe(413);
		const empty = new File([], "e.png", { type: "image/png" });
		expect((await postAsset({ themeId: "1", kind: "favicon" }, empty)).status).toBe(400);
	});

	it("stores the original, records a pending asset and enqueues theme.asset", async () => {
		jobsSent.length = 0;
		const res = await postAsset({ themeId: "1", kind: "favicon" }, png());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			assetId: number;
			status: string;
		};
		expect(body).toMatchObject({ ok: true, status: "queued" });
		expect(jobsSent).toHaveLength(1);
		expect(jobsSent[0]!.kind).toBe("theme.asset");
		expect(jobsSent[0]!.payload).toMatchObject({
			assetId: body.assetId,
			themeId: 1,
			kind: "favicon",
		});
		const key = (jobsSent[0]!.payload as { key: string }).key;
		expect(key.startsWith("theme-assets/1/favicon/")).toBe(true);
		expect(bucketStore.has(key)).toBe(true);
	});

	it("enqueues theme.font for font uploads with family/slot", async () => {
		jobsSent.length = 0;
		const woff2 = new File([new Uint8Array([0x77, 0x4f, 0x46, 0x32])], "Inter.woff2", {
			type: "font/woff2",
		});
		const res = await postAsset(
			{ themeId: "1", kind: "font", family: "Inter", slot: "sans" },
			woff2,
		);
		expect(res.status).toBe(200);
		expect(jobsSent[0]!.kind).toBe("theme.font");
		expect(jobsSent[0]!.payload).toMatchObject({
			source: "upload",
			family: "Inter",
			slot: "sans",
			format: "woff2",
		});
	});

	it("requires a family for font uploads", async () => {
		const woff2 = new File([new Uint8Array([1])], "x.woff2", {
			type: "font/woff2",
		});
		expect((await postAsset({ themeId: "1", kind: "font" }, woff2)).status).toBe(400);
	});
});

describe("GET /api/theme/assets", () => {
	const get = (query: string) =>
		handlersOf(AssetsRoute).GET!({
			request: new Request(`http://x/api/theme/assets?${query}`),
		} as never);

	it("404s keys outside the theme-assets prefix or with traversal", async () => {
		expect((await get("key=other/x.png")).status).toBe(404);
		expect((await get("key=theme-assets/../secret")).status).toBe(404);
		expect((await get("key=theme-assets/%00")).status).toBe(404);
		expect((await get("")).status).toBe(404);
	});

	it("streams stored objects with immutable caching", async () => {
		bucketStore.set("theme-assets/1/favicon/x.png", {
			data: new Uint8Array([1, 2, 3]),
			contentType: "image/png",
		});
		const res = await get("key=theme-assets%2F1%2Ffavicon%2Fx.png");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toContain("immutable");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect((await get("key=theme-assets%2F1%2Fmissing.png")).status).toBe(404);
	});
});

describe("POST /api/theme/fonts", () => {
	const post = (body: unknown) =>
		handlersOf(FontsRoute).POST!({
			request: new Request("http://x/api/theme/fonts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		} as never);

	it("rejects anonymous, non-admin, bad JSON and bad bodies", async () => {
		serverFnRequestHeaders.current = new Headers();
		expect((await post({ themeId: 1, family: "Inter" })).status).toBe(401);
		useSession("plain");
		expect((await post({ themeId: 1, family: "Inter" })).status).toBe(403);
		useSession("admin");
		expect(
			(
				await handlersOf(FontsRoute).POST!({
					request: new Request("http://x/api/theme/fonts", {
						method: "POST",
						body: "{",
					}),
				} as never)
			).status,
		).toBe(400);
		expect((await post({ themeId: "x", family: "Inter" })).status).toBe(400);
		expect((await post({ themeId: 1, family: "" })).status).toBe(400);
		expect((await post({ themeId: 1, family: "Inter", slot: "bogus" })).status).toBe(400);
		expect((await post({ themeId: 1, family: "Inter", weights: [50] })).status).toBe(400);
		expect((await post({ themeId: 999, family: "Inter" })).status).toBe(404);
	});

	it("enqueues a google-source theme.font job", async () => {
		jobsSent.length = 0;
		const res = await post({
			themeId: 1,
			family: "Open Sans",
			slot: "heading",
			weights: [400, 700],
		});
		expect(res.status).toBe(200);
		expect(jobsSent).toHaveLength(1);
		expect(jobsSent[0]).toMatchObject({
			kind: "theme.font",
			payload: {
				source: "google",
				family: "Open Sans",
				slot: "heading",
				weights: [400, 700],
			},
		});
	});
});

describe("POST /api/theme/assets — edge branches", () => {
	it("400s when content-type is absent entirely", async () => {
		useSession("admin");
		const res = await handlersOf(AssetsRoute).POST!({
			request: new Request("http://x/api/theme/assets", { method: "POST" }),
		} as never);
		expect(res.status).toBe(400);
	});

	it("400s when the kind field is missing", async () => {
		useSession("admin");
		const form = new FormData();
		form.set("file", png());
		form.set("themeId", "1");
		const res = await handlersOf(AssetsRoute).POST!({
			request: new Request("http://x/api/theme/assets", {
				method: "POST",
				body: form,
			}),
		} as never);
		expect(res.status).toBe(400);
	});

	it("415s on nameless/dotless files and non-font MIME on font uploads", async () => {
		useSession("admin");
		// Dotless name → empty extension → 415.
		const dotless = new File([new Uint8Array([1])], "logo", {
			type: "image/png",
		});
		expect((await postAsset({ themeId: "1", kind: "favicon" }, dotless)).status).toBe(415);
		// Font kind with an image MIME → 415.
		const wrongMime = new File([new Uint8Array([1, 2])], "x.woff2", {
			type: "image/png",
		});
		expect((await postAsset({ themeId: "1", kind: "font", family: "F" }, wrongMime)).status).toBe(
			415,
		);
		// Untyped/unknown-extension file skips the MIME cross-check and
		// succeeds; an unrecognized extension still 415s after the MIME
		// probe (covers the empty-type fallback).
		const untyped = new File([new Uint8Array([1, 2])], "x.woff2");
		const res = await postAsset(
			{ themeId: "1", kind: "font", family: "F", slot: "bogus" },
			untyped,
		);
		expect(res.status).toBe(200);
		expect(jobsSent.at(-1)!.payload).toMatchObject({ slot: "sans" });
		const unknownExt = new File([new Uint8Array([1])], "x.ktbext");
		expect((await postAsset({ themeId: "1", kind: "font", family: "F" }, unknownExt)).status).toBe(
			415,
		);
	});

	it("502s when the enqueue fails", async () => {
		useSession("admin");
		enqueueFails = true;
		try {
			const res = await postAsset({ themeId: "1", kind: "favicon" }, png());
			expect(res.status).toBe(502);
		} finally {
			enqueueFails = false;
		}
	});

	it("503s when bucket/queue bindings are missing", async () => {
		useSession("admin");
		// Bucket present, queue missing → right side of the guard.
		await withRuntime({ themeJobs: undefined }, async () => {
			expect((await postAsset({ themeId: "1", kind: "favicon" }, png())).status).toBe(503);
		});
		// Neither bound → left side.
		await withRuntime({ themeAssets: undefined, themeJobs: undefined }, async () => {
			expect((await postAsset({ themeId: "1", kind: "favicon" }, png())).status).toBe(503);
		});
	});

	it("500s when the asset row cannot be recorded", async () => {
		useSession("admin");
		await withRuntime({ runAs: runAsOn(runtimeFakeDb) }, async () => {
			expect((await postAsset({ themeId: "1", kind: "favicon" }, png())).status).toBe(500);
		});
	});

	it("404s the theme lookup when Db is unavailable and 403s when the gate dies", async () => {
		useSession("admin");
		await withRuntime({ runAs: runAsOn(runtimeNoDb) }, async () => {
			expect((await postAsset({ themeId: "1", kind: "favicon" }, png())).status).toBe(404);
		});
		await withRuntime({ runAs: runAsOn(runtimeGateDown) }, async () => {
			expect((await postAsset({ themeId: "1", kind: "favicon" }, png())).status).toBe(403);
		});
	});
});

describe("GET /api/theme/assets — edge branches", () => {
	const get = (query: string) =>
		handlersOf(AssetsRoute).GET!({
			request: new Request(`http://x/api/theme/assets?${query}`),
		} as never);

	it("503s when the bucket binding is missing", async () => {
		await withRuntime({ themeAssets: undefined }, async () => {
			expect((await get("key=theme-assets%2F1%2Fx.png")).status).toBe(503);
		});
	});

	it("falls back to the key-derived content type", async () => {
		bucketStore.set("theme-assets/1/font/x.woff2", {
			data: new Uint8Array([1]),
		});
		const res = await get("key=theme-assets%2F1%2Ffont%2Fx.woff2");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("font/woff2");
	});
});

describe("POST /api/theme/fonts — edge branches", () => {
	const post = (body: unknown) =>
		handlersOf(FontsRoute).POST!({
			request: new Request("http://x/api/theme/fonts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		} as never);

	it("403s when the admin gate fails", async () => {
		useSession("admin");
		await withRuntime({ runAs: runAsOn(runtimeGateDown) }, async () => {
			expect((await post({ themeId: 1, family: "Inter" })).status).toBe(403);
		});
	});

	it("404s when the theme lookup itself fails", async () => {
		useSession("admin");
		await withRuntime({ runAs: runAsOn(runtimeNoDb) }, async () => {
			expect((await post({ themeId: 1, family: "Inter" })).status).toBe(404);
		});
	});

	it("503s when the job queue is not configured", async () => {
		useSession("admin");
		await withRuntime({ themeJobs: undefined }, async () => {
			expect((await post({ themeId: 1, family: "Inter" })).status).toBe(503);
		});
	});

	it("500s when the asset row cannot be recorded", async () => {
		useSession("admin");
		await withRuntime({ runAs: runAsOn(runtimeFakeDb) }, async () => {
			expect((await post({ themeId: 1, family: "Inter" })).status).toBe(500);
		});
		// Insert rejection → caught → same 500.
		await withRuntime({ runAs: runAsOn(runtimeThrowDb) }, async () => {
			expect((await post({ themeId: 1, family: "Inter" })).status).toBe(500);
		});
	});

	it("502s when the enqueue fails", async () => {
		useSession("admin");
		enqueueFails = true;
		try {
			expect((await post({ themeId: 1, family: "Inter" })).status).toBe(502);
		} finally {
			enqueueFails = false;
		}
	});
});
