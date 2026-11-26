import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { JsonObject } from "effect/Schema";

import { OrchestratorRegistry } from "./registry.ts";
import {
	NodeExecutionError,
	type KindResult,
	type NodeContext,
	type OrchestrationEvent,
	type OrchestrationKind,
} from "./types.ts";

/**
 * kinds.ts — the built-in node kinds shipped with @ktb/orchestrator.
 * They prove the kind contract end-to-end: read `ctx.event`/`ctx.state`/
 * `ctx.params`, emit follow-up events via `ctx.emit` (or return them on
 * `KindResult.events`), write state via `KindResult.state`/`output`.
 *
 * `emit`/`gate`/`poll` are domain-blind orchestration semantics. `ai`
 * and `subworkflow` bind ambient services: `ai` probes the eval AI ports
 * (LlmPort/DecisionsPort/AsrPort and the PlatformLlm/PlatformDecisions
 * default-endpoint factories) via `Effect.serviceOption`, and
 * `subworkflow` probes the `OrchestratorRegistry` service itself for
 * nested runs. Absent ports degrade to `{skipped: true}` outputs — the
 * configured event is still emitted so graphs keep routing — because
 * orchestrations must not hard-fail on optional ambient bindings.
 *
 * No platform APIs, no node:*, no bun:*, no process, no provider
 * literals — the package runs unchanged in workerd. `crypto` and
 * `Date.now` are web-standard and safe.
 */

const asObject = (value: unknown): JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `emit` — emits the literal event specs in `params.events`
 * (`[{type, payload?}]`). No templating: payloads are emitted verbatim. */
export const emitKind: OrchestrationKind = {
	id: "emit",
	run: (ctx) =>
		Effect.gen(function* () {
			const specs = Array.isArray(ctx.params["events"]) ? ctx.params["events"] : [];
			for (const spec of specs) {
				const { type, payload } = asObject(spec);
				if (typeof type === "string") {
					yield* ctx.emit(type, asObject(payload));
				}
			}
			return {};
		}),
};

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

/** Loose equality for gate checks: strict equality, falling back to a
 * JSON comparison so object/array literals in params compare by value. */
const looseEquals = (a: unknown, b: unknown): boolean => {
	if (a === b) {
		return true;
	}
	if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
		try {
			return JSON.stringify(a) === JSON.stringify(b);
		} catch {
			return false;
		}
	}
	return false;
};

/** `gate` — a conditional router. Params:
 * - `when: {path, equals}` — `path` resolution: a dotted path
 *   (`"state.count"`, `"payload.id"`) is resolved against
 *   `{state, payload, params}`; a bare path (`"count"`) is looked up in
 *   run `state` first, then the triggering event's payload, then
 *   `params`;
 * - `passEvent` / `failEvent` — event types emitted on each branch
 *   (defaults `"gate.pass"` / `"gate.fail"`). */
export const gateKind: OrchestrationKind = {
	id: "gate",
	run: (ctx) =>
		Effect.gen(function* () {
			const when = asObject(ctx.params["when"]);
			const path = typeof when["path"] === "string" ? when["path"] : "";
			const scope = { state: ctx.state, payload: ctx.event.payload, params: ctx.params };
			const actual = path.includes(".")
				? getPath(scope, path)
				: (getPath(ctx.state, path) ?? getPath(ctx.event.payload, path) ?? ctx.params[path]);
			const pass = looseEquals(actual, when["equals"]);
			const passEvent =
				typeof ctx.params["passEvent"] === "string" ? ctx.params["passEvent"] : "gate.pass";
			const failEvent =
				typeof ctx.params["failEvent"] === "string" ? ctx.params["failEvent"] : "gate.fail";
			yield* ctx.emit(pass ? passEvent : failEvent, {
				path,
				expected: when["equals"] ?? null,
				actual: actual ?? null,
			} as JsonObject);
			return { output: { result: pass ? "pass" : "fail", path, actual: actual ?? null } };
		}),
};

// ---------------------------------------------------------------------------
// Template interpolation (`${event.payload.x}` / `${state.x}` /
// `${config.x}` / `${params.x}` / `${node.id}`) — a plain dotted-path
// resolver, no expression evaluation.
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
// Ambient AI port probes — structural mirrors of the eval port tags.
//
// The orchestrator cannot import @ktb/eval-consultation (it pulls
// better-sqlite3 and would couple this package to the eval domain), so
// the probes are declared locally with IDENTICAL Context key strings.
// Effect contexts key services by the tag's `key` string, so a service
// provided under the canonical tag (`LlmPort`, `DecisionsPort`,
// `AsrPort`, `PlatformLlm`, `PlatformDecisions` in the eval packages)
// resolves through these probes — and test stubs provided under the
// Ambient* tags land in the same slot. Shapes are the minimal surface
// the kinds call; extra fields on the real services are ignored.
// ---------------------------------------------------------------------------

/** Structural mirror of the eval `TaskEnvelope` (eval-core ports). */
export interface AmbientTaskEnvelope {
	readonly taskId: string;
	readonly role: "generator" | "corrector";
	readonly input: string;
	readonly outputSchema: string;
	readonly seed?: number;
	readonly modelHint?: string;
}

/** Mirror of `@ktb/eval-consultation/LlmPort` — generative endpoint.
 * `generate` takes the ACP task envelope and resolves `{text, record}`
 * (both pass through to the node output/event payload). */
export interface AmbientLlmPortShape {
	readonly egress?: boolean;
	readonly generate: (envelope: AmbientTaskEnvelope) => Effect.Effect<unknown, unknown, unknown>;
}

/** Mirror of `@ktb/eval-core/EvalPort` (a.k.a. `DecisionsPort`) — the
 * typed decision/judge port. `judge` resolves `{answers, record}`. */
export interface AmbientDecisionsPortShape {
	readonly egress?: boolean;
	readonly judge: (input: {
		readonly state: unknown;
		readonly questions: readonly unknown[];
	}) => Effect.Effect<unknown, unknown, unknown>;
}

/** Mirror of `@ktb/eval-consultation/AsrPort` — speech-to-text.
 * `transcribe` takes an AudioRef-shaped `{uri, …}` and resolves
 * `{asr, record}`. */
export interface AmbientAsrPortShape {
	readonly egress?: boolean;
	readonly transcribe: (
		audio: unknown,
		opts?: { readonly language?: string },
	) => Effect.Effect<unknown, unknown, unknown>;
}

/** Mirror of `@ktb/eval-consultation/PlatformLlm` — resolves the
 * platform-default generative endpoint to a bound `LlmPort` layer (or
 * `null` when unconfigured). This is the production binding path: the
 * ai-provider plugin provides it; direct `LlmPort` bindings win when
 * both are present. */
export interface AmbientPlatformLlmShape {
	readonly defaultLayer: () => Effect.Effect<Layer.Layer<AmbientLlmPort> | null, unknown, unknown>;
}

/** Mirror of `@ktb/eval-consultation/PlatformDecisions` — the decision
 * sibling of {@link AmbientPlatformLlmShape}. */
export interface AmbientPlatformDecisionsShape {
	readonly defaultLayer: () => Effect.Effect<
		Layer.Layer<AmbientDecisionsPort> | null,
		unknown,
		unknown
	>;
}

export class AmbientLlmPort extends Context.Service<AmbientLlmPort, AmbientLlmPortShape>()(
	"@ktb/eval-consultation/LlmPort",
) {}

export class AmbientDecisionsPort extends Context.Service<
	AmbientDecisionsPort,
	AmbientDecisionsPortShape
>()("@ktb/eval-core/EvalPort") {}

export class AmbientAsrPort extends Context.Service<AmbientAsrPort, AmbientAsrPortShape>()(
	"@ktb/eval-consultation/AsrPort",
) {}

export class AmbientPlatformLlm extends Context.Service<
	AmbientPlatformLlm,
	AmbientPlatformLlmShape
>()("@ktb/eval-consultation/PlatformLlm") {}

export class AmbientPlatformDecisions extends Context.Service<
	AmbientPlatformDecisions,
	AmbientPlatformDecisionsShape
>()("@ktb/eval-consultation/PlatformDecisions") {}

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

const llmEnvelope = (call: AiCall): AmbientTaskEnvelope => {
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
const decisionInput = (call: AiCall): { state: unknown; questions: readonly unknown[] } => {
	const input = call.input;
	const state = isRecord(input?.["state"]) ? input["state"] : (input ?? { prompt: call.prompt });
	const questions = Array.isArray(input?.["questions"]) ? input["questions"] : [];
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
		const direct = yield* Effect.serviceOption(AmbientLlmPort);
		const envelope = llmEnvelope(call);
		if (Option.isSome(direct)) {
			return yield* direct.value.generate(envelope);
		}
		const platform = yield* Effect.serviceOption(AmbientPlatformLlm);
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
			const llm = yield* AmbientLlmPort;
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
		const direct = yield* Effect.serviceOption(AmbientDecisionsPort);
		const judgment = decisionInput(call);
		if (Option.isSome(direct)) {
			return yield* direct.value.judge(judgment);
		}
		const platform = yield* Effect.serviceOption(AmbientPlatformDecisions);
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
			const decisions = yield* AmbientDecisionsPort;
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
		const port = yield* Effect.serviceOption(AmbientAsrPort);
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
		return yield* port.value.transcribe(audio, {
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
export const aiKind: OrchestrationKind = {
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

// ---------------------------------------------------------------------------
// `poll` kind — emit-per-fire tick.
// ---------------------------------------------------------------------------

/** `poll` — on every fire, emit `params.emitEvent` (default
 * `"<nodeId>.tick"`) carrying `{count}` — the node's successful-fire
 * ordinal, read back from its own previous `output` at
 * `state[node.id]` (`intervalMs` is echoed into the payload when set).
 *
 * PHASE-1 LIMITATION: this kind does NOT schedule real intervals — it
 * emits once per triggering event. A self-sustaining poll is expressed
 * by subscribing the node to its own tick event (`on: ["<trigger>",
 * "<nodeId>.tick"]`) and bounding it with the ENGINE's node policies:
 * `until`/`retireOn` for `params.untilEvent` and `maxFires` for
 * `params.maxPolls` (+1 when the node also fires on the initial
 * trigger). True wall-clock intervals need the durable runner to
 * re-enqueue a delayed step — a later phase; `intervalMs` is carried
 * in the payload now so that scheduling layer can honor it. */
export const pollKind: OrchestrationKind = {
	id: "poll",
	run: (ctx) =>
		Effect.sync((): KindResult => {
			const previous = asObject(ctx.state[ctx.node.id]);
			const count = typeof previous["count"] === "number" ? previous["count"] + 1 : 1;
			const emitEvent =
				typeof ctx.params["emitEvent"] === "string"
					? ctx.params["emitEvent"]
					: `${ctx.node.id}.tick`;
			const intervalMs = ctx.params["intervalMs"];
			const payload = (
				typeof intervalMs === "number" ? { count, intervalMs } : { count }
			) as JsonObject;
			return {
				output: { count },
				events: [{ type: emitEvent, payload }],
			};
		}),
};

// ---------------------------------------------------------------------------
// `subworkflow` kind — nested orchestration runs.
// ---------------------------------------------------------------------------

/** Ambient recursion-depth counter for `subworkflow` nodes — a
 * `Context.Reference` (self-defaulting, never a requirement) so depth is
 * tracked per-run-fiber, not globally. The kind increments it around the
 * nested `registry.run`; the default `0` means top-level runs. */
export const OrchestrationDepth = Context.Reference<number>("@ktb/orchestrator/depth", {
	defaultValue: () => 0,
});

/** `subworkflow` — run another registered orchestration def to
 * quiescence and surface its result. Params:
 * - `defId` (string, required) — the child orchestration id;
 * - `inputFrom` — `"event"` (default): the triggering event becomes the
 *   child's initial event verbatim (type + payload preserved, so child
 *   nodes subscribe to the same event type); `"state"`: the accumulated
 *   run state snapshot becomes an `"input"` event payload;
 * - `maxDepth` — recursion cap, default 3; a node firing at depth >=
 *   maxDepth fails with {@link NodeExecutionError};
 * - `emitEvent` — event type for the child outcome (default
 *   `"subworkflow.done"`), payload `{defId, status}`.
 *
 * Resolution: the kind probes `OrchestratorRegistry` via
 * `Effect.serviceOption` — the ambient-context idiom, no `NodeContext`
 * change. Callers must provide the service around `run`
 * (`Effect.provideService(OrchestratorRegistry, registry)` or a Layer);
 * when absent the node degrades to `{skipped: true, reason:
 * "no-registry"}` exactly like the `ai` port degrade. Note that a child
 * run's NODE failures are data, not errors: they surface as
 * `output.status: "failed"` (with the child's trace inside its result),
 * while unknown def ids / budget failures reject and become node
 * failures here. */
export const subworkflowKind: OrchestrationKind = {
	id: "subworkflow",
	run: (ctx) =>
		Effect.gen(function* () {
			const nodeId = ctx.node.id;
			const defId = typeof ctx.params["defId"] === "string" ? ctx.params["defId"] : "";
			if (defId === "") {
				return yield* new NodeExecutionError({
					nodeId,
					message: "subworkflow kind requires params.defId",
				});
			}
			const depth = yield* OrchestrationDepth;
			const maxDepthParam = ctx.params["maxDepth"];
			const maxDepth = typeof maxDepthParam === "number" ? maxDepthParam : 3;
			if (depth >= maxDepth) {
				return yield* new NodeExecutionError({
					nodeId,
					message: `subworkflow depth ${depth} exceeds maxDepth ${maxDepth} (defId ${defId})`,
				});
			}
			const registryOpt = yield* Effect.serviceOption(OrchestratorRegistry);
			const emitEvent =
				typeof ctx.params["emitEvent"] === "string" ? ctx.params["emitEvent"] : "subworkflow.done";
			if (Option.isNone(registryOpt)) {
				const skipped = { skipped: true, reason: "no-registry", defId };
				return {
					output: skipped,
					events: [{ type: emitEvent, payload: skipped as JsonObject }],
				};
			}
			const inputFrom = ctx.params["inputFrom"] === "state" ? "state" : "event";
			const input = inputFrom === "state" ? { ...ctx.state } : ctx.event;
			const result = yield* registryOpt.value.run(defId, input).pipe(
				Effect.provideService(OrchestrationDepth, depth + 1),
				Effect.mapError(
					(error) =>
						new NodeExecutionError({
							nodeId,
							message: `subworkflow ${defId} failed: ${error.message}`,
							cause: error,
						}),
				),
			);
			return {
				output: { defId, status: result.status, state: result.state },
				events: [
					{
						type: emitEvent,
						payload: { defId, status: result.status } as JsonObject,
					},
				],
			};
		}),
};

/** The built-in kind set — pass to `makeOrchestratorRegistry(kinds)` or
 * `OrchestratorRegistryLive(kinds, defs)`. */
export const builtinKinds: readonly OrchestrationKind[] = [
	emitKind,
	gateKind,
	aiKind,
	pollKind,
	subworkflowKind,
];
