import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
	DocumentStore,
	DocumentWriteDepth,
	type DocumentRecordWrittenEvent,
} from "@ktb/document-store";
import { evaluateCondition, resolveAnswerPath } from "@ktb/wizards/condition";

import { TRIGGER_OPS, type TriggerDef } from "./definition.ts";
import { type TriggersHooksService, type TriggerHookHandle } from "./hooks.ts";

/**
 * Trigger runtime — pure dispatch over collected {@link TriggerDef}s.
 *
 * EXECUTION MODEL: the triggers service subscribes to
 * `document-store.record-written` on the app-wide `EventBus` via
 * `EventBus.stream` and consumes it on a forked fiber, so reaction
 * work is asynchronous and never blocks the writer's dispatch (the
 * bus only awaits after-commit handlers; stream consumers are
 * broadcast-only). Chose inline fire-and-forget over the
 * `@ktb/jobs-port` queue: trigger actions are cheap document writes or
 * in-process hook calls, failures are already isolated + logged per
 * trigger, and routing them through a durable queue would add a
 * binding + consumer for no v1 benefit — revisit if actions grow
 * expensive or need retries.
 *
 * LOOP PREVENTION: `collection-write` actions write back through
 * DocumentStore, which publishes new write events — a self-referencing
 * def would recurse forever. The cap is a cascade DEPTH, carried on
 * the event: DocumentStore stamps `DocumentWriteDepth` (a
 * `Context.Reference`, default 0) into every published event, and this
 * dispatcher wraps each action in
 * `Effect.provideService(DocumentWriteDepth, event.depth + 1)`. Events
 * at `depth >= TRIGGER_MAX_DEPTH` are skipped entirely — so a chain
 * fires at most TRIGGER_MAX_DEPTH reaction writes.
 */

/** Max cascade depth: events stamped ≥ this never fire triggers. */
export const TRIGGER_MAX_DEPTH = 3;

const TEMPLATE_RE = /^\$([A-Za-z]+)\.(.+)$/;

/** The template scope a trigger action resolves against. */
const scopeFor = (def: TriggerDef, event: DocumentRecordWrittenEvent) => ({
	record: {
		id: event.id,
		collection: event.collection,
		op: event.op,
		ownerId: event.ownerId,
		tenantId: event.tenantId,
		data: event.data,
	},
	trigger: { id: def.id, title: def.title },
});

/** `"$<scope>.<path>"` resolves via dot path; unresolved or non-`$`
 * strings pass through literally (same contract as wizard
 * completion templates). */
const resolveTemplate = (value: string, scope: Record<string, unknown>): unknown => {
	const match = TEMPLATE_RE.exec(value);
	if (match === null) return value;
	const [, root, path] = match;
	const resolved = resolveAnswerPath(scope[root] ?? {}, path);
	return resolved === undefined ? value : resolved;
};

const resolveMapping = (
	mapping: Readonly<Record<string, string>>,
	scope: Record<string, unknown>,
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const [key, template] of Object.entries(mapping)) {
		out[key] = resolveTemplate(template, scope);
	}
	return out;
};

/** Does `def` react to `event`? Collection + ops + optional `when`
 * (evaluated against the written record's `data` payload — the
 * "written doc" of the def grammar). */
export const triggerMatches = (def: TriggerDef, event: DocumentRecordWrittenEvent): boolean => {
	if (def.collection !== event.collection) return false;
	const ops = def.ops ?? TRIGGER_OPS;
	if (!ops.includes(event.op)) return false;
	if (def.when !== undefined && !evaluateCondition(def.when, event.data)) return false;
	return true;
};

const runCollectionWrite = (
	def: TriggerDef,
	action: Extract<TriggerDef["action"], { kind: "collection-write" }>,
	event: DocumentRecordWrittenEvent,
): Effect.Effect<void, unknown, never> =>
	Effect.gen(function* () {
		const store = yield* Effect.serviceOption(DocumentStore);
		if (Option.isNone(store)) {
			yield* Effect.logError(
				`trigger "${def.id}": collection-write needs the DocumentStore service`,
			);
			return;
		}
		const scope = scopeFor(def, event);
		const data = resolveMapping(action.mapping, scope);
		// Propagate the source write's attribution: the cascade record
		// belongs to the same owner and tenant bucket (system-flow ctx —
		// see DocumentStoreContext). Depth is carried separately via
		// DocumentWriteDepth around the whole action (see dispatch).
		const ctx = { ownerId: event.ownerId, tenantId: event.tenantId ?? undefined };
		if (action.mode === "insert") {
			yield* store.value.insert(action.collection, data, ctx);
			return;
		}
		const id = resolveTemplate(action.id ?? "", scope);
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
			yield* Effect.logError(
				`trigger "${def.id}": collection-write update id template resolved to ${JSON.stringify(id)}`,
			);
			return;
		}
		yield* store.value.update(action.collection, id, data, ctx);
	});

const runTriggerAction = (
	def: TriggerDef,
	event: DocumentRecordWrittenEvent,
	hooks: TriggersHooksService,
): Effect.Effect<void, unknown, never> => {
	const action = def.action;
	if (action.kind === "hook") {
		const handle: TriggerHookHandle = { trigger: def, event };
		return hooks.invoke(action.hook, handle).pipe(Effect.asVoid);
	}
	return runCollectionWrite(def, action, event);
};

/**
 * Fire every def matching `event`. Never fails: each trigger's action
 * runs under its own `catchCause` — a bad def, missing hook, store
 * error or defect is logged and isolated so one reaction can never
 * break the writer or sibling triggers. Events at/past
 * {@link TRIGGER_MAX_DEPTH} are skipped (loop prevention).
 */
export const dispatchTriggerEvent = (
	defs: readonly TriggerDef[],
	hooks: TriggersHooksService,
	event: DocumentRecordWrittenEvent,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		if (event.depth >= TRIGGER_MAX_DEPTH) {
			yield* Effect.logDebug("trigger dispatch skipped: cascade depth cap reached", {
				depth: event.depth,
				collection: event.collection,
				id: event.id,
			});
			return;
		}
		const matching = defs.filter((def) => triggerMatches(def, event));
		yield* Effect.forEach(
			matching,
			(def) =>
				runTriggerAction(def, event, hooks).pipe(
					Effect.provideService(DocumentWriteDepth, event.depth + 1),
					Effect.catchCause((cause) =>
						Effect.logError("trigger action failed", { trigger: def.id, cause }),
					),
				),
			{ discard: true },
		);
	});
