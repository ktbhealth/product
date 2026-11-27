import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { JsonObject } from "effect/Schema";

import type { AudioRef } from "@ktb/eval-consultation/schema";
import { AsrPort } from "@ktb/eval-consultation/ports";
import {
	DecisionsPort,
	LlmPort,
	PlatformDecisions,
	PlatformLlm,
	type EvalQuestion,
	type TaskEnvelope,
} from "@ktb/eval-core";
import {
	NodeExecutionError,
	type NodeContext,
	type OrchestrationEvent,
	type OrchestrationKind,
	type OrchestrationPack,
} from "@ktb/orchestrator";

/**
 * orchestrator-ai — the `ai` orchestration kind, moved out of
 * @ktb/orchestrator's builtins so the engine package stays
 * domain-blind. The kind binds EVAL ports: it probes the canonical
 * service tags (`LlmPort`/`DecisionsPort`/`AsrPort` and the
 * `PlatformLlm`/`PlatformDecisions` default-endpoint factories from
 * @ktb/eval-core + @ktb/eval-consultation) via `Effect.serviceOption`.
 * Absent ports degrade to `{skipped: true, reason: "no-port"}` outputs
 * — the configured event is still emitted so graphs keep routing —
 * because orchestrations must not hard-fail on optional ambient
 * bindings.
 *
 * This package CAN import the eval ports (unlike @ktb/orchestrator,
 * which must stay workerd-safe and domain-free): consumers are plugin
 * manifests (`orchestrations` packs — ai.provider.services today) and
 * plugin-free runtimes that register the kind explicitly
 * (apps/jobs-worker).
 */

const asObject = (value: unknown): JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolve a dot-separated `path` against `root`, one segment at a
 * time. Returns `undefined` when any segment is missing. */
const getPath = (root: unknown, path: string): unknown => {
	let current = root;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
};

// ---------------------------------------------------------------------------
// Template interpolation (`${event.payload.x}` / `${state.x}` /
// `${config.x}` / `${params.x}` / `${node.id}`) — a plain dotted-path
// resolver, no expression evaluation. Moved here with the `ai` kind:
// it is the only kind that interpolates.
// ---------------------------------------------------------------------------

/** Everything `${…}` placeholders resolve against. */
interface InterpolationScope {
	readonly event: OrchestrationEvent;
	readonly state: Readonly<Record<string, unknown>>;
	readonly config: Readonly<JsonObject>;
	readonly params: Readonly<JsonObject>;
	readonly node: { readonly id: string };
}

const interpolationScope = (ctx: NodeContext): InterpolationScope => ({
	event: ctx.event,
	state: ctx.state,
	config: ctx.config,
	params: ctx.params,
	node: { id: ctx.node.id },
});

/** Render one resolved placeholder value as text: strings pass through
 * raw, objects/arrays JSON-encode (unserializable values degrade to
 * `""`), everything else stringifies. `null`/`undefined` → `""`. */
const stringifyPlaceholder = (value: unknown): string => {
	if (value === undefined || value === null) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "object") {
		try {
			// Objects always serialize to a string or throw — the catch
			// covers circular references leaking in through `unknown`
			// state/output values.
			return JSON.stringify(value);
		} catch {
			return "";
		}
	}
	// Only primitives remain here (number/boolean/bigint/symbol/
	// function) — String() renders all of them. The cast narrows
	// `unknown` for no-base-to-string; objects were handled above.
	return String(value as number);
};

const PLACEHOLDER = /\$\{([^{}]+)\}/g;

/** Substitute every `${dotted.path}` in `template` against `scope`.
 * Unresolvable paths render as the empty string. */
const interpolate = (template: string, scope: InterpolationScope): string =>
	template.replace(PLACEHOLDER, (_match, path: string) =>
		stringifyPlaceholder(getPath(scope, path.trim())),
	);

/** Deep-interpolate string leaves inside `params.input`-style JSON —
 * arrays and plain objects recurse; scalars pass through. The result
 * keeps the input's shape (typed `JsonObject` by the caller). */
const interpolateValue = (value: unknown, scope: InterpolationScope): unknown => {
	if (typeof value === "string") {
		return interpolate(value, scope);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => interpolateValue(entry, scope));
	}
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			out[key] = interpolateValue(entry, scope);
		}
		return out;
	}
	return value;
};

// ---------------------------------------------------------------------------
// `ai` kind — template + ambient port call.
// ---------------------------------------------------------------------------

type AiKindName = "llm" | "decide" | "asr";

/** Everything the port dispatch needs, precomputed per fire. */
interface AiCall {
	readonly nodeId: string;
	readonly eventId: string;
	readonly prompt: string;
	readonly input: JsonObject | undefined;
	readonly model: string | undefined;
	readonly outputSchema: unknown;
}

/** The graceful-degradation payload — emitted (and stored as output)
 * when no suitable port is bound in the ambient context. Pipelines must
 * not hard-fail on optional ports, so absence is data, not an error. */
const noPort = (kind: AiKindName): JsonObject => ({
	skipped: true,
	reason: "no-port",
	kind,
});

/** `outputSchema` param → the envelope's string contract: a string
 * passes through, an object prefers its `name`/`type` field, anything
 * else JSON-encodes, and absent/non-object values default to `"Text"`
 * (the eval pipeline's convention for free-text generation). */
const schemaName = (value: unknown): string => {
	if (typeof value === "string") {
		return value;
	}
	if (isRecord(value)) {
		const named = value["name"] ?? value["type"];
		if (typeof named === "string") {
			return named;
		}
		return JSON.stringify(value);
	}
	return "Text";
};

const llmEnvelope = (call: AiCall): TaskEnvelope => {
	const seed = call.input?.["seed"];
	return {
		taskId: `orch-${call.nodeId}-${call.eventId}`,
		role: "generator",
		input: call.prompt,
		outputSchema: schemaName(call.outputSchema),
		...(call.model !== undefined ? { modelHint: call.model } : {}),
		...(typeof seed === "number" ? { seed } : {}),
	};
};

/** `params.input` becomes the judge `state` verbatim, unless it carries
 * an explicit `state` field (then that wins) — `questions` is read from
 * `input.questions` (array) and defaults to empty. With no `input` at
 * all the interpolated template becomes `{prompt}`. */
const decisionInput = (
	call: AiCall,
): {
	state: unknown;
	questions: readonly EvalQuestion[];
} => {
	const input = call.input;
	const state = isRecord(input?.["state"]) ? input["state"] : (input ?? { prompt: call.prompt });
	const questions = Array.isArray(input?.["questions"])
		? (input["questions"] as readonly EvalQuestion[])
		: [];
	return { state, questions };
};

/** Resolve the generative port: a directly-bound `LlmPort` wins; else
 * the `PlatformLlm` default endpoint (production path — resolves the
 * enabled platform `is_default` endpoint per call). Resolution and
 * layer-build failures degrade to `null` → `noPort`, matching the
 * app-host platform-llm fallback contract; defects inside the provided
 * layer also degrade (a broken platform endpoint must not kill the
 * run). Typed port errors still propagate as node failures. */
const callLlm = (call: AiCall): Effect.Effect<unknown, unknown, unknown> =>
	Effect.gen(function* () {
		const direct = yield* Effect.serviceOption(LlmPort);
		const envelope = llmEnvelope(call);
		if (Option.isSome(direct)) {
			return yield* direct.value.generate(envelope);
		}
		const platform = yield* Effect.serviceOption(PlatformLlm);
		if (Option.isNone(platform)) {
			return noPort("llm");
		}
		const layer = yield* platform.value.defaultLayer().pipe(
			Effect.catch(() => Effect.succeed(null)),
			Effect.catchDefect(() => Effect.succeed(null)),
		);
		if (layer === null) {
			return noPort("llm");
		}
		return yield* Effect.gen(function* () {
			const llm = yield* LlmPort;
			return yield* llm.generate(envelope);
		}).pipe(
			Effect.provide(layer),
			Effect.catchDefect(() => Effect.succeed(noPort("llm"))),
		);
	});

/** `decide` — same resolution order as {@link callLlm} but over the
 * decision port (`DecisionsPort`/`EvalPort` + `PlatformDecisions`). */
const callDecide = (call: AiCall): Effect.Effect<unknown, unknown, unknown> =>
	Effect.gen(function* () {
		const direct = yield* Effect.serviceOption(DecisionsPort);
		const judgment = decisionInput(call);
		if (Option.isSome(direct)) {
			return yield* direct.value.judge(judgment);
		}
		const platform = yield* Effect.serviceOption(PlatformDecisions);
		if (Option.isNone(platform)) {
			return noPort("decide");
		}
		const layer = yield* platform.value.defaultLayer().pipe(
			Effect.catch(() => Effect.succeed(null)),
			Effect.catchDefect(() => Effect.succeed(null)),
		);
		if (layer === null) {
			return noPort("decide");
		}
		return yield* Effect.gen(function* () {
			const decisions = yield* DecisionsPort;
			return yield* decisions.judge(judgment);
		}).pipe(
			Effect.provide(layer),
			Effect.catchDefect(() => Effect.succeed(noPort("decide"))),
		);
	});

/** `asr` — probes `AsrPort` only (there is no platform-default ASR
 * binding). Audio comes from `params.input.audio` (an AudioRef-shaped
 * object) or from `params.input` itself when it carries a string `uri`;
 * `input.language` maps to the transcribe opts. Missing audio is a node
 * configuration error ({@link NodeExecutionError}), not a degrade. */
const callAsr = (call: AiCall): Effect.Effect<unknown, unknown, unknown> =>
	Effect.gen(function* () {
		const port = yield* Effect.serviceOption(AsrPort);
		if (Option.isNone(port)) {
			return noPort("asr");
		}
		const input = call.input;
		const audio = isRecord(input?.["audio"])
			? input["audio"]
			: isRecord(input) && typeof input["uri"] === "string"
				? input
				: undefined;
		if (audio === undefined) {
			return yield* new NodeExecutionError({
				nodeId: call.nodeId,
				message: 'ai kind "asr" requires params.input.audio ({uri}) or an AudioRef-shaped input',
			});
		}
		const language = input?.["language"];
		return yield* port.value.transcribe(audio as AudioRef, {
			...(typeof language === "string" ? { language } : {}),
		});
	});

const callAiPort = (kind: AiKindName, call: AiCall): Effect.Effect<unknown, unknown, unknown> => {
	switch (kind) {
		case "llm":
			return callLlm(call);
		case "decide":
			return callDecide(call);
		case "asr":
			return callAsr(call);
	}
};

/** `ai` — interpolate the template, call the probed port, emit the
 * result. Params:
 * - `template` (string) — `${event.payload.x}` / `${state.x}` /
 *   `${config.x}` / `${params.x}` / `${node.id}` placeholders are
 *   resolved by dotted path (no expression eval); unresolvable → `""`;
 * - `kind` — `"llm"` (default) | `"decide"` | `"asr"`;
 * - `model` — generative calls only: maps to the envelope `modelHint`;
 * - `input` (object) — per-kind structured input, string leaves
 *   interpolated like the template: llm reads `seed`, decide reads
 *   `state`/`questions`, asr reads `audio`/`language`;
 * - `outputSchema` — llm only: string contract name (object → `name`/
 *   `type` field, default `"Text"`);
 * - `emitEvent` — event type for the result (default `"ai.done"`).
 *
 * Port resolution (llm/decide): direct port binding first, then the
 * Platform* default-layer factory — the same order app-host uses.
 * When NO port is bound the node does NOT fail: output and the emitted
 * event carry `{skipped: true, reason: "no-port", kind}` so optional AI
 * stages degrade instead of killing the orchestration. */
export const aiOrchestrationKind: OrchestrationKind = {
	id: "ai",
	run: (ctx) =>
		Effect.gen(function* () {
			const nodeId = ctx.node.id;
			const emitEvent =
				typeof ctx.params["emitEvent"] === "string" ? ctx.params["emitEvent"] : "ai.done";
			const kindParam = ctx.params["kind"];
			const selected = kindParam === undefined ? "llm" : kindParam;
			if (selected !== "llm" && selected !== "decide" && selected !== "asr") {
				return yield* new NodeExecutionError({
					nodeId,
					message: `ai kind: unsupported kind ${JSON.stringify(selected)}`,
				});
			}
			const scope = interpolationScope(ctx);
			const template = typeof ctx.params["template"] === "string" ? ctx.params["template"] : "";
			const prompt = interpolate(template, scope);
			const rawInput = ctx.params["input"];
			const input = isRecord(rawInput)
				? (interpolateValue(rawInput, scope) as JsonObject)
				: undefined;
			const model = typeof ctx.params["model"] === "string" ? ctx.params["model"] : undefined;
			const result = yield* callAiPort(selected, {
				nodeId,
				eventId: ctx.event.id,
				prompt,
				input,
				model,
				outputSchema: ctx.params["outputSchema"],
			});
			return {
				output: result,
				events: [{ type: emitEvent, payload: asObject(result) }],
			};
		}),
};

/** The kinds this package contributes — just `ai` today; kept as a
 * list so additional eval-bound kinds slot in without manifest churn. */
export const aiOrchestrationKinds: readonly OrchestrationKind[] = [aiOrchestrationKind];

/** Kinds-only {@link OrchestrationPack} — no def: the `ai` kind is
 * shared vocabulary admins reference from their own defs, contributed
 * by whichever plugin binds it (ai.provider.services). Composition
 * roots without plugins (apps/jobs-worker) register
 * {@link aiOrchestrationKind} directly instead. */
export const aiOrchestrationPack: OrchestrationPack = {
	kinds: aiOrchestrationKinds,
};
