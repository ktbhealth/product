import { Effect } from "effect";

import { audit } from "@ktb/audit";
import { AUDIO_TRANSCRIPTION_JOB_KIND, Consultations } from "@ktb/consultations";
import { Db } from "@ktb/db";
import { createPluginApiRoute, getDoctorUser, getServerRuntime, runAs } from "@ktb/server-fns";
import { tenantIsZk } from "@ktb/vault";

import { MAX_AUDIO_BYTES } from "../audio-consumer.ts";

/**
 * POST /api/consultations/:id/audio — store the session recording in R2
 * and enqueue the async transcription job (P-015/P-016).
 *
 * Body: raw audio bytes (audio/webm | audio/ogg | audio/mp4 | …) or a
 * multipart form with an "audio" file. Owner-only; the consultation must
 * belong to the session user.
 *
 * GET /api/consultations/:id/audio — stream the stored audio back
 * (owner-only, private/no-store; never a public bucket URL).
 *
 * The route module lives in this package and is mounted into the host's
 * virtual route tree by `consultationsRoutesPlugin`
 * (physical("/api", "src/api-routes")); the session/runtime boundary is
 * @ktb/server-fns — the R2 bucket and queue arrive through the runtime
 * registry, so no host imports or env reads are needed (P-033).
 */

/**
 * Bound worker memory: the body is buffered fully before the R2 put.
 * Capped at the Whisper transcription ceiling — the same
 * MAX_AUDIO_BYTES the queued pipeline enforces (../audio-consumer.ts) —
 * so nothing stored here can end up untranscribable.
 */
const MAX_UPLOAD_BYTES = MAX_AUDIO_BYTES;

/**
 * Single-range "bytes=" parsing (RFC 9110 §14.1.2). Malformed and
 * multi-range headers are ignored (full-body 200 — the spec lets
 * servers ignore them); a syntactically valid range outside the
 * object reports "unsatisfiable" so the route can answer 416.
 */
const parseAudioRange = (
	header: string | null | undefined,
	total: number,
): { offset: number; length: number } | "unsatisfiable" | null => {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return null;
	const [, a, b] = m;
	if (a === "") {
		if (b === "") return null;
		const suffix = Number(b);
		if (suffix <= 0) return null;
		return { offset: Math.max(0, total - suffix), length: Math.min(suffix, total) };
	}
	const offset = Number(a);
	if (offset >= total) return "unsatisfiable";
	const end = b === "" ? total - 1 : Math.min(Number(b), total - 1);
	if (end < offset) return null;
	return { offset, length: end - offset + 1 };
};

const EXT_BY_TYPE: Record<string, string> = {
	"audio/webm": "webm",
	"audio/ogg": "ogg",
	"audio/mp4": "m4a",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/flac": "flac",
};

const fetchOwned = (id: number, userId: string) =>
	runAs(
		{ id: userId },
		Effect.gen(function* () {
			const consultations = yield* Consultations;
			return yield* consultations
				.get(id, userId)
				.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
		}),
	);

export const Route = createPluginApiRoute("consultations.routes")("/api/consultations/$id/audio")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const user = await getDoctorUser();
				const id = Number.parseInt(params.id, 10);
				if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
				if (!Number.isFinite(id)) return Response.json({ error: "not found" }, { status: 404 });
				const { audio: audioBucket, jobs } = getServerRuntime();
				if (!audioBucket || !jobs) {
					return Response.json({ error: "audio storage not configured" }, { status: 503 });
				}

				const detail = await fetchOwned(id, user.id);
				if (!detail) return Response.json({ error: "not found" }, { status: 404 });

				// Raw body or multipart "audio" file — same acceptance as /api/transcribe.
				let bytes: ArrayBuffer;
				let contentType = request.headers.get("content-type") ?? "";
				const isMultipart = contentType.startsWith("multipart/form-data");
				if (isMultipart) {
					const form = await request.formData();
					const file = form.get("audio");
					if (!(file instanceof File)) {
						return Response.json({ error: "missing audio file" }, { status: 400 });
					}
					contentType = file.type || contentType;
					bytes = await file.arrayBuffer();
				} else {
					bytes = await request.arrayBuffer();
					if (bytes.byteLength === 0) {
						return Response.json({ error: "empty audio body" }, { status: 400 });
					}
				}
				if (bytes.byteLength > MAX_UPLOAD_BYTES) {
					return Response.json(
						{ error: "audio too large for transcription (max 25MB)" },
						{ status: 413 },
					);
				}
				const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
				if (
					mediaType &&
					!mediaType.startsWith("audio/") &&
					mediaType !== "application/octet-stream"
				) {
					return Response.json({ error: "unsupported content type" }, { status: 415 });
				}

				const ext = EXT_BY_TYPE[mediaType] ?? "bin";
				const audioKey = `audio/${user.id}/${id}/${crypto.randomUUID()}.${ext}`;
				await audioBucket.put(audioKey, bytes, {
					httpMetadata: { contentType: mediaType || "application/octet-stream" },
				});

				// Link first (status "stored"), then enqueue; a queue failure
				// leaves the object stored but unprocessed — honest status.
				await runAs(
					{ id: user.id },
					Effect.gen(function* () {
						const consultations = yield* Consultations;
						yield* consultations.attachAudio(user.id, {
							consultationId: id,
							audioKey,
							contentType: mediaType || undefined,
							size: bytes.byteLength,
						});
					}),
				);

				// T-147: a ZK tenant uploads ciphertext (client-side framed
				// AES-GCM). It is stored for approved-device retrieval, but
				// must never reach the Whisper queue — the tenant's own row
				// metadata is the gate, not anything the client sent.
				const zk =
					detail.tenantId !== null &&
					(await runAs(
						{ id: user.id },
						Effect.gen(function* () {
							const db = yield* Db;
							return yield* Effect.promise(() => tenantIsZk(db, detail.tenantId!));
						}),
					));
				if (zk) {
					await runAs(
						{ id: user.id },
						Effect.gen(function* () {
							const consultations = yield* Consultations;
							yield* consultations.updateAudioStatus(user.id, id, "zk");
						}),
					);
					return Response.json({ ok: true, audioStatus: "zk", audioSize: bytes.byteLength });
				}

				try {
					// Enqueue via the jobs port (PL-007): the host adapter
					// writes the job_runs row and sends the kind-dispatched
					// envelope. tenantId travels on both the envelope and the
					// payload so the consumer can re-bind tenant scope
					// (P-053 phase D); the fetched row's tenant_id is
					// authoritative — it matches what attachAudio stamped
					// under the bound Tenant.
					await jobs.enqueue(
						AUDIO_TRANSCRIPTION_JOB_KIND,
						{
							consultationId: id,
							audioKey,
							userId: user.id,
							tenantId: detail.tenantId,
						},
						{ tenantId: detail.tenantId, payloadRef: `consultation:${id}` },
					);
				} catch {
					return Response.json(
						{ error: "audio stored but transcription queue unavailable" },
						{ status: 502 },
					);
				}
				await runAs(
					{ id: user.id },
					Effect.gen(function* () {
						const consultations = yield* Consultations;
						yield* consultations.updateAudioStatus(user.id, id, "queued");
					}),
				);

				return Response.json({
					ok: true,
					audioStatus: "queued",
					audioSize: bytes.byteLength,
				});
			},
			GET: async ({ request, params }) => {
				const user = await getDoctorUser();
				const id = Number.parseInt(params.id, 10);
				if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
				if (!Number.isFinite(id)) return Response.json({ error: "not found" }, { status: 404 });
				const { audio: audioBucket } = getServerRuntime();
				if (!audioBucket) {
					return Response.json({ error: "audio storage not configured" }, { status: 503 });
				}

				const detail = await fetchOwned(id, user.id);
				if (!detail?.audioKey) return Response.json({ error: "not found" }, { status: 404 });

				const meta = await audioBucket.head(detail.audioKey);
				if (!meta) return Response.json({ error: "not found" }, { status: 404 });
				const total = meta.size;
				const range = parseAudioRange(request?.headers.get("range"), total);
				if (range === "unsatisfiable") {
					return new Response(null, {
						status: 416,
						headers: { "content-range": `bytes */${total}` },
					});
				}

				// Sensitive-read audit: the audio bytes are the most sensitive
				// payload a consultation carries — record the download after
				// authz, before the stream. ids only.
				await runAs(
					{ id: user.id },
					Effect.gen(function* () {
						yield* audit({
							action: "consultations.audio.read",
							targetType: "consultation",
							targetId: id,
							tenantId: detail.tenantId,
							detail: {
								patientId: detail.patientId,
								via: "audio-download",
								...(range
									? { range: `${range.offset}-${range.offset + range.length - 1}` }
									: {}),
							},
						});
					}),
				);

				const object = await audioBucket.get(
					detail.audioKey,
					range ? { range } : undefined,
				);
				if (!object) return Response.json({ error: "not found" }, { status: 404 });

				// `accept-ranges` on every response is what lets the browser
				// treat the media as seekable — without it a mid-file seek
				// clamps to the buffered start and restarts playback.
				const headers = {
					"content-type":
						detail.audioContentType ??
						object.httpMetadata?.contentType ??
						"application/octet-stream",
					"cache-control": "private, no-store",
					"accept-ranges": "bytes",
					"content-disposition": `inline; filename="consultation-${id}-audio"`,
				};
				if (range) {
					return new Response(object.body, {
						status: 206,
						headers: {
							...headers,
							"content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${total}`,
							"content-length": String(range.length),
						},
					});
				}
				return new Response(object.body, {
					headers: { ...headers, "content-length": String(total) },
				});
			},
		},
	},
});
