import type { JsonObject } from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import {
	NodeExecutionError,
	OrchestrationEvent,
	OrchestrationRunError,
	type KindResult,
	type NodeContext,
	type NodeRunRecord,
	type OrchestrationDef,
	type OrchestrationEvent as Event,
	type OrchestrationKind,
	type OrchestrationNode,
	type OrchestrationRunResult,
	type RunOptions,
} from "./types.ts";

/**
 * runner.ts — the orchestration engine.
 *
 * Phase 1 semantics (single-process, in-memory): there are NO explicit
 * edges. Each event is routed to every non-retired node whose `on` list
 * contains the event type; a node fire may enqueue more events through
 * `ctx.emit` or `KindResult.events`, and the loop runs until the queue
 * drains — at which point a synthetic `workflow.done` event is emitted
 * (nodes may subscribe to it) and the run ends once the queue drains
 * again. `maxEvents` bounds total processed events so emit cycles
 * cannot spin forever.
 *
 * Phase 2 durability: the loop is factored into {@link
 * OrchestrationSession} — a serializable snapshot
 * ({@link OrchestrationSnapshot}) plus a bounded {@link
 * OrchestrationSession.step} that processes at most `maxBatch` events
 * per call. `runOrchestration` drains a fresh session to quiescence
 * (identical observable behavior to the phase-1 loop); the durable
 * runner (`durable/runner.ts`) persists snapshots + pending events and
 * drives `step` one jobs-port job at a time.
 *
 * Node policies are all per-node data on {@link OrchestrationNode}:
 * `maxFires`, `until`/`retireOn`, `retry`, `circuitBreaker`, `fanIn`.
 * Node failures follow the def/run `onNodeError` policy — "halt"
 * (default) emits `node.failed` + `workflow.failed` and ends the run
 * with status "failed"; "continue" records the failure and keeps
 * routing.
 */

/** Default cap on total events processed per run — a safety bound
 * against emit cycles (A emits X, B on X emits Y, C on Y emits X…). */
const DEFAULT_MAX_EVENTS = 1000;

/** Mutable per-node runtime state for one run. */
interface NodeRuntime {
	readonly node: OrchestrationNode;
	readonly kind: OrchestrationKind;
	/** Successful fire count (drives `maxFires` and trace `fires`). */
	fires: number;
	retired: boolean;
	consecutiveFailures: number;
	/** `Date.now()` timestamp until which the circuit is open; 0 = closed. */
	circuitOpenUntil: number;
	/** Events collected while a `fanIn` join is pending. */
	fanInBuffer: Event[];
}

/**
 * The JSON-serializable half of a {@link NodeRuntime}: everything the
 * runner mutates, minus the `node`/`kind` references (re-resolved from
 * the def + kind map on restore). `fanInBuffer` events are full
 * {@link OrchestrationEvent}s — already JSON-safe.
 */
export interface SerializedNodeRuntime {
	readonly nodeId: string;
	readonly fires: number;
	readonly retired: boolean;
	readonly consecutiveFailures: number;
	readonly circuitOpenUntil: number;
	readonly fanInBuffer: readonly Event[];
}

/**
 * Durable snapshot of a session — every mutable field needed to
 * resume the run in a later process. The pending event QUEUE is
 * deliberately absent: durable runs persist it separately (the
 * `orchestration_events` table) and pass it to
 * {@link restoreOrchestrationSession}. `events` is the processed-event
 * log (needed for the final {@link OrchestrationRunResult}); `trace`
 * the per-fire audit; `tracePersisted` counts how many leading trace
 * records the store has already written (the durable runner inserts
 * the tail). `error` is set only on terminal failure snapshots written
 * by the durable runner — the in-memory session never produces it.
 */
export interface OrchestrationSnapshot {
	runtimes: readonly SerializedNodeRuntime[];
	state: Record<string, unknown>;
	trace: NodeRunRecord[];
	tracePersisted: number;
	events: Event[];
	status: OrchestrationRunResult["status"];
	halted: boolean;
	doneEmitted: boolean;
	config: JsonObject;
	onNodeError: "halt" | "continue";
	maxEvents: number;
	error?: string;
}

/** A resumable orchestration execution. `step(maxBatch)` advances the
 * run by at most `maxBatch` dequeued events (default: unbounded — the
 * phase-1 drain); it returns after the batch, on halt, on quiescence,
 * or by failing with {@link OrchestrationRunError} when the event
 * budget is exceeded. `snapshot`/`pendingEvents` capture everything a
 * durable store needs between steps; `result` is valid once
 * `isFinished` is true. */
export interface OrchestrationSession {
	readonly step: (maxBatch?: number) => Effect.Effect<void, OrchestrationRunError>;
	readonly isFinished: () => boolean;
	/** Events still queued, in routing order — the durable store
	 * persists these as pending rows between steps. */
	readonly pendingEvents: () => readonly Event[];
	readonly snapshot: () => OrchestrationSnapshot;
	readonly result: () => OrchestrationRunResult;
}

const isEventLike = (value: unknown): value is Event =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { type?: unknown }).type === "string" &&
	typeof (value as { source?: unknown }).source === "string";

/** Coerce the `run` input into the initial queue event: an
 * {@link OrchestrationEvent} is used as-is; a plain object becomes an
 * "input" event with the object as payload; anything else is wrapped
 * as `{value}`; `undefined` yields the synthetic `start` event. */
export const toInitialEvent = (input: unknown): Event => {
	if (input === undefined) {
		return OrchestrationEvent.start();
	}
	if (isEventLike(input)) {
		return input;
	}
	const payload: JsonObject =
		typeof input === "object" && input !== null && !Array.isArray(input)
			? (input as JsonObject)
			: { value: input as JsonObject };
	return OrchestrationEvent.new("input", payload, "run");
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** Normalize whatever a kind effect failed with into
 * {@link NodeExecutionError}: a kind that already speaks the contract
 * passes through; foreign error values are wrapped with their
 * stringified form as `message` and the original as `cause`. */
const toNodeError = (nodeId: string, error: unknown): NodeExecutionError =>
	error instanceof NodeExecutionError
		? error
		: new NodeExecutionError({
				nodeId,
				message: errorMessage(error),
				cause: error,
			});

/** Invoke `kind.run` defensively: a synchronous throw becomes a typed
 * {@link NodeExecutionError} instead of a defect, and the effect's
 * failure channel is normalized through {@link toNodeError}. The `as`
 * cast erases the kind's `unknown` requirement channel — the runner
 * cannot provide kind requirements by construction; kinds that need
 * ambient services must probe them optionally (`Effect.serviceOption`). */
const invokeKind = (
	kind: OrchestrationKind,
	ctx: NodeContext,
): Effect.Effect<KindResult, NodeExecutionError> =>
	Effect.suspend(() => {
		try {
			return kind.run(ctx) as Effect.Effect<KindResult, NodeExecutionError>;
		} catch (cause) {
			return Effect.fail(
				new NodeExecutionError({
					nodeId: ctx.node.id,
					message: errorMessage(cause),
					cause,
				}),
			);
		}
	}).pipe(Effect.catch((error) => Effect.fail(toNodeError(ctx.node.id, error))));

/** Merge a fanIn buffer into the payload the kind sees: payloads are
 * shallow-merged in arrival order, then `events` (the raw payloads) and
 * `eventTypes` are attached — these two keys win over merged payload
 * keys of the same name. */
const mergeFanInPayload = (buffer: readonly Event[]): JsonObject => {
	// JsonObject's index signature is readonly — build a mutable record
	// and cast at the boundary.
	const payload: Record<string, unknown> = {};
	for (const event of buffer) {
		Object.assign(payload, event.payload);
	}
	payload["events"] = buffer.map((event) => event.payload);
	payload["eventTypes"] = buffer.map((event) => event.type);
	return payload as JsonObject;
};

/** All mutable session state — the in-memory form of
 * {@link OrchestrationSnapshot} plus the live `NodeRuntime`s and the
 * pending queue (which the snapshot deliberately excludes). */
interface SessionFields {
	runtimes: NodeRuntime[];
	queue: Event[];
	events: Event[];
	trace: NodeRunRecord[];
	state: Record<string, unknown>;
	status: OrchestrationRunResult["status"];
	halted: boolean;
	doneEmitted: boolean;
	config: JsonObject;
	onNodeError: "halt" | "continue";
	maxEvents: number;
	tracePersisted: number;
}

/** Resolve every def node's kind into a {@link NodeRuntime} list.
 * Fails with {@link OrchestrationRunError} when a node's kind cannot be
 * resolved — a run-level configuration error, not a node failure.
 * `saved` (a snapshot's serialized runtimes, keyed by node id) restores
 * per-node counters on resume; absent entries start fresh, so a def
 * that gained nodes between deploys still runs. `traceForError`
 * populates the error's audit slice on the restore path. */
const resolveRuntimes = (
	def: OrchestrationDef,
	kinds: ReadonlyMap<string, OrchestrationKind>,
	saved: readonly SerializedNodeRuntime[] | undefined,
	traceForError: readonly NodeRunRecord[],
): Effect.Effect<NodeRuntime[], OrchestrationRunError> =>
	Effect.gen(function* () {
		const savedById = new Map((saved ?? []).map((entry) => [entry.nodeId, entry]));
		const runtimes: NodeRuntime[] = [];
		for (const node of def.nodes) {
			const kind = node.handler ?? kinds.get(node.kind);
			if (kind === undefined) {
				return yield* new OrchestrationRunError({
					orchestrationId: def.id,
					nodeId: node.id,
					message: `unknown kind: ${node.kind} (node ${node.id})`,
					trace: [...traceForError],
				});
			}
			const maxFires = node.maxFires;
			const prior = savedById.get(node.id);
			runtimes.push({
				node,
				kind,
				fires: prior?.fires ?? 0,
				retired: prior?.retired ?? maxFires === 0,
				consecutiveFailures: prior?.consecutiveFailures ?? 0,
				circuitOpenUntil: prior?.circuitOpenUntil ?? 0,
				fanInBuffer: prior !== undefined ? [...prior.fanInBuffer] : [],
			});
		}
		return runtimes;
	});

/** Build the session closure over mutable `fields`. The event loop is
 * the phase-1 loop verbatim, bounded per `step` call by `maxBatch`
 * dequeued events. */
const makeSession = (def: OrchestrationDef, f: SessionFields): OrchestrationSession => {
	/** Enqueue an event emitted by `source` — the only way kinds (and
	 * the runner itself) introduce new work. */
	const enqueue = (source: string, type: string, payload: JsonObject = {}): Effect.Effect<void> =>
		Effect.sync(() => {
			f.queue.push(OrchestrationEvent.new(type, payload, source));
		});

	const step = (maxBatch = Number.MAX_SAFE_INTEGER) =>
		Effect.gen(function* () {
			let processed = 0;
			while (!f.halted && !(f.queue.length === 0 && f.doneEmitted)) {
				if (f.queue.length === 0) {
					// Quiescence: emit workflow.done once — nodes may
					// subscribe to it — then finish when the queue drains
					// a second time.
					f.doneEmitted = true;
					f.queue.push(OrchestrationEvent.done());
					continue;
				}
				if (f.events.length + f.queue.length > f.maxEvents) {
					return yield* new OrchestrationRunError({
						orchestrationId: def.id,
						message: `event budget exceeded (${f.maxEvents})`,
						trace: [...f.trace],
					});
				}

				const event = f.queue.shift() as Event;
				f.events.push(event);
				processed += 1;

				if (event.type === "workflow.cancel") {
					f.status = "cancelled";
					f.halted = true;
					break;
				}

				// until/retireOn: the event retires matching nodes before any
				// `on` routing — the retiring event never fires the node.
				for (const rt of f.runtimes) {
					if (
						!rt.retired &&
						(rt.node.until?.includes(event.type) === true ||
							rt.node.retireOn?.includes(event.type) === true)
					) {
						rt.retired = true;
					}
				}

				for (const rt of f.runtimes) {
					const node = rt.node;
					if (rt.retired || !node.on.includes(event.type)) {
						continue;
					}

					// Circuit breaker: an open circuit suppresses the fire —
					// recorded as "skipped", not a failure.
					if (rt.circuitOpenUntil > Date.now()) {
						f.trace.push({ nodeId: node.id, status: "skipped", latencyMs: 0, fires: rt.fires });
						continue;
					}

					// fanIn: collect until the join is satisfied; the kind
					// receives a synthetic event with merged payloads.
					let ctxEvent = event;
					const fanIn = node.fanIn;
					if (fanIn !== undefined) {
						rt.fanInBuffer.push(event);
						const satisfied =
							"count" in fanIn
								? rt.fanInBuffer.length >= fanIn.count
								: fanIn.until.every((type) =>
										rt.fanInBuffer.some((buffered) => buffered.type === type),
									);
						if (!satisfied) {
							continue;
						}
						ctxEvent = {
							...event,
							payload: mergeFanInPayload(rt.fanInBuffer),
						};
						rt.fanInBuffer = [];
					}

					const started = Date.now();
					const ctx: NodeContext = {
						event: ctxEvent,
						node,
						config: f.config,
						state: { ...f.state },
						params: node.params ?? {},
						emit: (type, payload) => enqueue(node.id, type, payload),
					};

					let attempt = invokeKind(rt.kind, ctx);
					const retry = node.retry;
					const maxAttempts = retry?.maxAttempts ?? (retry !== undefined ? 3 : 1);
					if (retry !== undefined && maxAttempts > 1) {
						attempt = attempt.pipe(
							Effect.retry({
								schedule: Schedule.exponential(retry.backoffMs ?? 100).pipe(
									Schedule.upTo({ times: maxAttempts - 1 }),
								),
							}),
						);
					}

					const outcome = yield* attempt.pipe(
						Effect.map((result): { ok: true; result: KindResult } => ({ ok: true, result })),
						Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
					);
					const latencyMs = Date.now() - started;

					if (!outcome.ok) {
						const message = errorMessage(outcome.error);
						rt.consecutiveFailures += 1;
						const threshold = node.circuitBreaker?.failureThreshold ?? 5;
						if (rt.consecutiveFailures >= threshold) {
							rt.circuitOpenUntil = Date.now() + (node.circuitBreaker?.cooldownMs ?? 30_000);
							rt.consecutiveFailures = 0;
						}
						f.trace.push({
							nodeId: node.id,
							status: "failed",
							latencyMs,
							error: message,
							fires: rt.fires,
						});
						if (f.onNodeError === "halt") {
							// Lifecycle events are recorded directly — the run
							// halts before they could be dequeued.
							f.events.push(OrchestrationEvent.nodeFailed(node.id, message));
							f.events.push(OrchestrationEvent.workflowFailed(node.id, message));
							f.status = "failed";
							f.halted = true;
							break;
						}
						// "continue": route the failure as an event like any
						// other — nodes may subscribe to "node.failed".
						f.queue.push(OrchestrationEvent.nodeFailed(node.id, message));
						continue;
					}

					// Success.
					rt.consecutiveFailures = 0;
					rt.fires += 1;
					const result = outcome.result;
					if (result.state !== undefined) {
						Object.assign(f.state, result.state);
					}
					if (result.output !== undefined) {
						f.state[node.id] = result.output;
					}
					for (const emitted of result.events ?? []) {
						f.queue.push(OrchestrationEvent.new(emitted.type, emitted.payload ?? {}, node.id));
					}
					f.trace.push({ nodeId: node.id, status: "ok", latencyMs, fires: rt.fires });

					const maxFires = node.maxFires;
					if (maxFires !== undefined && maxFires !== "unlimited" && rt.fires >= maxFires) {
						f.queue.push(OrchestrationEvent.nodeExhausted(node.id));
						rt.retired = true;
					}
				}
				if (processed >= maxBatch) {
					break;
				}
			}
		});

	return {
		step,
		isFinished: () => f.halted || (f.queue.length === 0 && f.doneEmitted),
		pendingEvents: () => [...f.queue],
		snapshot: () => ({
			runtimes: f.runtimes.map((rt) => ({
				nodeId: rt.node.id,
				fires: rt.fires,
				retired: rt.retired,
				consecutiveFailures: rt.consecutiveFailures,
				circuitOpenUntil: rt.circuitOpenUntil,
				fanInBuffer: [...rt.fanInBuffer],
			})),
			state: { ...f.state },
			trace: [...f.trace],
			tracePersisted: f.tracePersisted,
			events: [...f.events],
			status: f.status,
			halted: f.halted,
			doneEmitted: f.doneEmitted,
			config: f.config,
			onNodeError: f.onNodeError,
			maxEvents: f.maxEvents,
		}),
		result: () =>
			({
				orchestrationId: def.id,
				status: f.status,
				events: [...f.events],
				trace: [...f.trace],
				state: { ...f.state },
			}) satisfies OrchestrationRunResult,
	};
};

/** Open a fresh session: resolve kinds, seed per-node state, build the
 * initial queue from `opts.input`. Fails with {@link
 * OrchestrationRunError} on an unresolvable node kind — before any
 * event is processed, exactly like the phase-1 runner. */
export const createOrchestrationSession = (
	def: OrchestrationDef,
	kinds: ReadonlyMap<string, OrchestrationKind>,
	opts?: {
		readonly input?: unknown;
		readonly config?: JsonObject;
		readonly onNodeError?: "halt" | "continue";
		readonly maxEvents?: number;
	},
): Effect.Effect<OrchestrationSession, OrchestrationRunError> =>
	Effect.gen(function* () {
		const runtimes = yield* resolveRuntimes(def, kinds, undefined, []);
		const state: Record<string, unknown> = {};
		for (const node of def.nodes) {
			if (node.state !== undefined) {
				Object.assign(state, node.state);
			}
		}
		const fields: SessionFields = {
			runtimes,
			queue: [toInitialEvent(opts?.input)],
			events: [],
			trace: [],
			state,
			status: "done",
			halted: false,
			doneEmitted: false,
			config: Object.assign({}, def.config ?? {}, opts?.config ?? {}) as JsonObject,
			onNodeError: opts?.onNodeError ?? def.onNodeError ?? "halt",
			maxEvents: opts?.maxEvents ?? DEFAULT_MAX_EVENTS,
			tracePersisted: 0,
		};
		return makeSession(def, fields);
	});

/** Rebuild a session from a persisted {@link OrchestrationSnapshot} and
 * the run's pending events (queue order = `seq` order). Per-node
 * counters, fanIn buffers, processed events, trace and the merged
 * config/policies all restore from the snapshot; `node`/`kind`
 * references re-resolve from `def` + `kinds` (an unknown kind fails
 * with {@link OrchestrationRunError} carrying the restored trace). */
export const restoreOrchestrationSession = (
	def: OrchestrationDef,
	kinds: ReadonlyMap<string, OrchestrationKind>,
	snapshot: OrchestrationSnapshot,
	queue: readonly Event[],
): Effect.Effect<OrchestrationSession, OrchestrationRunError> =>
	Effect.gen(function* () {
		const runtimes = yield* resolveRuntimes(def, kinds, snapshot.runtimes, snapshot.trace);
		const fields: SessionFields = {
			runtimes,
			queue: [...queue],
			events: [...snapshot.events],
			trace: [...snapshot.trace],
			state: { ...snapshot.state },
			status: snapshot.status,
			halted: snapshot.halted,
			doneEmitted: snapshot.doneEmitted,
			config: snapshot.config,
			onNodeError: snapshot.onNodeError,
			maxEvents: snapshot.maxEvents,
			tracePersisted: snapshot.tracePersisted,
		};
		return makeSession(def, fields);
	});

/** Run `def` to quiescence. `kinds` resolves each node's `kind` —
 * nodes with an inline `handler` bypass it. Fails with
 * {@link OrchestrationRunError} when a node's kind cannot be resolved
 * or the event budget is exceeded; node-level failures are recorded in
 * the result, not the error channel. */
export const runOrchestration = (
	def: OrchestrationDef,
	kinds: ReadonlyMap<string, OrchestrationKind>,
	input?: unknown,
	opts?: RunOptions,
): Effect.Effect<OrchestrationRunResult, OrchestrationRunError> =>
	Effect.gen(function* () {
		const session = yield* createOrchestrationSession(def, kinds, {
			input,
			config: opts?.config,
			onNodeError: opts?.onNodeError,
			maxEvents: opts?.maxEvents,
		});
		while (!session.isFinished()) {
			yield* session.step();
		}
		return session.result();
	});
