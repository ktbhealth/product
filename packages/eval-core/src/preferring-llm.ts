import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { EditList, RunRecord } from "./schema.ts";
import { LlmPort, PlatformLlm, PortError, type TaskEnvelope } from "./ports.ts";

/**
 * preferring-llm.ts — the production LlmPort routing combinator.
 *
 * ONE generative port, resolved in a fixed order per call (admin edits
 * apply without a restart because the platform default is re-resolved
 * every call):
 *
 *   a) enabled `scope='platform'` `is_default` endpoint → the
 *      ai-provider plugin's `PlatformLlm.defaultLayer()` → LlmFactory;
 *   b) the configured fallback layer — env-derived providers
 *      (ANTHROPIC_API_KEY / LLM_* / Workers AI) bound by the
 *      composition root, or {@link nullLlmPort} when none exist;
 *   c) the consumer's own deterministic fallback (e.g. the anamnesis
 *      heuristic extractor) — port failures surface as PortError and
 *      the consumer decides.
 *
 * Platform-path failures degrade to the fallback exactly like an
 * unconfigured default: a broken platform endpoint must not take the
 * env-configured path down with it. `PlatformLlm` is read through
 * `Effect.serviceOption` — an absent plugin (or unbound port in tests)
 * resolves to the fallback, never an error.
 *
 * Records served by the platform endpoint are re-stamped
 * `engine: "platform:<engine>"` so run records keep the platform/env
 * distinction the pre-unification anamnesis path reported.
 */

/** Port that always fails — the "no configured fallback" inner port.
 * Consumers see an honest PortError and apply their deterministic
 * fallback; nothing is silently made up. */
const nullLlmPort: LlmPort["Service"] = LlmPort.of({
	egress: false,
	generate: () =>
		Effect.fail(new PortError({ port: "llm", message: "no generative endpoint configured" })),
	correct: () =>
		Effect.fail(new PortError({ port: "llm", message: "no generative endpoint configured" })),
});

/** `defaultLayer()` declares R=unknown because the plugin impl may
 * read credentials bound by composition; those are bound in the app
 * context, so the never-R view is sound here (same erasure
 * app-host/platform-llm.ts documented). */
const platformLayer: Effect.Effect<Layer.Layer<LlmPort> | null> = Effect.gen(function* () {
	const platform = yield* Effect.serviceOption(PlatformLlm);
	if (Option.isNone(platform)) return null;
	return yield* (platform.value.defaultLayer() as Effect.Effect<Layer.Layer<LlmPort> | null>).pipe(
		Effect.catch(() => Effect.succeed(null)),
		// Defects (e.g. the ai_endpoint table absent from a partial test
		// database) must also degrade to "no platform endpoint".
		Effect.catchDefect(() => Effect.succeed(null)),
	);
});

/** Run a port call against a resolved platform layer; ANY failure —
 * typed PortError, defect, layer-build problem — degrades to null so
 * the caller falls back. */
const viaPlatform = <A>(
	layer: Layer.Layer<LlmPort>,
	call: (llm: LlmPort["Service"]) => Effect.Effect<A, unknown>,
): Effect.Effect<A | null> =>
	Effect.gen(function* () {
		const llm = yield* LlmPort;
		return yield* call(llm);
	}).pipe(
		Effect.provide(layer),
		Effect.catch(() => Effect.succeed(null)),
		Effect.catchDefect(() => Effect.succeed(null)),
	);

const platformTag = <A extends { readonly record: RunRecord }>(res: A): A =>
	({
		...res,
		record: { ...res.record, engine: `platform:${res.record.engine}` },
	}) as A;

/** Service-level wrapper: `inner` is the fallback implementation
 * (env-derived or {@link nullLlmPort}). Both members route platform
 * first, fallback second. */
export const preferringLlmPort = (inner: LlmPort["Service"]): LlmPort["Service"] =>
	LlmPort.of({
		egress: inner.egress,
		generate: (envelope: TaskEnvelope) =>
			Effect.gen(function* () {
				const layer = yield* platformLayer;
				if (layer !== null) {
					const res = yield* viaPlatform(layer, (llm) => llm.generate(envelope));
					if (res !== null) return platformTag(res);
				}
				return yield* inner.generate(envelope);
			}),
		correct: (envelope: TaskEnvelope) =>
			Effect.gen(function* () {
				const layer = yield* platformLayer;
				if (layer !== null) {
					const res = yield* viaPlatform<{ edits: EditList; record: RunRecord }>(layer, (llm) =>
						llm.correct(envelope),
					);
					if (res !== null) return platformTag(res);
				}
				return yield* inner.correct(envelope);
			}),
	});

/** Layer form of {@link preferringLlmPort}: binds LlmPort to the
 * platform-preferring wrapper over `fallback` (omit for the null port —
 * platform-or-nothing resolution). The returned layer is self-contained
 * (RIn=never): the platform endpoint is probed per call through the
 * ambient context, never captured at build time. */
export const preferringLlmPortLive = (fallback?: Layer.Layer<LlmPort>): Layer.Layer<LlmPort> =>
	Layer.unwrap(
		Effect.map(
			fallback === undefined
				? Effect.succeed(nullLlmPort)
				: Effect.service(LlmPort).pipe(Effect.provide(fallback)),
			(inner) => Layer.succeed(LlmPort, preferringLlmPort(inner)),
		),
	);
