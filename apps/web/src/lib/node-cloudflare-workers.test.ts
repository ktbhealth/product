import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { observabilityEnvKeys } from "@ktb/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STUB_TRANSCRIPT } from "./ai.ts";

/**
 * The module is the dev:node stand-in for `cloudflare:workers` — it is
 * only reachable through the vite alias (vitest aliases the specifier
 * to src/test/cloudflare-workers.ts instead), so it is imported
 * directly here. Env is read once at module evaluation: each test
 * resets modules and re-imports with the process.env it needs.
 */

const ENV_KEYS = [
	"DATABASE_URL",
	"AUDIO_BUCKET_DIR",
	"KTB_DEV_QUEUE_DB",
	"THEME_ASSETS_BUCKET_DIR",
	"KTB_DEV_THEME_QUEUE_DB",
	"AI_STUB",
	"AI_BASE_URL",
	"REDIS_URL",
	"JOBS_QUEUE",
	"BETTER_AUTH_SECRET",
] as const;

const saved: Record<string, string | undefined> = {};
let audioDir: string | undefined;

for (const key of ENV_KEYS) saved[key] = process.env[key];

const loadEnv = async () => {
	vi.resetModules();
	const mod = await import("./node-cloudflare-workers.ts");
	return mod.env as Record<string, any>;
};

afterEach(() => {
	vi.unstubAllEnvs();
	vi.doUnmock("@ktb/pubsub-transport-redis");
	vi.doUnmock("@ktb/jobs-transport-redis");
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	if (audioDir !== undefined) {
		rmSync(audioDir, { recursive: true, force: true });
		audioDir = undefined;
	}
	vi.resetModules();
});

describe("node-cloudflare-workers env", () => {
	it("exposes DB, AUDIO_BUCKET and AUDIO_QUEUE; AI defaults to the stub", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		audioDir = mkdtempSync(join(tmpdir(), "ktb-node-env-"));
		process.env.AUDIO_BUCKET_DIR = audioDir;
		delete process.env.AI_STUB;
		delete process.env.AI_BASE_URL;

		const env = await loadEnv();
		expect(typeof env.DB.prepare).toBe("function");
		expect(typeof env.AUDIO_BUCKET.put).toBe("function");
		expect(typeof env.AUDIO_BUCKET.get).toBe("function");
		expect(typeof env.AUDIO_BUCKET.delete).toBe("function");
		expect(typeof env.AUDIO_QUEUE.send).toBe("function");
		// dev:node defaults AI_STUB=1 (mirroring wrangler.dev.jsonc) so the
		// golden path runs with no external services.
		expect(env.AI_STUB).toBe("1");
		expect(typeof env.AI.run).toBe("function");

		// The bucket writes under AUDIO_BUCKET_DIR.
		await env.AUDIO_BUCKET.put("k.bin", new Uint8Array([1, 2]));
		const object = await env.AUDIO_BUCKET.get("k.bin");
		expect(object.size).toBe(2);
	});

	it("REDIS_JOBS_QUEUE.stats() resolves null when Redis is unreachable", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		// Point at a port nothing listens on — the lazy connect must
		// fail soft (null), never reject or block boot.
		process.env.REDIS_URL = "redis://127.0.0.1:1";
		const env = await loadEnv();
		expect(typeof env.REDIS_JOBS_QUEUE?.stats).toBe("function");
		await expect(env.REDIS_JOBS_QUEUE.stats()).resolves.toBeNull();
	});

	it("exposes the REDIS_PUBSUB stand-in with lazy connect semantics", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		// Unreachable Redis: the transport connects lazily, so the
		// binding exists at boot and calls reject (platform.ts collapses
		// them to the honest unavailable state).
		process.env.REDIS_URL = "redis://127.0.0.1:1";
		const env = await loadEnv();
		expect(typeof env.REDIS_PUBSUB?.publish).toBe("function");
		expect(typeof env.REDIS_PUBSUB?.subscribe).toBe("function");
		expect(typeof env.REDIS_PUBSUB?.listTopics).toBe("function");
		await expect(env.REDIS_PUBSUB.listTopics()).rejects.toThrow();
	});

	it("forwards plain config keys and resolves AI_STUB into env.AI", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		process.env.AI_STUB = "1";
		process.env.BETTER_AUTH_SECRET = "s3cret";

		const env = await loadEnv();
		expect(env.BETTER_AUTH_SECRET).toBe("s3cret");
		expect(typeof env.AI.run).toBe("function");
		await expect(env.AI.run("m", { audio: "aGk=" })).resolves.toEqual({
			text: STUB_TRANSCRIPT,
		});
	});

	it("does not default AI_STUB when AI_BASE_URL is configured", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		delete process.env.AI_STUB;
		process.env.AI_BASE_URL = "http://localhost:8080/v1";

		const env = await loadEnv();
		expect(env.AI_STUB).toBeUndefined();
		expect(env.AI_BASE_URL).toBe("http://localhost:8080/v1");
		expect(typeof env.AI.run).toBe("function");
	});

	it("honors an explicit AI_STUB=0 opt-out", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		process.env.AI_STUB = "0";
		delete process.env.AI_BASE_URL;

		const env = await loadEnv();
		expect(env.AI_STUB).toBe("0");
		expect(env.AI).toBeUndefined();
	});

	it("forwards every observability env key into the worker env", async () => {
		// telemetryConfigFromEnv reads these off the worker binding env —
		// a key missing from ENV_KEYS is silently ignored under dev:node.
		// observabilityEnvKeys("KTB_") is the canonical list (@ktb/observability).
		vi.stubEnv("DATABASE_URL", ":memory:");
		vi.stubEnv("KTB_DEV_QUEUE_DB", ":memory:");
		for (const key of observabilityEnvKeys("KTB_")) {
			vi.stubEnv(key, `fwd-${key}`);
		}

		const env = await loadEnv();
		for (const key of observabilityEnvKeys("KTB_")) {
			expect(env[key], key).toBe(`fwd-${key}`);
		}
	});

	it("loads apps/web/.dev.vars at boot and logs key names only", async () => {
		// The module merges ../../.dev.vars (relative to src/lib) into
		// process.env once, at evaluation. Back up any real file first —
		// devs may have secrets there.
		const devVarsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.dev.vars");
		const hadFile = existsSync(devVarsPath);
		const backup = hadFile ? readFileSync(devVarsPath) : undefined;
		writeFileSync(devVarsPath, 'KT_DEVVARS_FROM_FILE="loaded"\n', { mode: 0o600 });
		delete process.env.KT_DEVVARS_FROM_FILE;
		try {
			process.env.DATABASE_URL = ":memory:";
			vi.stubEnv("KTB_DEV_QUEUE_DB", ":memory:");
			const info = vi.spyOn(console, "info").mockImplementation(() => {});
			const env = await loadEnv();
			expect(process.env.KT_DEVVARS_FROM_FILE).toBe("loaded");
			expect(info).toHaveBeenCalledWith("[dev:node] loaded .dev.vars (1 keys)");
			expect(typeof env.DB.prepare).toBe("function");
		} finally {
			delete process.env.KT_DEVVARS_FROM_FILE;
			if (backup === undefined) rmSync(devVarsPath, { force: true });
			else writeFileSync(devVarsPath, backup);
		}
	});

	it("defaults the queue db to ./data/queue.db when KTB_DEV_QUEUE_DB is unset", async () => {
		process.env.DATABASE_URL = ":memory:";
		vi.stubEnv("KTB_DEV_QUEUE_DB", undefined);
		audioDir = mkdtempSync(join(tmpdir(), "ktb-node-env-"));
		process.env.AUDIO_BUCKET_DIR = audioDir;

		// The default path is apps/web/data/queue.db (gitignored) — the
		// same file `dev:node` opens. Remove the sqlite sidecars after.
		const queueDb = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/queue.db");
		const env = await loadEnv();
		expect(typeof env.AUDIO_QUEUE.send).toBe("function");
		for (const suffix of ["", "-wal", "-shm"]) {
			rmSync(`${queueDb}${suffix}`, { force: true });
		}
	});

	it("AUDIO_QUEUE.send dispatches to the audio job consumer", async () => {
		// DATABASE_URL deliberately unset → covers the ./data/app.db
		// default (the same file `dev:node` opens; migrations are
		// idempotent). env.DB itself is unused by this test.
		vi.stubEnv("DATABASE_URL", undefined);
		vi.stubEnv("KTB_DEV_QUEUE_DB", ":memory:");
		audioDir = mkdtempSync(join(tmpdir(), "ktb-node-env-"));
		process.env.AUDIO_BUCKET_DIR = audioDir;

		const env = await loadEnv();
		// Unknown consultation → consumer marks the job failed and acks.
		// Under vitest the lazy audio-jobs import resolves platform.ts
		// against the test cloudflare:workers double (test D1 + fakes).
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		await env.AUDIO_QUEUE.send({ consultationId: 999999, audioKey: "k", userId: "u" });
		await vi.waitFor(
			() =>
				expect(info).toHaveBeenCalledWith("[dev:node] queue batch processed", {
					done: 1,
					total: 1,
				}),
			// The consumer lazily imports ./audio-jobs.ts — a cold vite
			// transform of the platform graph that can exceed 10s under
			// parallel load. Generous timeout; the assertion itself is
			// unchanged.
			{ timeout: 30000 },
		);
	}, 45000);

	it("exposes separate THEME_ASSETS_BUCKET and THEME_ASSETS_QUEUE bindings", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		process.env.KTB_DEV_THEME_QUEUE_DB = ":memory:";
		audioDir = mkdtempSync(join(tmpdir(), "ktb-node-theme-"));
		const themeDir = mkdtempSync(join(tmpdir(), "ktb-node-theme-assets-"));
		process.env.AUDIO_BUCKET_DIR = audioDir;
		process.env.THEME_ASSETS_BUCKET_DIR = themeDir;

		const env = await loadEnv();
		expect(typeof env.THEME_ASSETS_BUCKET.put).toBe("function");
		expect(typeof env.THEME_ASSETS_BUCKET.get).toBe("function");
		expect(typeof env.THEME_ASSETS_QUEUE.send).toBe("function");

		// Theme objects land under the theme dir; the audio bucket stays
		// untouched (separate store per PL-006 phase 4).
		await env.THEME_ASSETS_BUCKET.put("theme-assets/1/x.png", new Uint8Array([7]));
		expect((await env.THEME_ASSETS_BUCKET.get("theme-assets/1/x.png")).size).toBe(1);
		expect(await env.AUDIO_BUCKET.get("theme-assets/1/x.png")).toBeNull();
		rmSync(themeDir, { recursive: true, force: true });
	}, 30000);

	it("THEME_ASSETS_QUEUE.send dispatches to the theme job consumer", async () => {
		process.env.DATABASE_URL = ":memory:";
		vi.stubEnv("KTB_DEV_QUEUE_DB", ":memory:");
		vi.stubEnv("KTB_DEV_THEME_QUEUE_DB", ":memory:");
		audioDir = mkdtempSync(join(tmpdir(), "ktb-node-theme-q-"));
		const themeDir = mkdtempSync(join(tmpdir(), "ktb-node-theme-assets-q-"));
		process.env.AUDIO_BUCKET_DIR = audioDir;
		process.env.THEME_ASSETS_BUCKET_DIR = themeDir;

		const env = await loadEnv();
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		// Unknown kind → consumer acks without touching the asset pipeline;
		// the lazy theme-jobs import resolves platform.ts against the
		// test cloudflare:workers double (same as the audio queue above).
		await env.THEME_ASSETS_QUEUE.send({
			id: "theme-1",
			kind: "bogus.kind",
			payload: {},
			tenantId: null,
		});
		await vi.waitFor(
			() =>
				expect(info).toHaveBeenCalledWith("[dev:node] queue batch processed", {
					done: 1,
					total: 1,
				}),
			{ timeout: 30000 },
		);
		rmSync(themeDir, { recursive: true, force: true });
	}, 45000);

	it("REDIS_JOBS_QUEUE forwards REDIS_URL and JOBS_QUEUE into the transport", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		process.env.REDIS_URL = "redis://10.0.0.9:6380";
		process.env.JOBS_QUEUE = "ktb:test-jobs";
		let captured: { url?: string; queue?: string } | undefined;
		vi.doMock("@ktb/jobs-transport-redis", () => ({
			createRedisJobsTransport: async (opts: { url?: string; queue?: string }) => {
				captured = opts;
				return { stats: async () => ({ pending: 1 }) };
			},
		}));

		const env = await loadEnv();
		await expect(env.REDIS_JOBS_QUEUE.stats()).resolves.toEqual({ pending: 1 });
		expect(captured).toEqual({ url: "redis://10.0.0.9:6380", queue: "ktb:test-jobs" });
	});

	it("REDIS_JOBS_QUEUE falls back to the default Redis URL and omits queue", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		delete process.env.REDIS_URL;
		delete process.env.JOBS_QUEUE;
		let captured: { url?: string; queue?: string } | undefined;
		vi.doMock("@ktb/jobs-transport-redis", () => ({
			createRedisJobsTransport: async (opts: { url?: string; queue?: string }) => {
				captured = opts;
				return { stats: async () => null };
			},
		}));

		const env = await loadEnv();
		await expect(env.REDIS_JOBS_QUEUE.stats()).resolves.toBeNull();
		expect(captured).toEqual({ url: "redis://127.0.0.1:6379" });
	});

	it("REDIS_PUBSUB publishes, subscribes and lists through the lazy transport", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		delete process.env.REDIS_URL;
		const published: [string, unknown][] = [];
		const subscribed: string[] = [];
		const unsubscribed: string[] = [];
		let captured: { url?: string } | undefined;
		vi.doMock("@ktb/pubsub-transport-redis", () => ({
			createRedisPubSubTransport: async (opts: { url?: string }) => {
				captured = opts;
				return {
					publish: async (topic: string, payload: unknown) => {
						published.push([topic, payload]);
					},
					subscribe: async (topic: string, _handler: (p: unknown) => void) => {
						subscribed.push(topic);
						return () => {
							unsubscribed.push(topic);
						};
					},
					listTopics: async () => [
						{ id: "redis:t", name: "t", transport: "redis", subscribers: 1 },
					],
				};
			},
		}));

		const env = await loadEnv();
		await env.REDIS_PUBSUB.publish("t", { a: 1 });
		expect(published).toEqual([["t", { a: 1 }]]);

		const off = await env.REDIS_PUBSUB.subscribe("t", () => {});
		expect(subscribed).toEqual(["t"]);
		off();
		expect(unsubscribed).toEqual(["t"]);

		await expect(env.REDIS_PUBSUB.listTopics()).resolves.toEqual([
			{ id: "redis:t", name: "t", transport: "redis", subscribers: 1 },
		]);
		// REDIS_URL unset → the transport resolved the default URL.
		expect(captured).toEqual({ url: "redis://127.0.0.1:6379" });
	});

	it("REDIS_PUBSUB.subscribe degrades to a no-op when the transport cannot subscribe", async () => {
		process.env.DATABASE_URL = ":memory:";
		process.env.KTB_DEV_QUEUE_DB = ":memory:";
		vi.doMock("@ktb/pubsub-transport-redis", () => ({
			createRedisPubSubTransport: async () => ({
				publish: async () => {},
				// No subscribe capability — the binding hands back an
				// inert unsubscribe instead of rejecting.
				listTopics: async () => [],
			}),
		}));

		const env = await loadEnv();
		const off = await env.REDIS_PUBSUB.subscribe("t", () => {});
		expect(typeof off).toBe("function");
		off();
	});
});
