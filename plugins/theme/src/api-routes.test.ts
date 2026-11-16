import { beforeAll, describe, expect, it, vi } from "vitest";

const headers = { current: new Headers() };

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => headers.current,
}));

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Auth } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { setServerRuntime } from "@ktb/server-fns";

import { Route as AssetsRoute } from "./api-routes/theme.assets.ts";
import { Route as FontsRoute } from "./api-routes/theme.fonts.ts";

const handlersOf = (r: unknown) =>
	(r as { options: { server: { handlers: Record<string, (a: never) => Promise<Response>> } } })
		.options.server.handlers;

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

// In-memory R2/queue doubles — same shapes as the apps/web test env.
const bucketStore = new Map<string, { data: Uint8Array; contentType?: string }>();
const jobsSent: { kind: string; payload: unknown; options?: unknown }[] = [];

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
		bucketStore.set(key, { data, contentType: options?.httpMetadata?.contentType });
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
	headers.current = new Headers({ cookie: `session=${key}` });
};

beforeAll(() => {
	setServerRuntime({
		run: (effect) => runtime.runPromise(effect),
		runAs: (user, effect) =>
			runtime.runPromise(
				effect.pipe(Effect.provideService(Principal, { userId: user.id, email: user.email })),
			),
		themeAssets: fakeBucket,
		themeJobs: {
			enqueue: async (kind: string, payload: unknown, options?: unknown) => {
				jobsSent.push({ kind, payload, options });
				return { id: "env-1" };
			},
		},
		audioTranscribeModel: "test-model",
		getLocale: () => "en",
		pluginEnabled: async () => true,
	});
});

const postAsset = (fields: Record<string, string>, file?: File) => {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	if (file !== undefined) form.set("file", file);
	return handlersOf(AssetsRoute).POST!({
		request: new Request("http://x/api/theme/assets", { method: "POST", body: form }),
	} as never);
};

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" });

describe("POST /api/theme/assets", () => {
	it("rejects anonymous and non-admin callers", async () => {
		headers.current = new Headers();
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
		const txt = new File([new Uint8Array([1])], "x.txt", { type: "text/plain" });
		expect((await postAsset({ themeId: "1", kind: "favicon" }, txt)).status).toBe(415);
		const html = new File([new Uint8Array([1])], "x.png", { type: "text/html" });
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
		const body = (await res.json()) as { ok: boolean; assetId: number; status: string };
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
		const woff2 = new File([new Uint8Array([1])], "x.woff2", { type: "font/woff2" });
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
		headers.current = new Headers();
		expect((await post({ themeId: 1, family: "Inter" })).status).toBe(401);
		useSession("plain");
		expect((await post({ themeId: 1, family: "Inter" })).status).toBe(403);
		useSession("admin");
		expect(
			(
				await handlersOf(FontsRoute).POST!({
					request: new Request("http://x/api/theme/fonts", { method: "POST", body: "{" }),
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
			payload: { source: "google", family: "Open Sans", slot: "heading", weights: [400, 700] },
		});
	});
});
