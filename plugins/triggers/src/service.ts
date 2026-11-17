import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { EventBus } from "@effect-server-utils/cqrs";
import { DOCUMENT_RECORD_WRITTEN_TAG, type DocumentRecordWrittenEvent } from "@ktb/document-store";

import { TriggerDefinitions } from "./definition.ts";
import { TriggersHooks, TriggersHooksLive } from "./hooks.ts";
import { dispatchTriggerEvent } from "./runner.ts";

/**
 * Triggers service — the runtime half of `trigger.def`. On layer build
 * it subscribes to `document-store.record-written` on the app-wide
 * `EventBus` (`EventBus.stream`) and forks a scoped consumer fiber:
 * each committed write is matched against the collected
 * `TriggerDefinitions` and its actions run asynchronously — the
 * writer's dispatch only pays for the bus broadcast, never for
 * reaction work (see ./runner.ts for the execution-model note).
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

		const dispatch = (event: DocumentRecordWrittenEvent) =>
			dispatchTriggerEvent(definitions.triggers, hooks, event);

		// stream() subscribes immediately inside the layer scope — the
		// PubSub subscription and the consumer fiber live exactly as long
		// as the layer (forkScoped + the stream's Scope requirement are
		// both bound to it).
		const stream = yield* bus.stream([DOCUMENT_RECORD_WRITTEN_TAG]);
		yield* Effect.forkScoped(
			Stream.runForEach(stream, (event) => dispatch(event as DocumentRecordWrittenEvent)),
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
