import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	installServerFnRuntime,
	reactStartServerMock,
	serverFnRequestHeaders,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());

import { vi } from "vitest";

import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Auth } from "@ktb/auth";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { images } from "./schema.ts";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import type { ServerRuntime } from "@ktb/server-fns";

import { Route as UploadRoute } from "./api-routes/images.ts";
import { Route as ServeRoute } from "./api-routes/images.$id.ts";
import { ImagesLive } from "./service.ts";

const handlersOf = (r: unknown) =>
	(
		r as {
			options: {
				server: { handlers: Record<string, (a: never) => Promise<Response>> };
			};
		}
	).options.server.handlers;

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

const db = makeDb(makeTestD1());

const infra = Layer.mergeAll(
	Layer.succeed(Db, db),
	Layer.succeed(Auth, authStub),
	Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
);

const runtime = ManagedRuntime.make(
	Layer.mergeAll(ImagesLive.pipe(Layer.provide(infra)), infra) as Layer.Layer<
		unknown,
		never,
		never
	>,
);

// In-memory object-store double — same shape as the apps/web test env.
const bucketStore = new Map<string, { data: Uint8Array; contentType?: string }>();
let bucketPutFails = false;
let bucketGetFails = false;
let bucketDeleteFails = false;

const fakeBucket = {
	put: async (
		key: string,
		value: ArrayBuffer | Uint8Array | ReadableStream,
		options?: { httpMetadata?: { contentType?: string } },
	) => {
		if (bucketPutFails) throw new Error("put boom");
		const data =
			value instanceof Uint8Array
				? value
				: value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(await new Response(value).arrayBuffer());
		bucketStore.set(key, { data, contentType: options?.httpMetadata?.contentType });
		return {};
	},
	head: async (key: string) => {
		if (bucketGetFails) throw new Error("head boom");
		const object = bucketStore.get(key);
		if (!object) return null;
		return { size: object.data.byteLength, httpMetadata: { contentType: object.contentType } };
	},
	get: async (key: string) => {
		if (bucketGetFails) throw new Error("get boom");
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

const runtimeOverrides: Partial<ServerRuntime> = {
	images: fakeBucket,
	pluginEnabled: async () => true,
};

const publishRuntime = () => installServerFnRuntime(runtime, authStub, runtimeOverrides);

beforeAll(() => {
	publishRuntime();
});

afterAll(async () => {
	await runtime.dispose();
});

const useSession = (key: string) => {
	serverFnRequestHeaders.current = new Headers({ cookie: `session=${key}` });
};

const withRuntime = async <T>(patch: Partial<ServerRuntime>, fn: () => Promise<T>) => {
	installServerFnRuntime(runtime, authStub, { ...runtimeOverrides, ...patch });
	try {
		return await fn();
	} finally {
		publishRuntime();
	}
};

/** Minimal valid PNG header (signature + IHDR 2x3). */
const pngBytes = () =>
	new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
		0, 0, 0, 3, 8, 6, 0, 0, 0,
	]);

const png = (name = "pic.png", type = "image/png") => new File([pngBytes()], name, { type });

const postImage = (fields: Record<string, string>, file?: File) => {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	if (file !== undefined) form.set("file", file);
	return handlersOf(UploadRoute).POST!({
		request: new Request("http://x/api/images", {
			method: "POST",
			body: form,
		}),
	} as never);
};

const getImage = (id: string | number) =>
	handlersOf(ServeRoute).GET!({
		request: new Request(`http://x/api/images/${id}`),
		params: { id: String(id) },
	} as never);

describe("POST /api/images", () => {
	it("rejects anonymous and non-admin callers", async () => {
		serverFnRequestHeaders.current = new Headers();
		expect((await postImage({}, png())).status).toBe(401);
		useSession("plain");
		expect((await postImage({}, png())).status).toBe(403);
		useSession("admin");
	});

	it("rejects non-multipart, missing file, bad fields and bad payloads", async () => {
		const json = await handlersOf(UploadRoute).POST!({
			request: new Request("http://x/api/images", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		} as never);
		expect(json.status).toBe(400);
		expect((await postImage({})).status).toBe(400);

		const txt = new File([new Uint8Array([1])], "x.txt", { type: "text/plain" });
		expect((await postImage({}, txt)).status).toBe(415);
		const html = new File([new Uint8Array([1])], "x.png", { type: "text/html" });
		expect((await postImage({}, html)).status).toBe(415);
		const svg = new File([new Uint8Array([1])], "x.svg", { type: "image/svg+xml" });
		expect((await postImage({}, svg)).status).toBe(415);
		const empty = new File([], "e.png", { type: "image/png" });
		expect((await postImage({}, empty)).status).toBe(400);
		const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", {
			type: "image/png",
		});
		expect((await postImage({}, big)).status).toBe(413);
	});

	it("403s when the admin gate itself fails (isAdmin catch path)", async () => {
		// Runtime without PlatformAdmin → runAs rejects → isAdmin's
		// catch maps to false → forbidden, not a 500.
		const rtNoGate = ManagedRuntime.make(
			Layer.mergeAll(Layer.succeed(Auth, authStub), Layer.succeed(Db, db)) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		installServerFnRuntime(rtNoGate, authStub, runtimeOverrides);
		try {
			useSession("admin");
			expect((await postImage({}, png())).status).toBe(403);
		} finally {
			publishRuntime();
			await rtNoGate.dispose();
		}
	});

	it("400s when the request carries no content-type at all", async () => {
		useSession("admin");
		const res = await handlersOf(UploadRoute).POST!({
			request: new Request("http://x/api/images", { method: "POST" }),
		} as never);
		expect(res.status).toBe(400);
	});

	it("415s extension-less filenames and stores ext-derived MIME for empty/octet-stream types", async () => {
		useSession("admin");
		const noExt = new File([pngBytes()], "noext", { type: "image/png" });
		expect((await postImage({}, noExt)).status).toBe(415);
		// Empty declared MIME → extension map.
		const noMime = new File([pngBytes()], "a.png", { type: "" });
		const res1 = await postImage({}, noMime);
		expect(res1.status).toBe(200);
		expect(((await res1.json()) as { image: { mime: string } }).image.mime).toBe("image/png");
		// application/octet-stream → extension map too.
		const octet = new File([pngBytes()], "b.png", { type: "application/octet-stream" });
		const res2 = await postImage({}, octet);
		expect(res2.status).toBe(200);
		expect(((await res2.json()) as { image: { mime: string } }).image.mime).toBe("image/png");
	});

	it("stores null dimensions when the bytes don't sniff", async () => {
		useSession("admin");
		const garbage = new File([new Uint8Array([9, 9, 9, 9])], "g.png", { type: "image/png" });
		const res = await postImage({}, garbage);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { image: { width: number | null; height: number | null } };
		expect(body.image.width).toBeNull();
		expect(body.image.height).toBeNull();
	});

	it("rejects SVG by MIME even with an allowed extension", async () => {
		const disguised = new File([new Uint8Array([1])], "x.png", { type: "image/svg+xml" });
		expect((await postImage({}, disguised)).status).toBe(415);
	});

	it("503s when the image bucket is unbound", async () => {
		await withRuntime({ images: undefined }, async () => {
			expect((await postImage({}, png())).status).toBe(503);
		});
	});

	it("stores the object, records the row and returns the wire image", async () => {
		const res = await postImage({ title: "Hero", alt: "A hero" }, png("hero.png"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; image: Record<string, unknown> };
		expect(body.ok).toBe(true);
		expect(body.image).toMatchObject({
			title: "Hero",
			alt: "A hero",
			mime: "image/png",
			width: 2,
			height: 3,
			src: expect.stringMatching(/^\/api\/images\/\d+$/),
		});
		// The storage key is images/<uuid>.<ext> — find it in the store.
		const storedKey = [...bucketStore.keys()].find((k) => k.startsWith("images/"));
		expect(storedKey).toBeDefined();
		expect(bucketStore.get(storedKey!)!.contentType).toBe("image/png");
	});

	it("500s and rolls back the object when the row insert fails", async () => {
		// A runtime without the Images layer makes `yield* Images` fail —
		// deterministic stand-in for an insert failure after the object
		// landed. The handler must answer 500 and delete the stored
		// object (best-effort rollback).
		const rtNoDb = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(Auth, authStub),
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
			) as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(rtNoDb, authStub, runtimeOverrides);
		try {
			const before = bucketStore.size;
			const res = await postImage({}, png());
			expect(res.status).toBe(500);
			expect(bucketStore.size).toBe(before);
		} finally {
			publishRuntime();
			await rtNoDb.dispose();
		}
	});
});

describe("GET /api/images/$id", () => {
	it("404s malformed, missing and object-less ids", async () => {
		expect((await getImage("abc")).status).toBe(404);
		expect((await getImage(0)).status).toBe(404);
		expect((await getImage(-1)).status).toBe(404);
		expect((await getImage(9999)).status).toBe(404);
	});

	it("503s when the bucket is unbound for an existing row", async () => {
		const rows = await db
			.insert(images)
			.values({
				title: "t",
				alt: "",
				mime: "image/png",
				size: 1,
				storageKey: "images/orphan.png",
				createdAt: new Date(),
			})
			.returning({ id: images.id });
		await withRuntime({ images: undefined }, async () => {
			expect((await getImage(rows[0]!.id)).status).toBe(503);
		});
	});

	it("streams the stored object with immutable caching (upload→serve round-trip)", async () => {
		useSession("admin");
		const up = await postImage({}, png("round.png"));
		const { image } = (await up.json()) as { image: { id: number } };
		const res = await getImage(image.id);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toContain("immutable");
		const served = new Uint8Array(await res.arrayBuffer());
		expect(served).toEqual(pngBytes());
	});

	it("404s when the row lookup itself fails (run catch path)", async () => {
		// Runtime without the Images service → run() rejects → the
		// handler's catch maps to null → honest 404.
		const rtNoService = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(Auth, authStub),
				Layer.succeed(Db, db),
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
			) as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(rtNoService, authStub, runtimeOverrides);
		try {
			expect((await getImage(1)).status).toBe(404);
		} finally {
			publishRuntime();
			await rtNoService.dispose();
		}
	});

	it("404s when the row exists but the object is gone", async () => {
		const rows = await db
			.insert(images)
			.values({
				title: "t",
				alt: "",
				mime: "image/png",
				size: 1,
				storageKey: "images/missing-object.png",
				createdAt: new Date(),
			})
			.returning({ id: images.id });
		expect((await getImage(rows[0]!.id)).status).toBe(404);
	});

	it("falls back to the row mime when the stored object has no httpMetadata", async () => {
		// Objects uploaded before metadata tracking (or written by hand)
		// carry no contentType — the row's mime wins.
		bucketStore.set("images/raw.png", { data: pngBytes() });
		const rows = await db
			.insert(images)
			.values({
				title: "t",
				alt: "",
				mime: "image/png",
				size: 1,
				storageKey: "images/raw.png",
				createdAt: new Date(),
			})
			.returning({ id: images.id });
		const res = await getImage(rows[0]!.id);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		bucketStore.delete("images/raw.png");
	});
});
