import { makeD1 } from "@ktb/db/testing";

// All drizzle migrations, applied in filename order — keeps the test D1
// schema in lockstep with packages/db/drizzle without hardcoding names.
const migrations = import.meta.glob("../../../../packages/db/drizzle/*.sql", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;
const migrationSql = Object.keys(migrations)
	.sort()
	.map((path) => migrations[path]!)
	.join("\n");

/** In-memory R2Bucket double for the audio routes/consumer tests. */
export const audioBucketStore = new Map<string, { data: Uint8Array; contentType?: string }>();

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
		audioBucketStore.set(key, {
			data,
			contentType: options?.httpMetadata?.contentType,
		});
		return {};
	},
	get: async (key: string) => {
		const object = audioBucketStore.get(key);
		if (!object) return null;
		const { data, contentType } = object;
		// slice() yields a fresh Uint8Array<ArrayBuffer> — satisfies BodyInit.
		const bytes = data.slice();
		return {
			key,
			size: bytes.byteLength,
			httpMetadata: { contentType },
			body: new Response(bytes).body,
			arrayBuffer: async () => bytes.buffer,
		};
	},
	delete: async (keys: string | string[]) => {
		for (const key of Array.isArray(keys) ? keys : [keys]) audioBucketStore.delete(key);
	},
};

/** Queue producer double — sent messages land in audioQueueSent. */
export const audioQueueSent: unknown[] = [];

const fakeQueue = {
	send: async (body: unknown) => {
		audioQueueSent.push(body);
		return {};
	},
};

/** Theme-assets doubles (PL-006 phase 4): separate store + sent log so
 * theme tests never mix with consultation audio fixtures. */
export const themeAssetsStore = new Map<string, { data: Uint8Array; contentType?: string }>();
export const themeAssetsQueueSent: unknown[] = [];

const themeAssetsBucket = {
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
		themeAssetsStore.set(key, { data, contentType: options?.httpMetadata?.contentType });
		return {};
	},
	get: async (key: string) => {
		const object = themeAssetsStore.get(key);
		if (!object) return null;
		const { data, contentType } = object;
		const bytes = data.slice();
		return {
			key,
			size: bytes.byteLength,
			httpMetadata: { contentType },
			body: new Response(bytes).body,
			arrayBuffer: async () => bytes.buffer,
		};
	},
	delete: async (keys: string | string[]) => {
		for (const key of Array.isArray(keys) ? keys : [keys]) themeAssetsStore.delete(key);
	},
};

const themeAssetsQueue = {
	send: async (body: unknown) => {
		themeAssetsQueueSent.push(body);
		return {};
	},
};

/** Test double for the workerd `cloudflare:workers` module. Fresh per test file. */
export const env = {
	DB: makeD1(migrationSql),
	AI: {
		run: async (_model: string, _input: unknown) => ({ text: "transcrição do servidor" }),
	},
	AUDIO_BUCKET: fakeBucket,
	AUDIO_QUEUE: fakeQueue,
	THEME_ASSETS_BUCKET: themeAssetsBucket,
	THEME_ASSETS_QUEUE: themeAssetsQueue,
	// Worker-runtime config arrives as bindings only (mirrors .dev.vars in
	// dev / Alchemy bindings in prod). Tests that need a non-default value
	// assign it here BEFORE importing platform.ts — driver selection happens
	// once, at app composition.
	BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
	BETTER_AUTH_URL: "http://localhost:3000",
	TURNSTILE_SECRET_KEY: undefined as string | undefined,
	CAPTCHA_STUB: undefined as string | undefined,
	RECALL_API_KEY: undefined as string | undefined,
	// Product literals the generic infra packages read via config —
	// mirrors the alchemy.run.ts / wrangler*.jsonc bindings.
	RECALL_BOT_NAME: "KTB Health",
	OBSERVABILITY_ENV_PREFIX: "KTB_",
	SCHEDULER_QUEUE_BINDING: "AUDIO_QUEUE",
	// Fixed admin allowlist so platform-gate tests are deterministic.
	PLATFORM_ADMIN_EMAILS: "platform-admin@ktb.test",
};
