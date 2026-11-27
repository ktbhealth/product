import * as Data from "effect/Data";
import type { JsonObject } from "effect/Schema";
import type * as Effect from "effect/Effect";

/**
 * types.ts — the orchestration contract. An orchestration is a set of
 * NODES reacting to typed EVENTS; the graph is implicit — there are no
 * declared edges, routing emerges from each node's `on` event-type
 * subscriptions (peregrin-inspired, simplified to a single process).
 *
 * An {@link OrchestrationDef} declares the nodes (data); each node names
 * a {@link OrchestrationKind} (code) resolved through the registry —
 * or carries an inline `handler` for tests/self-contained defs. Kinds
 * emit follow-up events through the `emit` function on {@link
 * NodeContext}; the runner routes those events back to subscribed
 * nodes, which is what makes chains, branches and joins fall out of
 * event types alone.
 *
 * No platform APIs, no node:*, no bun:*, no process, no provider
 * literals — the package runs unchanged in workerd. `crypto` and
 * `Date.now` are web-standard and safe.
 */

/** JSON object payload carried by events, node params, config and
 * state. Sourced from `effect/Schema` like the eval packages. */
export type { JsonObject } from "effect/Schema";

/** A typed event flowing through an orchestration. `source` names the
 * emitter (a node id, "orchestrator" for lifecycle/synthetic events, or
 * whatever the `run` caller passed as input source). */
export interface OrchestrationEvent {
	readonly type: string;
	readonly payload: JsonObject;
	readonly source: string;
	readonly id: string;
	readonly ts: number;
}

const makeEvent = (
	type: string,
	payload: JsonObject = {},
	source = "orchestrator",
): OrchestrationEvent => ({
	type,
	payload,
	source,
	id: `evt-${crypto.randomUUID().slice(0, 13)}`,
	ts: Date.now(),
});

/** Constructors and lifecycle helpers for {@link OrchestrationEvent}.
 * `new` is a reserved word so it cannot be a namespace export — the
 * helpers live on a const merged with the interface instead; call
 * sites read `OrchestrationEvent.new(...)` as usual. `id` is a random
 * uuid slice (web-standard `crypto.randomUUID`, workerd-safe); `ts` is
 * `Date.now()`. */
export const OrchestrationEvent = {
	/** Build an event. */
	new: makeEvent,

	/** The synthetic event every run starts with (unless `run` is given
	 * an explicit input event). Nodes opt in via `on: ["start"]`. */
	start: (source = "orchestrator"): OrchestrationEvent => makeEvent("start", {}, source),

	/** Emitted by the runner when the event queue drains and no node
	 * can fire again — the workflow completed. */
	done: (): OrchestrationEvent => makeEvent("workflow.done", {}, "orchestrator"),

	/** Cancellation signal — a node (or injected input) emitting this
	 * type stops the run with status "cancelled". */
	cancel: (reason: string): OrchestrationEvent =>
		makeEvent("workflow.cancel", { reason }, "orchestrator"),

	/** Lifecycle: a node fire failed (after retries, if configured). */
	nodeFailed: (nodeId: string, error: string): OrchestrationEvent =>
		makeEvent("node.failed", { nodeId, error }, "orchestrator"),

	/** Lifecycle: a node hit its `maxFires` cap and retired. */
	nodeExhausted: (nodeId: string): OrchestrationEvent =>
		makeEvent("node.exhausted", { nodeId }, "orchestrator"),

	/** Lifecycle: the run ended because a node failure halted it
	 * (`onNodeError: "halt"`, the default). */
	workflowFailed: (nodeId: string, error: string): OrchestrationEvent =>
		makeEvent("workflow.failed", { nodeId, error }, "orchestrator"),

	/** Lifecycle/diagnostic: an event that could not be routed or was
	 * rejected (reserved for schema validation in later phases). */
	eventInvalid: (message: string, detail?: JsonObject): OrchestrationEvent =>
		makeEvent(
			"event.invalid",
			Object.assign({ message }, detail ?? {}) as JsonObject,
			"orchestrator",
		),
};

/** Declarative contract for an event type: `type` is the routing key;
 * `fields` is a shorthand `{field: kind}` contract and `schema` an
 * optional JSON-schema override. Phase 1 stores these for documentation
 * and future validation — nothing enforces them yet. */
export interface EventSchema {
	readonly type: string;
	readonly fields?: Readonly<Record<string, string>>;
	readonly schema?: JsonObject;
}

/** Join policy. `{count: n}` — the node fires once N matching events
 * have been collected (payloads merged in arrival order). `{until:
 * types}` — the node fires once it has seen at least one event of
 * every listed type. After firing the buffer resets and collection
 * starts over. */
export type FanInSpec = { readonly count: number } | { readonly until: readonly string[] };

/** One node in an {@link OrchestrationDef}. `on` lists the event types
 * that trigger it; `emits` documents the types it may produce (not
 * enforced in phase 1). `mode` is accepted for forward compatibility —
 * both "any" and "all" fire the node once per matching event in phase 1
 * ("all" is reserved for per-subscription fan-out semantics later).
 *
 * Lifecycle/policy fields:
 * - `maxFires` — cap on successful fires; reaching it emits
 *   `node.exhausted` and retires the node. `"unlimited"` or absent = no
 *   cap. `0` retires the node before the run starts.
 * - `until` / `retireOn` — event types that retire the node when they
 *   occur (the retiring event does not itself fire the node).
 * - `retry` — `Effect.retry` policy: up to `maxAttempts` total attempts
 *   (default 3 when `retry` is present) with exponential backoff starting
 *   at `backoffMs` (default 100).
 * - `circuitBreaker` — after `failureThreshold` (default 5) consecutive
 *   failures the node's circuit opens for `cooldownMs` (default 30000);
 *   fires during the open window are recorded as "skipped".
 * - `fanIn` — see {@link FanInSpec}; the node waits for the join before
 *   firing and receives the merged payloads on `ctx.event.payload`.
 * - `state` — initial per-node state merged into the run state.
 * - `handler` — optional inline {@link OrchestrationKind}; when absent
 *   the node resolves `kind` through the registry (validated at
 *   `registerDef` time). */
export interface OrchestrationNode {
	readonly id: string;
	readonly kind: string;
	readonly handler?: OrchestrationKind;
	readonly on: readonly string[];
	readonly emits: readonly string[];
	readonly mode?: "any" | "all";
	readonly params?: JsonObject;
	readonly maxFires?: number | "unlimited";
	readonly until?: readonly string[];
	readonly retireOn?: readonly string[];
	readonly retry?: {
		readonly maxAttempts?: number;
		readonly backoffMs?: number;
	};
	readonly circuitBreaker?: {
		readonly failureThreshold?: number;
		readonly cooldownMs?: number;
	};
	readonly fanIn?: FanInSpec;
	readonly state?: JsonObject;
	readonly input?: EventSchema;
	readonly output?: readonly EventSchema[];
}

/** The declarative half of an orchestration: identity, config, the node
 * list and optional event schemas. `onNodeError` is the def-level node
 * failure policy — "halt" (default) ends the run with `node.failed` +
 * `workflow.failed` lifecycle events; "continue" records the failure
 * and keeps routing. A `run` call may override it per invocation. */
export interface OrchestrationDef {
	readonly id: string;
	readonly version?: string;
	readonly description?: string;
	readonly config?: JsonObject;
	readonly onNodeError?: "halt" | "continue";
	readonly nodes: readonly OrchestrationNode[];
	readonly eventSchemas?: readonly EventSchema[];
}

/** Everything a kind sees on each fire. `event` is the triggering
 * event (for fanIn joins, a synthetic event whose payload merges the
 * collected payloads in arrival order plus an `events` array of the
 * raw payloads and an `eventTypes` array). `node` is the def entry;
 * `config` is the merged orchestration config; `state` is a snapshot
 * of the accumulated run state; `params` is `node.params`;
 * `emit(type, payload)` enqueues an event routed back through the
 * runner — kinds never touch the queue directly. */
export interface NodeContext {
	readonly event: OrchestrationEvent;
	readonly node: OrchestrationNode;
	readonly config: Readonly<JsonObject>;
	readonly state: Readonly<Record<string, unknown>>;
	readonly params: Readonly<JsonObject>;
	readonly emit: (type: string, payload?: JsonObject) => Effect.Effect<void>;
}

/** What a kind returns: `state` merges into the run state,
 * `events` are emitted with the node as source (equivalent to calling
 * `ctx.emit` for each), and `output` is stored at `state[node.id]`. */
export interface KindResult {
	readonly state?: JsonObject;
	readonly events?: readonly {
		readonly type: string;
		readonly payload?: JsonObject;
	}[];
	readonly output?: unknown;
}

/** A node-kind handler — the code half of a node, registered once and
 * shared by every node that names its `id` as `kind`. The error
 * channel is `unknown` (same idiom as `PipelineStage`) — kinds may fail
 * with the typed {@link NodeExecutionError} (or any member of
 * {@link OrchestratorError}) or any foreign error, which the runner
 * normalizes into the node-failure path. Kinds should probe ambient
 * ports via `Effect.serviceOption`. */
export interface OrchestrationKind {
	readonly id: string;
	readonly run: (ctx: NodeContext) => Effect.Effect<KindResult, unknown, unknown>;
}

/** A kind failed during a node fire — `nodeId` identifies the def
 * entry, `message` is human-readable, `cause` chains the underlying
 * failure. This is the typed error kinds should raise for node-level
 * failures; foreign error values are normalized into the same shape by
 * the runner. */
export class NodeExecutionError extends Data.TaggedError("NodeExecutionError")<{
	readonly nodeId: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** `run`/`get` was called for an orchestration id that was never
 * registered. */
export class UnknownOrchestrationError extends Data.TaggedError("UnknownOrchestrationError")<{
	readonly orchestrationId: string;
}> {}

/** An orchestration id was registered twice — ids are unique across
 * the registry. */
export class DuplicateOrchestrationError extends Data.TaggedError("DuplicateOrchestrationError")<{
	readonly orchestrationId: string;
}> {}

/** A node's `kind` (with no inline `handler`) has no registered
 * {@link OrchestrationKind} — rejected at `registerDef` time, never
 * mid-run. */
export class UnknownKindError extends Data.TaggedError("UnknownKindError")<{
	readonly kind: string;
	readonly nodeId?: string;
	readonly orchestrationId?: string;
}> {}

/** A kind id was registered twice. */
export class DuplicateKindError extends Data.TaggedError("DuplicateKindError")<{
	readonly kind: string;
}> {}

/** Reserved for node-level references that cannot be resolved (e.g. a
 * future `onNode`/`target` edge syntax). Defined now so the error
 * vocabulary is stable; phase 1 has no producer. */
export class UnknownNodeError extends Data.TaggedError("UnknownNodeError")<{
	readonly nodeId: string;
	readonly orchestrationId?: string;
}> {}

/** A pack = kind handlers (code) + an optional def (data), contributed
 * by a plugin — the {@link OrchestrationDef} analog of `@ktb/pipeline`'s
 * {@link PipelinePack}. `kinds` are the handlers a def's nodes resolve
 * by `node.kind`; they register into the same {@link
 * OrchestratorRegistry} as `builtinKinds`. `def` is OPTIONAL: a
 * kinds-only pack contributes shared kind vocabulary (e.g. the
 * eval-port `ai` kind from @ktb/orchestrator-ai) without shipping a
 * runnable orchestration. */
export interface OrchestrationPack {
	readonly def?: OrchestrationDef;
	readonly kinds: readonly OrchestrationKind[];
}

/** Per-fire audit entry. Statuses: "ok" — the fire succeeded;
 * "skipped" — the fire was suppressed by an open circuit breaker;
 * "failed" — the fire failed (after retries) under either node-error
 * policy. `fires` is the node's successful-fire count at record time. */
export interface NodeRunRecord {
	readonly nodeId: string;
	readonly status: "ok" | "skipped" | "failed";
	readonly latencyMs: number;
	readonly error?: string;
	readonly fires: number;
}

/** Per-run options: `config` merges over `def.config`;
 * `onNodeError` overrides the def-level policy; `maxEvents` bounds the
 * total events processed (default 1000) so event cycles cannot spin
 * forever — exceeding it fails the run with {@link
 * OrchestrationRunError}. */
export interface RunOptions {
	readonly config?: JsonObject;
	readonly onNodeError?: "halt" | "continue";
	readonly maxEvents?: number;
}

/** The outcome of a run. `status` is "done" (queue drained, lifecycle
 * `workflow.done` emitted), "failed" (a node failure halted the run —
 * `node.failed` + `workflow.failed` were emitted), or "cancelled" (a
 * `workflow.cancel` event was processed). `events` is every event
 * dequeued, in order, including lifecycle events; `trace` is the
 * per-fire audit; `state` is the accumulated node state/outputs. */
export interface OrchestrationRunResult {
	readonly orchestrationId: string;
	readonly status: "done" | "failed" | "cancelled";
	readonly events: readonly OrchestrationEvent[];
	readonly trace: readonly NodeRunRecord[];
	readonly state: Readonly<Record<string, unknown>>;
}

/** The run failed before producing a result — unknown orchestration
 * id or the event budget was exceeded. `trace` carries the audit up to
 * the failure (empty for unknown-id failures). Node-level failures do
 * NOT surface here; they are recorded in the result's trace/events. */
export class OrchestrationRunError extends Data.TaggedError("OrchestrationRunError")<{
	readonly orchestrationId: string;
	readonly nodeId?: string;
	readonly message: string;
	readonly cause?: unknown;
	readonly trace: readonly NodeRunRecord[];
}> {}

/** Union of every typed error this package raises — the error channel
 * kinds may use for node-level failures. */
export type OrchestratorError =
	| NodeExecutionError
	| UnknownOrchestrationError
	| DuplicateOrchestrationError
	| UnknownKindError
	| DuplicateKindError
	| UnknownNodeError
	| OrchestrationRunError;
