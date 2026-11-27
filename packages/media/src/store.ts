/**
 * Object-store port + serving/key helpers shared by every asset
 * pipeline (theme brand assets, catalog fonts, media-library images,
 * consultation audio). The deployment binds one bucket per asset
 * class through the @ktb/server-fns runtime registry; plugins never
 * touch the binding directly (P-033) — they resolve the bucket from
 * `getServerRuntime()` and pass it here as a {@link MediaBucket}.
 *
 * Serving contract: buckets stay private — objects are streamed back
 * through same-origin API routes, never via bucket URLs. Keys embed a
 * uuid, so content is immutable per key and responses are safe to
 * cache `immutable` (public assets) or `private, no-store` (audio).
 */

/** Stored object slice every pipeline needs: stream on serve, bytes
 * on derivative jobs, declared content type as the serve fallback.
 * The real R2ObjectBody satisfies this; `arrayBuffer` is optional so
 * filesystem stand-ins that only expose `body` still fit —
 * {@link objectBytes} reads either. */
export interface StoredObject {
	readonly body: ReadableStream;
	readonly size: number;
	readonly httpMetadata?: { readonly contentType?: string } | null;
	arrayBuffer?(): Promise<ArrayBuffer>;
}

/** The slice of an R2-style bucket the asset pipelines use: get for
 * serve/jobs, put for uploads + derivatives, delete for supersede and
 * rollback. R2Bucket satisfies this structurally. */
export interface MediaBucket {
	get(key: string): Promise<StoredObject | null>;
	put(
		key: string,
		value: ArrayBuffer | Uint8Array | ReadableStream,
		options?: { readonly httpMetadata?: { readonly contentType?: string } },
	): Promise<unknown>;
	delete(keys: string[]): Promise<unknown>;
}

/** Read a stored object's bytes — `arrayBuffer()` when the bucket
 * exposes it, otherwise the body stream is consumed. */
export const objectBytes = async (object: StoredObject): Promise<Uint8Array> => {
	if (object.arrayBuffer !== undefined) {
		return new Uint8Array(await object.arrayBuffer());
	}
	const reader = object.body.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value !== undefined) chunks.push(value);
	}
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
};

// ---------- keys ----------

/**
 * Content-unique object key: `<prefix><parts…>/<uuid>.<ext>`. `prefix`
 * is normalized to end with "/"; `parts` are path segments (tenant,
 * theme, kind, …) joined with "/". Examples:
 *
 *   storedObjectKey("theme-assets/", [12, "logo-light"], "png")
 *     → "theme-assets/12/logo-light/<uuid>.png"
 *   storedObjectKey("images/", [], "webp")
 *     → "images/<uuid>.webp"
 */
export const storedObjectKey = (
	prefix: string,
	parts: readonly (string | number)[],
	ext: string,
): string => {
	const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
	const mid = parts.length === 0 ? "" : `${parts.join("/")}/`;
	return `${base}${mid}${crypto.randomUUID()}.${ext}`;
};

// ---------- content types ----------

/** Extension (no dot, lowercase) of an object key. */
export const extOfKey = (key: string): string => {
	// split() always yields at least one element — pop() is never undefined.
	/* v8 ignore next -- pop() on split() is never undefined */
	const base = key.split("?")[0]!.split("/").pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
};

/** Default extension → MIME map covering every asset class the
 * pipelines store (images, fonts, audio). */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	webp: "image/webp",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	avif: "image/avif",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	woff2: "font/woff2",
	woff: "font/woff",
	ttf: "font/ttf",
	otf: "font/otf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	flac: "audio/flac",
	m4a: "audio/mp4",
	webm: "audio/webm",
};

/** MIME for an extension — "application/octet-stream" when unknown. */
export const mimeForExtension = (ext: string): string =>
	CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";

/** Stored content type for an object key; `overrides` lets a pipeline
 * pin domain-specific mappings ahead of the default table. */
export const contentTypeForKey = (
	key: string,
	overrides: Readonly<Record<string, string>> = {},
): string => {
	const ext = extOfKey(key);
	return overrides[ext] ?? CONTENT_TYPES[ext] ?? "application/octet-stream";
};

// ---------- put / delete / serve ----------

/** Store bytes under `key`; content type defaults to the key's
 * extension map unless `contentType` is given (a declared upload MIME
 * may legitimately differ from the extension map). */
export const putStoredObject = async (
	bucket: MediaBucket,
	key: string,
	bytes: ArrayBuffer | Uint8Array,
	contentType?: string,
): Promise<void> => {
	await bucket.put(key, bytes, {
		httpMetadata: { contentType: contentType ?? contentTypeForKey(key) },
	});
};

/**
 * Best-effort object delete — supersede/rollback cleanup where the
 * row (or the retry) is the authoritative state and a storage failure
 * must not mask it. `onError` receives the failure for logging.
 */
export const bestEffortDelete = async (
	bucket: MediaBucket,
	keys: readonly string[],
	onError?: (error: unknown) => void,
): Promise<void> => {
	if (keys.length === 0) return;
	try {
		await bucket.delete([...keys]);
	} catch (error) {
		onError?.(error);
	}
};

export interface ServeStoredObjectOptions {
	/** Fallback content type when the object carries no stored
	 * httpMetadata — the route's domain default (row mime, key ext
	 * map). Defaults to "application/octet-stream". */
	readonly contentType?: string;
	/** Cache-Control value — "public, max-age=31536000, immutable" for
	 * content-unique public keys, "private, no-store" for owner-scoped
	 * audio. */
	readonly cacheControl?: string;
	/** Extra response headers (e.g. content-disposition). */
	readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Stream a stored object back as an immutable-per-key Response — the
 * shared tail of every serve route. The bucket's stored content type
 * wins over `contentType`; `content-length` always reflects the
 * stored size.
 */
export const serveStoredObject = (
	object: StoredObject,
	options: ServeStoredObjectOptions = {},
): Response =>
	new Response(object.body, {
		headers: {
			"content-type":
				object.httpMetadata?.contentType ?? options.contentType ?? "application/octet-stream",
			"content-length": String(object.size),
			...(options.cacheControl === undefined ? {} : { "cache-control": options.cacheControl }),
			...(options.headers ?? {}),
		},
	});
