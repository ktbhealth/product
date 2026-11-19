import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { themeAssets } from "@ktb/db/schema";
import { Fonts } from "@ktb/fonts";
import type { FontFamilySummary, FontProviderSummary } from "@ktb/fonts/types";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import type { ServerRuntime } from "@ktb/server-fns";

import { Route as AssetsRoute } from "./api-routes/theme.assets.ts";
import { Route as CatalogFontsRoute } from "./api-routes/theme.catalog-fonts.ts";
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
	is_main integer DEFAULT false NOT NULL,
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

// ---------- fonts-catalog route: Fonts service stub ----------

const fontsState = {
	providers: [] as FontProviderSummary[],
	nextProviderId: 1,
	syncFamilies: [] as FontFamilySummary[],
	syncFails: false,
	listFails: false,
};

const fontProvider = (over: Partial<FontProviderSummary> = {}): FontProviderSummary => ({
	id: fontsState.nextProviderId++,
	kind: "local",
	name: "Local",
	config: null,
	enabled: true,
	familyCount: 0,
	createdAt: "2025-01-01T00:00:00.000Z",
	updatedAt: null,
	...over,
});

const fontFamily = (over: Partial<FontFamilySummary> = {}): FontFamilySummary => ({
	id: 1,
	providerId: 1,
	family: "Inter",
	weights: [],
	status: "ready",
	meta: { source: "local", assetId: 1 },
	...over,
});

const fontsStub = {
	listProviders: () =>
		fontsState.listFails
			? Effect.die(new Error("fonts down"))
			: Effect.succeed(fontsState.providers),
	providerKinds: () => Effect.succeed(["local", "googlefonts"]),
	createProvider: (input: { kind: string; name: string }) =>
		Effect.sync(() => {
			const created = fontProvider({ kind: input.kind, name: input.name });
			fontsState.providers.push(created);
			return created;
		}),
	updateProvider: () => Effect.die(new Error("unused")),
	setProviderEnabled: () => Effect.void,
	removeProvider: () => Effect.void,
	listFamilies: () => Effect.succeed(fontsState.syncFamilies),
	syncProvider: () =>
		fontsState.syncFails
			? Effect.die(new Error("sync boom"))
			: Effect.succeed(fontsState.syncFamilies),
} as unknown as Fonts["Service"];

const runtimeCatalog = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(Auth, authStub),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		Layer.succeed(Fonts, fontsStub),
	) as Layer.Layer<unknown, never, never>,
);

// Same but the fonts service dies on every call — provider resolution
// catch path.
const fontsDownStub = {
	...fontsStub,
	listProviders: () => Effect.die(new Error("fonts down")),
} as unknown as Fonts["Service"];

const runtimeFontsDown = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(Auth, authStub),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		Layer.succeed(Fonts, fontsDownStub),
	) as Layer.Layer<unknown, never, never>,
);

// Db whose unowned-asset select yields [] but whose catalog insert
// returns no row — exercises the asset-null defect path.
const catalogFakeDb = {
	select: () => ({
		from: () => ({
			where: () => ({ orderBy: async () => [] }),
		}),
	}),
	insert: () => ({ values: () => ({ returning: async () => [] }) }),
} as unknown as DbClient;

const runtimeCatalogFakeDb = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.succeed(Db, catalogFakeDb),
		Layer.succeed(Auth, authStub),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		Layer.succeed(Fonts, fontsStub),
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
		runtimeCatalog.dispose(),
		runtimeFontsDown.dispose(),
		runtimeCatalogFakeDb.dispose(),
	]);
});

// In-memory R2/queue doubles — same shapes as the apps/web test env.
const bucketStore = new Map<string, { data: Uint8Array; contentType?: string }>();
const jobsSent: { kind: string; payload: unknown; options?: unknown }[] = [];
let enqueueFails = false;
let bucketDeleteFails = false;

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
	delete: async (keys: string[]) => {
		if (bucketDeleteFails) throw new Error("delete boom");
		for (const key of keys) bucketStore.delete(key);
	},
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

describe("POST /api/theme/catalog-fonts", () => {
	const postCatalog = (fields: Record<string, string>, file?: File) => {
		const form = new FormData();
		for (const [k, v] of Object.entries(fields)) form.set(k, v);
		if (file !== undefined) form.set("file", file);
		return handlersOf(CatalogFontsRoute).POST!({
			request: new Request("http://x/api/theme/catalog-fonts", {
				method: "POST",
				body: form,
			}),
		} as never);
	};

	const woff2 = () =>
		new File([new Uint8Array([0x77, 0x4f, 0x46, 0x32])], "Inter.woff2", {
			type: "font/woff2",
		});

	const withCatalogRuntime = <T>(fn: () => Promise<T>) =>
		withRuntime({ runAs: runAsOn(runtimeCatalog) }, fn);

	beforeEach(() => {
		fontsState.providers = [];
		fontsState.nextProviderId = 1;
		fontsState.syncFamilies = [];
		fontsState.syncFails = false;
		fontsState.listFails = false;
		bucketStore.clear();
		jobsSent.length = 0;
		bucketDeleteFails = false;
	});

	it("rejects anonymous and non-admin callers", async () => {
		serverFnRequestHeaders.current = new Headers();
		expect((await postCatalog({ family: "Inter" }, woff2())).status).toBe(401);
		useSession("plain");
		expect((await postCatalog({ family: "Inter" }, woff2())).status).toBe(403);
		useSession("admin");
	});

	it("rejects non-multipart, missing file/family and bad fields", async () => {
		useSession("admin");
		const json = await handlersOf(CatalogFontsRoute).POST!({
			request: new Request("http://x/api/theme/catalog-fonts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		} as never);
		expect(json.status).toBe(400);
		expect((await postCatalog({ family: "Inter" })).status).toBe(400);
		expect((await postCatalog({}, woff2())).status).toBe(400);
		expect((await postCatalog({ family: "Inter", weight: "abc" }, woff2())).status).toBe(400);
		expect((await postCatalog({ family: "Inter", weight: "50" }, woff2())).status).toBe(400);
		expect((await postCatalog({ family: "Inter", weight: "1000" }, woff2())).status).toBe(400);
		expect((await postCatalog({ family: "Inter", weight: "400-abc" }, woff2())).status).toBe(400);
		expect((await postCatalog({ family: "Inter", weight: "700-400" }, woff2())).status).toBe(400);
		expect((await postCatalog({ family: "Inter", weights: "bold" }, woff2())).status).toBe(400);
		expect((await postCatalog({ family: "Inter", providerId: "x" }, woff2())).status).toBe(400);
		expect((await postCatalog({ family: "Inter", providerId: "0" }, woff2())).status).toBe(400);
		// No content-type header at all → the "" fallback → 400.
		const noCt = await handlersOf(CatalogFontsRoute).POST!({
			request: new Request("http://x/api/theme/catalog-fonts", { method: "POST" }),
		} as never);
		expect(noCt.status).toBe(400);
	});

	it("rejects unsupported extensions, MIME mismatches, oversize and empty files", async () => {
		useSession("admin");
		const txt = new File([new Uint8Array([1])], "x.txt", { type: "text/plain" });
		expect((await postCatalog({ family: "Inter" }, txt)).status).toBe(415);
		const wrongMime = new File([new Uint8Array([1])], "x.woff2", { type: "image/png" });
		expect((await postCatalog({ family: "Inter" }, wrongMime)).status).toBe(415);
		const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.woff2", {
			type: "font/woff2",
		});
		expect((await postCatalog({ family: "Inter" }, big)).status).toBe(413);
		const empty = new File([], "e.woff2", { type: "font/woff2" });
		expect((await postCatalog({ family: "Inter" }, empty)).status).toBe(400);
		// Dotless name → empty extension → 415.
		const dotless = new File([new Uint8Array([1])], "fontfile", { type: "font/woff2" });
		expect((await postCatalog({ family: "Inter" }, dotless)).status).toBe(415);
	});

	it("503s when the bucket binding or the fonts service is missing", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			await withRuntime({ themeAssets: undefined }, async () => {
				expect((await postCatalog({ family: "Inter" }, woff2())).status).toBe(503);
			});
		});
		// Base runtime has no Fonts service → provider resolution 503s.
		expect((await postCatalog({ family: "Inter" }, woff2())).status).toBe(503);
	});

	it("403s when the admin gate dies", async () => {
		useSession("admin");
		await withRuntime({ runAs: runAsOn(runtimeGateDown) }, async () => {
			expect((await postCatalog({ family: "Inter" }, woff2())).status).toBe(403);
		});
	});

	it("404s/400s on explicit providerId resolution", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.providers = [
				fontProvider({ id: 5, kind: "googlefonts", name: "Google" }),
				fontProvider({ id: 6, kind: "local", name: "Local" }),
			];
			expect((await postCatalog({ family: "Inter", providerId: "99" }, woff2())).status).toBe(404);
			expect((await postCatalog({ family: "Inter", providerId: "5" }, woff2())).status).toBe(400);
			// Explicit local provider wins over auto-selection.
			fontsState.syncFamilies = [fontFamily({ providerId: 6 })];
			const res = await postCatalog({ family: "Inter", providerId: "6" }, woff2());
			expect(res.status).toBe(200);
			expect(((await res.json()) as { providerId: number }).providerId).toBe(6);
		});
	});

	it("500s when provider resolution itself fails", async () => {
		useSession("admin");
		await withRuntime({ runAs: runAsOn(runtimeFontsDown) }, async () => {
			expect((await postCatalog({ family: "Inter" }, woff2())).status).toBe(500);
		});
	});

	it("auto-provisions a local provider and syncs the uploaded family", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.syncFamilies = [fontFamily({ providerId: 1, family: "Inter" })];
			const res = await postCatalog({ family: "Inter", weight: "700" }, woff2());
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				ok: boolean;
				assetId: number;
				providerId: number;
				family: string;
				status: string;
			};
			expect(body).toMatchObject({
				ok: true,
				providerId: 1,
				family: "Inter",
				status: "ready",
			});
			// The local provider was auto-created once.
			expect(fontsState.providers).toHaveLength(1);
			expect(fontsState.providers[0]).toMatchObject({ kind: "local", name: "Local" });
			// No queue round-trip — the row lands ready with the manifest.
			expect(jobsSent).toHaveLength(0);
			const rows = await db.select().from(themeAssets);
			const row = rows.find((r) => r.id === body.assetId);
			expect(row).toMatchObject({ themeId: null, kind: "font", status: "ready" });
			const variants = JSON.parse(row!.variants!);
			expect(variants.family).toBe("Inter");
			expect(variants.fontAsset.faces[0]).toMatchObject({ weight: 700, format: "woff2" });
			expect(bucketStore.has(row!.r2Key!)).toBe(true);
		});
	});

	it("accepts weight lists/ranges and mirrors them into variants.weights", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.syncFamilies = [fontFamily({ providerId: 1, family: "Inter" })];
			const res = await postCatalog({ family: "Inter", weight: "700,400" }, woff2());
			expect(res.status).toBe(200);
			const body = (await res.json()) as { assetId: number };
			const row = (await db.select().from(themeAssets)).find((r) => r.id === body.assetId);
			const variants = JSON.parse(row!.variants!);
			expect(variants.weights).toEqual([400, 700]);
			expect(variants.fontAsset.faces.map((f: { weight?: number }) => f.weight)).toEqual([
				400, 700,
			]);
		});
	});

	it("expands weight ranges and merges the weights alias", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.syncFamilies = [fontFamily({ providerId: 1, family: "Inter" })];
			const res = await postCatalog(
				{ family: "Inter", weight: "400-600", weights: "800" },
				woff2(),
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { assetId: number };
			const row = (await db.select().from(themeAssets)).find((r) => r.id === body.assetId);
			const variants = JSON.parse(row!.variants!);
			expect(variants.weights).toEqual([400, 500, 600, 800]);
		});
	});

	it("derives the weight from the file name when no weight field is sent", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.syncFamilies = [fontFamily({ providerId: 1, family: "Inter" })];
			const bold = new File([new Uint8Array([0x77, 0x4f, 0x46, 0x32])], "Inter-Bold.woff2", {
				type: "font/woff2",
			});
			const res = await postCatalog({ family: "Inter" }, bold);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { assetId: number };
			const row = (await db.select().from(themeAssets)).find((r) => r.id === body.assetId);
			const variants = JSON.parse(row!.variants!);
			expect(variants.weights).toEqual([700]);
			expect(variants.fontAsset.faces[0]).toMatchObject({ weight: 700 });
		});
	});

	it("prefers an enabled local provider and reports pending when sync misses", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.providers = [
				fontProvider({ id: 3, kind: "local", name: "Disabled Local", enabled: false }),
				fontProvider({ id: 4, kind: "local", name: "Local" }),
			];
			// syncFamilies empty → the family row is absent → "pending".
			const res = await postCatalog({ family: "Inter" }, woff2());
			expect(res.status).toBe(200);
			const body = (await res.json()) as { providerId: number; status: string };
			expect(body.providerId).toBe(4);
			expect(body.status).toBe("pending");
		});
	});

	it("falls back to a disabled local provider when it is the only one", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.providers = [
				fontProvider({ id: 9, kind: "local", name: "Local", enabled: false }),
			];
			fontsState.syncFamilies = [fontFamily({ providerId: 9 })];
			const res = await postCatalog({ family: "Inter" }, woff2());
			expect(res.status).toBe(200);
			expect(((await res.json()) as { providerId: number }).providerId).toBe(9);
		});
	});

	it("supersedes prior catalog rows for the same family only", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.providers = [fontProvider({ id: 7 })];
			fontsState.syncFamilies = [fontFamily({ providerId: 7 })];
			// Stale catalog row for the same family + a different family +
			// an unowned row with no family stamp (orphan).
			const mkStale = async (family: string | null, key: string | null) => {
				const variants = family === null ? null : JSON.stringify({ family });
				const rows = await db
					.insert(themeAssets)
					.values({
						themeId: null,
						kind: "font",
						r2Key: key,
						status: "ready",
						variants,
						createdAt: new Date(),
					})
					.returning();
				return rows[0]!;
			};
			const staleSame = await mkStale("Inter", "theme-assets/catalog/font/old.woff2");
			const staleNullKey = await mkStale("Inter", null);
			const staleOther = await mkStale("Other", "theme-assets/catalog/font/other.woff2");
			await mkStale(null, null);
			bucketStore.set("theme-assets/catalog/font/old.woff2", {
				data: new Uint8Array([1]),
			});
			bucketStore.set("theme-assets/catalog/font/other.woff2", {
				data: new Uint8Array([1]),
			});
			const res = await postCatalog({ family: "Inter" }, woff2());
			expect(res.status).toBe(200);
			// R2 cleanup is best-effort — a failing delete never fails
			// the upload (the row supersede already committed).
			bucketDeleteFails = true;
			const res2 = await postCatalog({ family: "Inter" }, woff2());
			expect(res2.status).toBe(200);
			bucketDeleteFails = false;
			const remaining = await db.select().from(themeAssets);
			const ids = remaining.map((r) => r.id);
			expect(ids).not.toContain(staleSame.id);
			expect(ids).not.toContain(staleNullKey.id);
			expect(ids).toContain(staleOther.id);
			// R2 objects for superseded rows are dropped; others survive.
			expect(bucketStore.has("theme-assets/catalog/font/old.woff2")).toBe(false);
			expect(bucketStore.has("theme-assets/catalog/font/other.woff2")).toBe(true);
		});
	});

	it("stamps weightAxis/unicodeRange on variable-font uploads", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.syncFamilies = [fontFamily({ providerId: 1, family: "VarSans" })];
			// Minimal TTF: fvar wght axis (100/400/900) + cmap format 12.
			const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
			const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
			const i32 = (v: number) => u32(v | 0);
			const tag = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
			const fixed = (n: number) => i32(Math.round(n * 65536));
			const fvar = [
				...u16(1),
				...u16(0),
				...u16(16),
				...u16(0),
				...u16(1),
				...u16(20),
				...u16(0),
				...u16(0),
				...tag("wght"),
				...fixed(100),
				...fixed(400),
				...fixed(900),
				...u16(0),
				...u16(256),
			];
			const cmap = [
				...u16(0),
				...u16(1),
				...u16(3),
				...u16(10),
				...u32(12),
				...u16(12),
				...u16(0),
				...u32(16 + 12),
				...u32(0),
				...u32(1),
				...u32(0x20),
				...u32(0x7e),
				...u32(0),
			];
			const tables = [
				{ name: tag("fvar"), data: fvar },
				{ name: tag("cmap"), data: cmap },
			];
			let offset = 12 + tables.length * 16;
			const records: number[] = [];
			const body: number[] = [];
			for (const t of tables) {
				records.push(...t.name, ...u32(0), ...u32(offset), ...u32(t.data.length));
				body.push(...t.data);
				offset += t.data.length;
			}
			const ttf = new Uint8Array([
				...tag("true"),
				...u16(tables.length),
				...u16(0),
				...u16(0),
				...u16(0),
				...records,
				...body,
			]);
			const file = new File([ttf], "VarSans.ttf", { type: "font/ttf" });
			const res = await postCatalog({ family: "VarSans" }, file);
			expect(res.status).toBe(200);
			const bodyJson = (await res.json()) as { assetId: number };
			const row = (await db.select().from(themeAssets)).find((r) => r.id === bodyJson.assetId);
			const variants = JSON.parse(row!.variants!);
			expect(variants.variable).toBe(true);
			expect(variants.weightAxis).toEqual({ min: 100, default: 400, max: 900 });
			expect(variants.unicodeRange).toBe("U+0020-007E");
			expect(variants.fontAsset.faces).toEqual([
				{
					url: expect.stringContaining("/api/theme/assets?key="),
					weightRange: [100, 900],
					unicodeRange: "U+0020-007E",
					format: "truetype",
				},
			]);
		});
	});

	it("500s when the catalog sync fails or the asset insert yields no row", async () => {
		useSession("admin");
		await withCatalogRuntime(async () => {
			fontsState.providers = [fontProvider({ id: 8 })];
			fontsState.syncFails = true;
			expect((await postCatalog({ family: "Inter" }, woff2())).status).toBe(500);
			fontsState.syncFails = false;
		});
		await withRuntime({ runAs: runAsOn(runtimeCatalogFakeDb) }, async () => {
			expect((await postCatalog({ family: "Inter" }, woff2())).status).toBe(500);
		});
	});
});
