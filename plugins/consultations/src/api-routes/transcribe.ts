import * as Effect from "effect/Effect";

import { Db } from "@ktb/db";
import { Tenant, tenantScopeId } from "@ktb/tenant";
import { tenantIsZk } from "@ktb/vault";
import { createPluginApiRoute, getDoctorUser, getServerRuntime, runAs } from "@ktb/server-fns";

import { bytesToBase64, MAX_AUDIO_BYTES, whisperInputs } from "../audio-consumer.ts";

/**
 * POST /api/transcribe — server-side transcription of an uploaded
 * recording via Workers AI Whisper.
 *
 * The route module lives in this package and is mounted into the host's
 * virtual route tree by `consultationsRoutesPlugin`
 * (physical("/api", "src/api-routes")); the AI binding arrives through
 * the @ktb/server-fns runtime registry (host-resolved, incl. dev
 * stand-ins), so no host imports are needed (P-033). The size ceiling
 * and the whisper payload shape are shared with the queued pipeline
 * (../audio-consumer.ts) — one definition, two entry points.
 */

export const Route = createPluginApiRoute("consultations.routes")("/api/transcribe")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const user = await getDoctorUser();
				if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
				// T-146: a ZK tenant's audio/transcript is client-side content —
				// the server Whisper endpoint must never see it (browser
				// transcription is the only path there).
				const zk = await runAs(
					user,
					Effect.gen(function* () {
						const db = yield* Db;
						// Tenant is a Context.Reference — always bound
						// (null = personal scope, never ZK; the clinic flag
						// lives on groups).
						const tenantId = tenantScopeId(yield* Tenant);
						return tenantId !== null && (yield* Effect.promise(() => tenantIsZk(db, tenantId)));
					}),
				);
				if (zk) {
					return Response.json(
						{ error: "server transcription unavailable for zero-knowledge tenants" },
						{ status: 403 },
					);
				}
				const form = await request.formData();
				const file = form.get("audio");
				if (!(file instanceof File)) {
					return Response.json({ error: "missing audio file" }, { status: 400 });
				}
				if (file.size === 0) {
					return Response.json({ error: "empty audio file" }, { status: 400 });
				}
				if (file.size > MAX_AUDIO_BYTES) {
					return Response.json(
						{ error: "audio too large for transcription (max 25MB)" },
						{ status: 413 },
					);
				}
				// Same acceptance rule as the audio upload route: audio/* or
				// an opaque/octet-stream payload; anything else is rejected.
				const mediaType = (file.type || "application/octet-stream")
					.split(";")[0]!
					.trim()
					.toLowerCase();
				if (!mediaType.startsWith("audio/") && mediaType !== "application/octet-stream") {
					return Response.json({ error: "unsupported content type" }, { status: 415 });
				}
				const ai = getServerRuntime().ai;
				if (!ai) {
					return Response.json({ error: "transcription not configured" }, { status: 503 });
				}
				const bytes = new Uint8Array(await file.arrayBuffer());
				const model = getServerRuntime().audioTranscribeModel;
				const result = (await ai.run(model, whisperInputs(bytesToBase64(bytes)))) as {
					text?: string;
				};
				return Response.json({ text: result.text ?? "" });
			},
		},
	},
});
