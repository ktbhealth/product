import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	defineCollection,
	DocumentCollections,
	DocumentStore,
	DocumentStoreLive,
	DOCUMENT_STORE_TEST_DDL,
	f,
	type DocumentRecord,
	type DocumentStoreError,
	type DocumentStoreShape,
} from "@ktb/document-store";
import { PluginStates } from "@ktb/platform/plugin-states";
import { Permissions, type PermissionsShape } from "@ktb/rbac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { defineFlow, FlowDefinitions, type FlowDef } from "./definition.ts";
import { FlowsHooks, type FlowHookHandle } from "./hooks.ts";
import { Flows, FlowsServicesLive, type FlowEventInput } from "./service.ts";

/** Minimal groups stub — document_records.tenant_id FKs to groups.id. */
const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
INSERT INTO groups (id, name) VALUES (1, 'clinic-a');
`;

const docs = defineCollection({
	name: "test.docs",
	fields: {
		status: f.string(),
		note: f.string(),
		ready: f.boolean(),
		meta: f.json(),
	},
});

const FLOW = defineFlow({
	id: "doc-flow",
	collection: "test.docs",
	stateField: "status",
	initial: "draft",
	states: {
		draft: {
			on: {
				submit: {
					target: "review",
					guard: { path: "record.ready", op: "eq", value: true },
					actions: [
						{ kind: "set-field", field: "note", value: "$event.note" },
						{ kind: "set-field", field: "meta.seen", value: "$event.by" },
						{ kind: "hook", hook: "test.observed" },
					],
				},
			},
		},
		review: { on: { publish: { target: "published" } } },
		published: { final: true },
	},
});

const GATED = defineFlow({
	...FLOW,
	id: "gated-flow",
	permission: "doc.publish",
	states: {
		draft: { on: { submit: { target: "review" } } },
		review: {},
		published: { final: true },
	},
});

const GHOST = defineFlow({
	id: "ghost-flow",
	collection: "test.ghost",
	stateField: "status",
	initial: "draft",
	states: { draft: {} },
});

const asUser = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
	eff.pipe(Effect.provideService(Principal, { userId: "user-1" }));

const target = (over: Partial<FlowEventInput> = {}): FlowEventInput => ({
	flow: "doc-flow",
	collection: "test.docs",
	id: 1,
	event: "submit",
	...over,
});

describe("FlowsServicesLive (integration)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore | Flows | FlowsHooks, never>;
	const hookCalls: FlowHookHandle[] = [];

	const insert = (data: Record<string, unknown>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				return yield* store.insert("test.docs", data as never, { ownerId: "user-1" });
			}),
		);

	const call = <A, E>(eff: (flows: Flows["Service"]) => Effect.Effect<A, E, never>) =>
		runtime.runPromise(asUser(Effect.flatMap(Flows, eff)));

	beforeAll(async () => {
		const db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const shared = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: [docs] }),
			Layer.succeed(FlowDefinitions, { flows: [FLOW, GATED, GHOST] }),
		);
		const withStore = Layer.mergeAll(shared, DocumentStoreLive.pipe(Layer.provide(shared)));
		runtime = ManagedRuntime.make(
			Layer.mergeAll(withStore, FlowsServicesLive.pipe(Layer.provideMerge(withStore))),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* FlowsHooks;
				hooks.register("test.observed", (handle) =>
					Effect.sync(() => {
						hookCalls.push(handle);
					}),
				);
			}),
		);
	});

	afterAll(() => runtime.dispose());

	it("currentState returns initial for stateless docs and the stored state otherwise", async () => {
		const rec = await insert({ note: "fresh", ready: true });
		const info = await call((flows) => flows.currentState(target({ id: rec.id })));
		expect(info?.state).toBe("draft");
		expect(info?.flow.id).toBe("doc-flow");
		expect(info?.record.id).toBe(rec.id);

		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				yield* store.update("test.docs", rec.id, { status: "review" }, { ownerId: "user-1" });
			}),
		);
		const moved = await call((flows) => flows.currentState(target({ id: rec.id })));
		expect(moved?.state).toBe("review");
	});

	it("currentState collapses unknown flows, collection mismatches and missing records to null", async () => {
		const rec = await insert({ note: "x" });
		expect(await call((f) => f.currentState(target({ id: rec.id, flow: "nope" })))).toBeNull();
		expect(
			await call((f) => f.currentState(target({ id: rec.id, collection: "other.col" }))),
		).toBeNull();
		expect(await call((f) => f.currentState(target({ id: 999999 })))).toBeNull();
	});

	it("propagates store errors for unregistered collections", async () => {
		const exit = await runtime.runPromiseExit(
			asUser(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.currentState({
						flow: "ghost-flow",
						collection: "test.ghost",
						id: 1,
					});
				}),
			),
		);
		expect(exit._tag).toBe("Failure");
	});

	it("canTransition reflects legality without writing", async () => {
		const ready = await insert({ note: "r", ready: true });
		const notReady = await insert({ note: "n", ready: false });
		const published = await insert({ note: "p", ready: true, status: "published" });
		expect(await call((f) => f.canTransition(target({ id: ready.id })))).toBe(true);
		expect(await call((f) => f.canTransition(target({ id: notReady.id })))).toBe(false);
		expect(await call((f) => f.canTransition(target({ id: published.id })))).toBe(false);
		// unknown flow / missing record → false, never an error
		expect(await call((f) => f.canTransition(target({ id: ready.id, flow: "nope" })))).toBe(false);
		expect(await call((f) => f.canTransition(target({ id: 999999 })))).toBe(false);
	});

	it("transition commits state + set-field writes atomically and fires hooks post-commit", async () => {
		const rec = await insert({ note: "old", ready: true });
		const before = hookCalls.length;
		const result = await call((flows) =>
			flows.transition(target({ id: rec.id, payload: { note: "new", by: "u9" } })),
		);
		expect(result.from).toBe("draft");
		expect(result.to).toBe("review");
		expect(result.record.data).toMatchObject({
			status: "review",
			note: "new",
			meta: { seen: "u9" },
			ready: true,
		});
		expect(hookCalls.length).toBe(before + 1);
		const handle = hookCalls.at(-1);
		expect(handle?.flow.id).toBe("doc-flow");
		expect(handle?.from).toBe("draft");
		expect(handle?.to).toBe("review");
		expect(handle?.event).toEqual({ name: "submit", payload: { note: "new", by: "u9" } });
		expect(handle?.record.id).toBe(rec.id);
	});

	it("transition rejects illegal events with IllegalTransition", async () => {
		const notReady = await insert({ note: "x", ready: false });
		const exit = await runtime.runPromiseExit(
			asUser(Effect.flatMap(Flows, (f) => f.transition(target({ id: notReady.id })))),
		);
		expect(exit._tag).toBe("Failure");

		const ready = await insert({ note: "x", ready: true });
		// draft has no "publish" handler
		const noTrans = await runtime.runPromiseExit(
			asUser(
				Effect.flatMap(Flows, (f) => f.transition(target({ id: ready.id, event: "publish" }))),
			),
		);
		expect(noTrans._tag).toBe("Failure");
	});

	it("transition rejects unknown-state records", async () => {
		const rec = await insert({ note: "x", ready: true, status: "bogus" });
		const error = await runtime.runPromise(
			asUser(Effect.flatMap(Flows, (f) => f.transition(target({ id: rec.id }))).pipe(Effect.flip)),
		);
		expect(error._tag).toBe("IllegalTransition");
		expect((error as { reason?: string }).reason).toBe("unknown-state");
	});

	it("transition fails FlowRecordNotFound / UnknownFlow distinctly", async () => {
		const missing = await runtime.runPromise(
			asUser(Effect.flatMap(Flows, (f) => f.transition(target({ id: 999999 }))).pipe(Effect.flip)),
		);
		expect(missing._tag).toBe("FlowRecordNotFound");
		const unknown = await runtime.runPromise(
			asUser(Effect.flatMap(Flows, (f) => f.transition(target({ id: 1, flow: "nope" })))).pipe(
				Effect.flip,
			),
		);
		expect(unknown._tag).toBe("UnknownFlow");
		const mismatch = await runtime.runPromise(
			asUser(
				Effect.flatMap(Flows, (f) => f.transition(target({ id: 1, collection: "other.col" }))),
			).pipe(Effect.flip),
		);
		expect(mismatch._tag).toBe("UnknownFlow");
	});

	it("a failing hook never fails the committed transition", async () => {
		const rec = await insert({ note: "x", ready: true });
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* FlowsHooks;
				hooks.register("test.observed", () => Effect.fail(new Error("hook boom")));
			}),
		);
		const result = await call((flows) => flows.transition(target({ id: rec.id })));
		expect(result.to).toBe("review");
		// restore the recorder for later tests
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* FlowsHooks;
				hooks.register("test.observed", (handle) =>
					Effect.sync(() => {
						hookCalls.push(handle);
					}),
				);
			}),
		);
	});

	it("records outside the caller's scope are invisible", async () => {
		const foreign = await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				return yield* store.insert("test.docs", { note: "foreign", ready: true } as never, {
					ownerId: "someone-else",
				});
			}),
		);
		expect(await call((f) => f.currentState(target({ id: foreign.id })))).toBeNull();
		const error = await runtime.runPromise(
			asUser(
				Effect.flatMap(Flows, (f) => f.transition(target({ id: foreign.id }))).pipe(Effect.flip),
			),
		);
		expect(error._tag).toBe("FlowRecordNotFound");
	});
});

// ---------- stub-store unit tests: conflict + permission paths ----------

const stubRecord = (id: number, data: Record<string, unknown>): DocumentRecord =>
	({
		id,
		collectionId: 1,
		collection: "test.docs",
		data,
		ownerId: "user-1",
		tenantId: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	}) as unknown as DocumentRecord;

/** DocumentStore stub: `get` pops queued records (last one repeats);
 * `update` captures the patch and returns a merged record. */
const storeStub = (gets: readonly (DocumentRecord | null)[]) => {
	const calls: Array<{ method: string; id: unknown; data: unknown }> = [];
	let index = 0;
	const shape = {
		ensureCollection: () => Effect.die("unused"),
		insert: () => Effect.die("unused"),
		get: (_collection: unknown, id: number) => {
			const record = gets[Math.min(index, gets.length - 1)] ?? null;
			index += 1;
			calls.push({ method: "get", id, data: undefined });
			return Effect.succeed(record);
		},
		find: () => Effect.succeed({ rows: [], total: 0 }),
		update: (_collection: unknown, id: number, data: Record<string, unknown>) => {
			calls.push({ method: "update", id, data });
			const base = gets[gets.length - 1];
			return Effect.succeed(
				stubRecord(id, { ...(base?.data ?? {}), ...data } as Record<string, unknown>),
			);
		},
		delete: () => Effect.void,
	} as unknown as DocumentStoreShape;
	return { shape, calls };
};

const permissionsStub = (allowed: boolean): PermissionsShape =>
	({
		permissionsFor: () => Effect.succeed(new Map()),
		canFor: () => Effect.succeed(allowed),
		can: () => Effect.succeed(allowed),
		requirePermissionFor: () => (allowed ? Effect.void : Effect.die("forbidden")),
		requirePermission: () => (allowed ? Effect.void : Effect.die("forbidden")),
		invalidate: () => Effect.void,
	}) as unknown as PermissionsShape;

/** PluginStates stub — only `enabledIds` is read by the Flows gate. */
const pluginStatesStub = (enabled: readonly string[]) =>
	({
		isEnabled: () => Effect.succeed(true),
		enabledIds: () => Effect.succeed(new Set(enabled)),
		config: () => Effect.succeed(null),
		setEnabled: () => Effect.void,
		setConfig: () => Effect.void,
		entries: () => Effect.succeed([]),
	}) as unknown as PluginStates["Service"];

/** Build a Flows runtime over stub services: FlowDefinitions +
 * DocumentStore stub + optional Permissions/PluginStates. Uses
 * `FlowsServicesLive` so the FlowsHooks registry is also live. */
const flowsRuntime = (
	defs: readonly FlowDef[],
	store: DocumentStoreShape,
	perms?: PermissionsShape,
	states?: PluginStates["Service"],
) =>
	ManagedRuntime.make(
		FlowsServicesLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(FlowDefinitions, { flows: defs }),
					Layer.succeed(DocumentStore, store),
					...(perms === undefined ? [] : [Layer.succeed(Permissions, perms)]),
					...(states === undefined ? [] : [Layer.succeed(PluginStates, states)]),
				),
			),
		),
	);

describe("FlowsLive (stub store)", () => {
	it("fails FlowStateConflict when the re-check sees a different state", async () => {
		const { shape, calls } = storeStub([
			stubRecord(1, { status: "draft", ready: true }),
			// concurrent transition landed between resolve and write
			stubRecord(1, { status: "published", ready: true }),
		]);
		const runtime = flowsRuntime([FLOW], shape);
		try {
			const error = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition(target()).pipe(Effect.flip);
				}),
			);
			expect(error._tag).toBe("FlowStateConflict");
			expect((error as { expected?: string }).expected).toBe("draft");
			expect((error as { actual?: string }).actual).toBe("published");
			// two reads, zero writes — the conflict aborted before update
			expect(calls.filter((c) => c.method === "get")).toHaveLength(2);
			expect(calls.filter((c) => c.method === "update")).toHaveLength(0);
		} finally {
			await runtime.dispose();
		}
	});

	it("fails FlowStateConflict when the fresh state no longer resolves the event", async () => {
		const { shape } = storeStub([
			stubRecord(1, { status: "draft", ready: true }),
			// same stateField value but the guard input vanished — the
			// re-resolved transition is now illegal
			stubRecord(1, { status: "draft", ready: false }),
		]);
		const runtime = flowsRuntime([FLOW], shape);
		try {
			const error = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition(target()).pipe(Effect.flip);
				}),
			);
			expect(error._tag).toBe("FlowStateConflict");
		} finally {
			await runtime.dispose();
		}
	});

	it("commits through the stub and returns the merged record", async () => {
		const { shape, calls } = storeStub([stubRecord(1, { status: "draft", ready: true })]);
		const runtime = flowsRuntime([FLOW], shape);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition(target({ payload: { note: "n", by: "u" } }));
				}),
			);
			expect(result.from).toBe("draft");
			expect(result.to).toBe("review");
			expect(result.record.data).toMatchObject({ status: "review", note: "n" });
			const update = calls.find((c) => c.method === "update");
			expect(update?.data).toMatchObject({ status: "review", note: "n" });
		} finally {
			await runtime.dispose();
		}
	});

	it("denies permission'd flows when Permissions is absent (fail closed)", async () => {
		const { shape, calls } = storeStub([stubRecord(1, { status: "draft" })]);
		const runtime = flowsRuntime([GATED], shape);
		try {
			const error = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows
						.transition({ flow: "gated-flow", collection: "test.docs", id: 1, event: "submit" })
						.pipe(Effect.flip);
				}),
			);
			expect(error._tag).toBe("FlowPermissionDenied");
			expect(calls).toHaveLength(0);
		} finally {
			await runtime.dispose();
		}
	});

	it("denies permission'd flows when the grant check fails", async () => {
		const { shape } = storeStub([stubRecord(1, { status: "draft" })]);
		const runtime = flowsRuntime([GATED], shape, permissionsStub(false));
		try {
			const error = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows
						.transition({ flow: "gated-flow", collection: "test.docs", id: 1, event: "submit" })
						.pipe(Effect.flip);
				}),
			);
			expect(error._tag).toBe("FlowPermissionDenied");
		} finally {
			await runtime.dispose();
		}
	});

	it("allows permission'd flows when the grant check passes", async () => {
		const { shape } = storeStub([stubRecord(1, { status: "draft" })]);
		const runtime = flowsRuntime([GATED], shape, permissionsStub(true));
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition({
						flow: "gated-flow",
						collection: "test.docs",
						id: 1,
						event: "submit",
					});
				}),
			);
			expect(result.to).toBe("review");
		} finally {
			await runtime.dispose();
		}
	});

	it("gates currentState/canTransition on def.permission (fail closed)", async () => {
		const { shape, calls } = storeStub([stubRecord(1, { status: "draft" })]);
		const runtime = flowsRuntime([GATED], shape, permissionsStub(false));
		try {
			const input = { flow: "gated-flow", collection: "test.docs", id: 1 };
			const info = await runtime.runPromise(Effect.flatMap(Flows, (f) => f.currentState(input)));
			expect(info).toBeNull();
			const can = await runtime.runPromise(
				Effect.flatMap(Flows, (f) => f.canTransition({ ...input, event: "submit" })),
			);
			expect(can).toBe(false);
			// denied before any store read — same "learns nothing" contract
			expect(calls.filter((c) => c.method === "get")).toHaveLength(0);
		} finally {
			await runtime.dispose();
		}
	});

	it("lets permission'd flows through currentState/canTransition when granted", async () => {
		const { shape } = storeStub([stubRecord(1, { status: "draft" })]);
		const runtime = flowsRuntime([GATED], shape, permissionsStub(true));
		try {
			const input = { flow: "gated-flow", collection: "test.docs", id: 1 };
			const info = await runtime.runPromise(Effect.flatMap(Flows, (f) => f.currentState(input)));
			expect(info?.state).toBe("draft");
			const can = await runtime.runPromise(
				Effect.flatMap(Flows, (f) => f.canTransition({ ...input, event: "submit" })),
			);
			expect(can).toBe(true);
		} finally {
			await runtime.dispose();
		}
	});

	it("treats defs owned by disabled plugins as UnknownFlow everywhere", async () => {
		const owned = { ...FLOW, id: "owned-flow", owner: "plugin.off" } as FlowDef;
		const { shape, calls } = storeStub([stubRecord(1, { status: "draft", ready: true })]);
		const runtime = flowsRuntime([owned], shape, undefined, pluginStatesStub(["other.plugin"]));
		try {
			const input = { flow: "owned-flow", collection: "test.docs", id: 1, event: "submit" };
			const error = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition(input).pipe(Effect.flip);
				}),
			);
			expect(error._tag).toBe("UnknownFlow");
			const info = await runtime.runPromise(
				Effect.flatMap(Flows, (f) => f.currentState({ ...input })),
			);
			expect(info).toBeNull();
			const can = await runtime.runPromise(Effect.flatMap(Flows, (f) => f.canTransition(input)));
			expect(can).toBe(false);
			expect(calls.filter((c) => c.method === "update")).toHaveLength(0);
		} finally {
			await runtime.dispose();
		}
	});

	it("serves defs whose owner plugin is enabled", async () => {
		const owned = { ...FLOW, id: "owned-flow", owner: "plugin.on" } as FlowDef;
		const { shape } = storeStub([stubRecord(1, { status: "draft", ready: true })]);
		const runtime = flowsRuntime([owned], shape, undefined, pluginStatesStub(["plugin.on"]));
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition({
						flow: "owned-flow",
						collection: "test.docs",
						id: 1,
						event: "submit",
					});
				}),
			);
			expect(result.to).toBe("review");
		} finally {
			await runtime.dispose();
		}
	});

	it("skips store.update on a no-op self-loop transition", async () => {
		const LOOP = defineFlow({
			id: "loop-flow",
			collection: "test.docs",
			stateField: "status",
			initial: "a",
			states: { a: { on: { ping: { target: "a" } } } },
		});
		const { shape, calls } = storeStub([stubRecord(1, { status: "a", note: "same" })]);
		const runtime = flowsRuntime([LOOP], shape);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition({
						flow: "loop-flow",
						collection: "test.docs",
						id: 1,
						event: "ping",
					});
				}),
			);
			expect(result.from).toBe("a");
			expect(result.to).toBe("a");
			// read + re-check read happened, but NO write — no updated_at
			// bump and no record-written event for triggers to see.
			expect(calls.filter((c) => c.method === "update")).toHaveLength(0);
		} finally {
			await runtime.dispose();
		}
	});

	it("still writes a self-loop that changes fields", async () => {
		const LOOP = defineFlow({
			id: "loop-write",
			collection: "test.docs",
			stateField: "status",
			initial: "a",
			states: {
				a: {
					on: {
						ping: {
							target: "a",
							actions: [{ kind: "set-field", field: "note", value: "$event.note" }],
						},
					},
				},
			},
		});
		const { shape, calls } = storeStub([stubRecord(1, { status: "a", note: "old" })]);
		const runtime = flowsRuntime([LOOP], shape);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition({
						flow: "loop-write",
						collection: "test.docs",
						id: 1,
						event: "ping",
						payload: { note: "new" },
					});
				}),
			);
			expect(result.to).toBe("a");
			expect(calls.filter((c) => c.method === "update")).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});

	it("isolates hook failures in the stub runtime too", async () => {
		const { shape } = storeStub([stubRecord(1, { status: "draft", ready: true })]);
		const runtime = flowsRuntime([FLOW], shape);
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const hooks = yield* FlowsHooks;
					hooks.register("test.observed", () => Effect.die(new Error("boom")));
				}),
			);
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition(target());
				}),
			);
			expect(result.to).toBe("review");
		} finally {
			await runtime.dispose();
		}
	});

	it("propagates DocumentStore failures", async () => {
		const failing = {
			ensureCollection: () => Effect.die("unused"),
			insert: () => Effect.die("unused"),
			get: () =>
				Effect.fail({
					_tag: "UnknownCollection",
					name: "test.docs",
				} as unknown as DocumentStoreError),
			find: () => Effect.die("unused"),
			update: () => Effect.die("unused"),
			delete: () => Effect.void,
		} as unknown as DocumentStoreShape;
		const runtime = flowsRuntime([FLOW], failing);
		try {
			const error = await runtime.runPromise(
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.transition(target()).pipe(Effect.flip);
				}),
			);
			expect(error._tag).toBe("UnknownCollection");
		} finally {
			await runtime.dispose();
		}
	});
});
