import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { makeEventBus } from "@effect-server-utils/cqrs";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	defineCollection,
	DocumentCollections,
	DocumentStore,
	DocumentStoreLive,
	DOCUMENT_STORE_TEST_DDL,
	f,
	type DocumentRecordWrittenEvent,
} from "@ktb/document-store";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { defineTrigger, TriggerDefinitions, type TriggerDef } from "./definition.ts";
import { TriggersHooks } from "./hooks.ts";
import { TRIGGER_MAX_DEPTH } from "./runner.ts";
import { Triggers, TriggersServicesLive } from "./service.ts";

/** Minimal groups stub — document_records.tenant_id FKs to groups.id. */
const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
INSERT INTO groups (id, name) VALUES (1, 'clinic-a');
`;

const src = defineCollection({
	name: "test.src",
	fields: { v: f.string({ required: true }) },
});
const dst = defineCollection({
	name: "test.dst",
	fields: { note: f.string(), origin: f.number() },
});
const chain = defineCollection({
	name: "test.chain",
	fields: { v: f.string({ required: true }) },
});

const mirrorDef: TriggerDef = defineTrigger({
	id: "mirror",
	collection: "test.src",
	ops: ["insert"],
	action: {
		kind: "collection-write",
		collection: "test.dst",
		mapping: { note: "$record.data.v", origin: "$record.id" },
		mode: "insert",
	},
});

const hookDef: TriggerDef = defineTrigger({
	id: "hooked",
	collection: "test.src",
	action: { kind: "hook", hook: "test.observed" },
});

const chainDef: TriggerDef = defineTrigger({
	id: "chain",
	collection: "test.chain",
	action: {
		kind: "collection-write",
		collection: "test.chain",
		mapping: { v: "$record.data.v" },
		mode: "insert",
	},
});

const DEFS = [src, dst, chain];
const TRIGGER_DEFS = [mirrorDef, hookDef, chainDef];

describe("TriggersServicesLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore | Triggers | TriggersHooks, never>;
	const hookCalls: DocumentRecordWrittenEvent[] = [];

	beforeAll(async () => {
		const db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		// One shared layer graph: the SAME EventBus instance must back
		// both the store's publisher and the triggers subscriber, and
		// DocumentStore must be visible to the consumer's serviceOption.
		const shared = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: DEFS }),
			makeEventBus(),
			Layer.succeed(TriggerDefinitions, { triggers: TRIGGER_DEFS }),
		);
		const withStore = Layer.mergeAll(shared, DocumentStoreLive.pipe(Layer.provide(shared)));
		runtime = ManagedRuntime.make(
			Layer.mergeAll(withStore, TriggersServicesLive.pipe(Layer.provideMerge(withStore))),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* TriggersHooks;
				hooks.register("test.observed", (handle) =>
					Effect.sync(() => {
						hookCalls.push(handle.event);
					}),
				);
			}),
		);
	});

	afterAll(() => runtime.dispose());

	const insert = (collection: string, data: Record<string, unknown>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				return yield* store.insert(collection, data as never, { ownerId: "user-1" });
			}),
		);

	it("fires a hook trigger on a matching write", async () => {
		await insert("test.src", { v: "one" });
		await vi.waitFor(() => expect(hookCalls.length).toBeGreaterThan(0), { timeout: 2000 });
		expect(hookCalls.at(-1)?.collection).toBe("test.src");
		expect(hookCalls.at(-1)?.op).toBe("insert");
	});

	it("fires a collection-write trigger that lands a mapped record", async () => {
		const before = hookCalls.length;
		const record = await insert("test.src", { v: "two" });
		await vi.waitFor(
			async () => {
				const result = await runtime.runPromise(
					Effect.gen(function* () {
						const store = yield* DocumentStore;
						return yield* store.find("test.dst", {}, { ownerId: "user-1" });
					}),
				);
				expect(result.rows.some((r) => r.data.note === "two" && r.data.origin === record.id)).toBe(
					true,
				);
			},
			{ timeout: 2000 },
		);
		// the hook trigger also saw this write
		await vi.waitFor(() => expect(hookCalls.length).toBeGreaterThan(before), {
			timeout: 2000,
		});
	});

	it("does not fire triggers for non-matching ops", async () => {
		const record = await insert("test.src", { v: "three" });
		const dstBefore = await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				return yield* store.find("test.dst", {}, { ownerId: "user-1" });
			}),
		);
		// mirrorDef only matches insert — an update must not create a dst row
		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				yield* store.update("test.src", record.id, { v: "three!" }, { ownerId: "user-1" });
			}),
		);
		// give the consumer a beat, then assert no new dst row appeared
		await new Promise((r) => setTimeout(r, 100));
		const dstAfter = await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				return yield* store.find("test.dst", {}, { ownerId: "user-1" });
			}),
		);
		expect(dstAfter.total).toBe(dstBefore.total);
	});

	it("bounds self-referencing cascades at the depth cap", async () => {
		await insert("test.chain", { v: "loop" });
		// external write + TRIGGER_MAX_DEPTH cascade writes
		await vi.waitFor(
			async () => {
				const result = await runtime.runPromise(
					Effect.gen(function* () {
						const store = yield* DocumentStore;
						return yield* store.find("test.chain", {}, { ownerId: "user-1" });
					}),
				);
				expect(result.total).toBe(TRIGGER_MAX_DEPTH + 1);
			},
			{ timeout: 3000 },
		);
		// settle: the cap must hold — no further writes trickle in
		await new Promise((r) => setTimeout(r, 150));
		const settled = await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				return yield* store.find("test.chain", {}, { ownerId: "user-1" });
			}),
		);
		expect(settled.total).toBe(TRIGGER_MAX_DEPTH + 1);
	});

	it("dispatch skips events at the depth cap without touching actions", async () => {
		const before = hookCalls.length;
		await runtime.runPromise(
			Effect.gen(function* () {
				const triggers = yield* Triggers;
				yield* triggers.dispatch({
					_tag: "document-store.record-written",
					collection: "test.src",
					id: 1,
					op: "insert",
					data: { v: "x" },
					ownerId: "user-1",
					tenantId: null,
					depth: TRIGGER_MAX_DEPTH,
				} as DocumentRecordWrittenEvent);
			}),
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(hookCalls.length).toBe(before);
	});
});
