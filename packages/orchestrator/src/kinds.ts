import * as Effect from "effect/Effect";
import type { JsonObject } from "effect/Schema";

import type { OrchestrationKind } from "./types.ts";

/**
 * kinds.ts — the built-in node kinds shipped with @ktb/orchestrator.
 * They prove the kind contract end-to-end: read `ctx.event`/`ctx.state`/
 * `ctx.params`, emit follow-up events via `ctx.emit` (or return them on
 * `KindResult.events`), write state via `KindResult.state`/`output`.
 * All are domain-blind — orchestration semantics only, no product
 * knowledge.
 */

const asObject = (value: unknown): JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

/** `emit` — emits the literal event specs in `params.events`
 * (`[{type, payload?}]`). No templating in phase 1: payloads are
 * emitted verbatim. */
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

/** `ai` — STUB. Params: `{template, model?, echo?}`. Returns
 * `{output: {prompt, model, echoed}}` where `echoed` is the triggering
 * event's payload when `echo` is true. This kind exists to prove the
 * contract for future real model ports (the ai-adapter-* packages own
 * the actual LLM bindings); phase 1 performs no model calls — `template`
 * is echoed back as `prompt` so downstream nodes can route on it. */
export const aiKind: OrchestrationKind = {
	id: "ai",
	run: (ctx) =>
		Effect.succeed({
			output: {
				prompt: typeof ctx.params["template"] === "string" ? ctx.params["template"] : "",
				model: typeof ctx.params["model"] === "string" ? ctx.params["model"] : undefined,
				echoed: ctx.params["echo"] === true ? ctx.event.payload : undefined,
			},
		}),
};

/** The built-in kind set — pass to `makeOrchestratorRegistry(kinds)` or
 * `OrchestratorRegistryLive(kinds, defs)`. */
export const builtinKinds: readonly OrchestrationKind[] = [emitKind, gateKind, aiKind];
