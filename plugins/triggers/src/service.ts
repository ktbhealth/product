import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { EventBus } from "@effect-server-utils/cqrs";
import { DOCUMENT_RECORD_WRITTEN_TAG, type DocumentRecordWrittenEvent } from "@ktb/document-store";
import { PluginStates } from "@ktb/platform/plugin-states";

import { defOwnerEnabled, TriggerDefinitions } from "./definition.ts";
import { TriggersHooks, TriggersHooksLive } from "./hooks.ts";
import { dispatchTriggerEvent } from "./runner.ts";

/**
 * Triggers service — the runtime half of `trigger.def`. On layer build
 * it subscribes to `document-store.record-written` on the app-wide
 * `EventBus` (`EventBus.stream`) and forks a scoped consumer fiber:
 * each committed write is matched against the collected
 * `TriggerDefinitions` and its actions run asynchronously — the
 * writer's dispatch only pays for the bus broadcast, never for
 * reaction work (see ./runner.ts for the execution-model and
 * at-most-once durability contract).
 *
 * ENABLEMENT: defs are static composition data collected from the FULL
 * registry; enablement is runtime state. Every dispatch re-reads
 * `PluginStates.enabledIds()` (optional port — absent service means
 * "no gate", same convention as `Permissions` elsewhere) and skips
 * defs whose `owner` plugin/package is disabled, so a
 * /platform/plugins toggle applies without a layer rebuild. When
 * `PluginStates` is absent the check is skipped entirely.
 *
 * `dispatch` is exposed for tests/tooling that want to drive the
 * matcher directly without a bus round-trip.
 */
export class Triggers extends Context.Service<
	Triggers,
	{
		readonly dispatch: (event: DocumentRecordWrittenEvent) => Effect.Effect<void>;
	}
>()("@ktb/triggers/Triggers") {}

export const TriggersLive = Layer.effect(
	Triggers,
	Effect.gen(function* () {
		const definitions = yield* TriggerDefinitions;
		const hooks = yield* TriggersHooks;
		const bus = yield* EventBus;
		// Optional port: the runtime enablement gate. Absent → no
		// filtering (tests/tooling that never wired PluginStates).
		const pluginStates = yield* Effect.serviceOption(PluginStates);

		const dispatch = (event: DocumentRecordWrittenEvent) =>
			Effect.gen(function* () {
				let defs = definitions.triggers;
				if (Option.isSome(pluginStates)) {
					const enabled = yield* pluginStates.value.enabledIds();
					defs = defs.filter((def) => defOwnerEnabled(definitions.ownerIndex, def.owner, enabled));
				}
				yield* dispatchTriggerEvent(defs, hooks, event);
			});

		// stream() subscribes immediately inside the layer scope — the
		// PubSub subscription and the consumer fiber live exactly as long
		// as the layer (forkScoped + the stream's Scope requirement are
		// both bound to it).
		const stream = yield* bus.stream([DOCUMENT_RECORD_WRITTEN_TAG]);
		// The ENTIRE per-event dispatch — matching (`triggerMatches` →
		// `evaluateCondition`) AND actions — runs under catchCause:
		// a defect in any stage is logged and skipped, never allowed to
		// kill the consumer fiber (a dead fiber would silently drop
		// every later trigger reaction until restart). The onExit log
		// makes a genuinely dead consumer visible in logs/metrics.
		yield* Effect.forkScoped(
			Stream.runForEach(stream, (event) =>
				dispatch(event as DocumentRecordWrittenEvent).pipe(
					Effect.catchCause((cause) => Effect.logError("trigger dispatch failed", { cause })),
				),
			).pipe(
				Effect.onExit((exit) => {
					if (Exit.isSuccess(exit)) {
						return Effect.logDebug("trigger consumer stopped");
					}
					// Scope teardown interrupts the fiber — that's the
					// normal shutdown path, not a failure worth an ERROR.
					if (Cause.hasInterruptsOnly(exit.cause)) {
						return Effect.logDebug("trigger consumer stopped", {
							cause: exit.cause,
						});
					}
					return Effect.logError("trigger consumer exited", { cause: exit.cause });
				}),
			),
		);

		return Triggers.of({ dispatch });
	}),
);

/** The services-layer export: the Triggers runtime plus the shared
 * TriggersHooks registry other plugins register reaction handlers on
 * (provideMerge wires the registry into TriggersLive's requirement
 * and re-exports it for dependents — same shape as
 * `WizardsServicesLive`). */
export const TriggersServicesLive = TriggersLive.pipe(Layer.provideMerge(TriggersHooksLive));
