import { contentTypeForKey, objectBytes, type MediaBucket } from "./store.ts";

/**
 * Object IO for derivative jobs — the consumer-side half of the
 * upload → validate → bucket → process pipeline.
 *
 * Derivative jobs themselves register through `@ktb/jobs-port`'s
 * `JobRegistration`/`makeJobConsumer` (kind-dispatched decode +
 * handle + `job_runs` projection); this module owns only the stored-
 * object reads/writes those handlers share: fetch the original the
 * upload route stored, enforce the byte ceiling again (queue payloads
 * are untrusted — the route's limit is not authoritative), decode to
 * bytes, and write derivative objects back under content-typed keys.
 */

export type JobObjectRead =
	| { readonly ok: true; readonly bytes: Uint8Array; readonly size: number }
	| { readonly ok: false; readonly reason: "missing" }
	| { readonly ok: false; readonly reason: "too-large"; readonly size: number };

/**
 * Fetch + bound-check the object a job payload points at. `missing`
 * covers both absent keys and an unbound bucket is the caller's
 * concern (check before calling — a missing bucket is a configuration
 * failure, not a missing object).
 */
export const readJobObject = async (
	bucket: MediaBucket,
	key: string,
	maxBytes: number,
): Promise<JobObjectRead> => {
	const object = await bucket.get(key);
	if (object === null) return { ok: false, reason: "missing" };
	if (object.size > maxBytes) {
		return { ok: false, reason: "too-large", size: object.size };
	}
	return { ok: true, bytes: await objectBytes(object), size: object.size };
};

/** Write one derivative object next to the originals — content type
 * derives from the key's extension unless overridden. */
export const writeJobObject = async (
	bucket: MediaBucket,
	key: string,
	bytes: Uint8Array,
	contentType?: string,
): Promise<void> => {
	await bucket.put(key, bytes, {
		httpMetadata: { contentType: contentType ?? contentTypeForKey(key) },
	});
};
