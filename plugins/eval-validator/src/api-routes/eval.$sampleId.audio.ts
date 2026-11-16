import { Effect } from "effect";

import { createPluginApiRoute, getSessionUser, runAs } from "@ktb/server-fns";

import { EvalValidator } from "../index.ts";

/**
 * GET /api/eval/:sampleId/audio — stream the synthesized WAV for a
 * finished eval run sample (P-081, T-133). Gated by the same
 * eval.validator grant as every validator surface — the service
 * re-checks; bytes come through the EvalArtifacts driver (local
 * workdir in dev), so a run without bound artifacts 404s.
 */
export const Route = createPluginApiRoute("eval-validator.routes")("/api/eval/$sampleId/audio")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const user = await getSessionUser();
				if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
				const id = Number.parseInt(params.sampleId, 10);
				if (!Number.isFinite(id)) {
					return Response.json({ error: "not found" }, { status: 404 });
				}
				const bytes = await runAs(
					user,
					Effect.flatMap(EvalValidator, (v) => v.sampleAudio(id)).pipe(
						Effect.catchTag("Forbidden", () => Effect.succeed(null)),
					),
				);
				if (bytes === null) {
					return Response.json({ error: "not found" }, { status: 404 });
				}
				const base = {
					"content-type": "audio/wav",
					"cache-control": "private, no-store",
					"accept-ranges": "bytes",
				};
				// Single-range support so the <audio> seek bar works on
				// long consultations (~10min WAVs) without full download.
				const range = request.headers.get("range");
				const m = range === null ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
				if (m !== null) {
					const start = Number(m[1]);
					const end = Math.min(m[2] === "" ? bytes.length - 1 : Number(m[2]), bytes.length - 1);
					if (start >= bytes.length || start > end) {
						return new Response(null, {
							status: 416,
							headers: { ...base, "content-range": `bytes */${bytes.length}` },
						});
					}
					return new Response(bytes.subarray(start, end + 1) as unknown as BodyInit, {
						status: 206,
						headers: {
							...base,
							"content-range": `bytes ${start}-${end}/${bytes.length}`,
							"content-length": String(end - start + 1),
						},
					});
				}
				return new Response(bytes as unknown as BodyInit, {
					headers: { ...base, "content-length": String(bytes.length) },
				});
			},
		},
	},
});
