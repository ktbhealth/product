import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { JsonObject } from "effect/Schema";

import { OrchestratorRegistry } from "./registry.ts";
import { NodeExecutionError, type KindResult, type OrchestrationKind } from "./types.ts";

/**
 * kinds.ts — the built-in node kinds shipped with @ktb/orchestrator.
 * They prove the kind contract end-to-end: read `ctx.event`/`ctx.state`/
 * `ctx.params`, emit follow-up events via `ctx.emit` (or return them on
 * `KindResult.events`), write state via `KindResult.state`/`output`.
 *
 * `emit`/`gate`/`poll` are domain-blind orchestration semantics.
 * `subworkflow` binds one ambient service: it probes the
 * `OrchestratorRegistry` service itself for nested runs, and an absent
 * service degrades to `{skipped: true}` output — the configured event
 * is still emitted so graphs keep routing — because orchestrations
 * must not hard-fail on optional ambient bindings.
 *
 * The `ai` kind (template + eval-port call) is NOT builtin: it binds
 * eval-domain ports (LlmPort/DecisionsPort/AsrPort/Platform*), so it
 * lives in @ktb/orchestrator-ai and reaches registries through plugin
 * `orchestrations` packs — this package stays domain-blind and
 * workerd-safe.
 *
 * No platform APIs, no node:*, no bun:*, no process, no provider
 * literals — the package runs unchanged in workerd. `crypto` and
 * `Date.now` are web-standard and safe.
 */

const asObject = (value: unknown): JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

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
// `poll` kind — emit-per-fire tick.
// ---------------------------------------------------------------------------

/** `poll` — on every fire, emit `params.emitEvent` (default
 * `"<nodeId>.tick"`) carrying `{count}` — the node's successful-fire
 * ordinal, read back from its own previous `output` at
 * `state[node.id]` (`intervalMs` is echoed into the payload when set).
 *
 * REAL INTERVALS: when `params.intervalMs` is a positive number, the
 * emitted event carries `notBefore = firedAt + intervalMs` — delayed
 * routing (see {@link OrchestrationEvent.notBefore}). A self-sustaining
 * poll subscribes the node to its own tick event (`on: ["<trigger>",
 * "<nodeId>.tick"]`) and re-fires on a wall-clock cadence: the
 * in-memory runner sleeps until the wake instant and the durable
 * runner enqueues its next `orchestrator.step` job with `runAt` set,
 * which the jobs transport honors (Cloudflare `delaySeconds`, the
 * dev:node `run_at` column, the Redis delayed zset). Bound the loop
 * with the ENGINE's node policies: `until`/`retireOn` for
 * `params.untilEvent` and `maxFires` for `params.maxPolls` (+1 when
 * the node also fires on the initial trigger). Without `intervalMs`
 * the kind keeps its phase-1 emit-per-fire behavior — the tick is
 * due immediately and a self-subscription spins until a bound hits. */
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
			const hasInterval = typeof intervalMs === "number" && intervalMs > 0;
			const payload = (hasInterval ? { count, intervalMs } : { count }) as JsonObject;
			return {
				output: { count },
				events: [
					{
						type: emitEvent,
						payload,
						...(hasInterval ? { notBefore: Date.now() + (intervalMs as number) } : {}),
					},
				],
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
 * "no-registry"}` — absence is data, not an error. Note that a child
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
 * `OrchestratorRegistryLive(kinds, defs)`. Domain-bound kinds (the
 * eval-port `ai` kind in @ktb/orchestrator-ai) are contributed through
 * plugin `orchestrations` packs, not here. */
export const builtinKinds: readonly OrchestrationKind[] = [
	emitKind,
	gateKind,
	pollKind,
	subworkflowKind,
];
