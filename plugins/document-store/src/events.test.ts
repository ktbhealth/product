import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeEventBus, EventBus } from "@effect-server-utils/cqrs";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { defineCollection } from "./collection.ts";
import { DocumentCollections } from "./collection.ts";
import { DocumentRecordWritten, DocumentWriteDepth } from "./events.ts";
import { f } from "./fields.ts";
import { DocumentStore, DocumentStoreLive, DOCUMENT_STORE_TEST_DDL } from "./service.ts";

/** Minimal groups stub — document_records.tenant_id FKs to groups.id. */
const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
INSERT INTO groups (id, name) VALUES (1, 'clinic-a');
`;

const things = defineCollection({
	name: "test.events",
	fields: {
		title: f.string({ required: true }),
		count: f.number({ default: 0 }),
	},
});

const DEFS = [things];

type WrittenEvent = ReturnType<typeof DocumentRecordWritten.make>;

describe("DocumentStoreLive write events", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore | EventBus, never>;
	/** Immediate-subscription capture — handlers run inside dispatch,
	 * so every write below is observed before it resolves. */
	const seen: WrittenEvent[] = [];

	beforeAll(async () => {
		const db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: DEFS }),
			makeEventBus(),
		);
		// deps is merged into the runtime too so tests can reach the
		// shared EventBus instance the store publishes on.
		runtime = ManagedRuntime.make(
			Layer.mergeAll(DocumentStoreLive.pipe(Layer.provide(deps)), deps),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const bus = yield* EventBus;
				yield* bus.subscribe(DocumentRecordWritten, (event) =>
					Effect.sync(() => {
						seen.push(event);
					}),
				);
			}),
		);
	});

	afterAll(() => runtime.dispose());

	const insert = (data: { title: string; count?: number }) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				return yield* store.insert("test.events", data, { ownerId: "user-1" });
			}),
		);

	it("publishes an insert event after a successful write", async () => {
		const record = await insert({ title: "hello", count: 3 });
		const event = seen.at(-1);
		expect(event?._tag).toBe("document-store.record-written");
		expect(event?.op).toBe("insert");
		expect(event?.collection).toBe("test.events");
		expect(event?.id).toBe(record.id);
		expect(event?.data).toEqual({ title: "hello", count: 3 });
		expect(event?.ownerId).toBe("user-1");
		expect(event?.tenantId).toBeNull();
		expect(event?.depth).toBe(0);
	});

	it("publishes an update event with the merged payload", async () => {
		const record = await insert({ title: "before" });
		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				yield* store.update("test.events", record.id, { title: "after" }, { ownerId: "user-1" });
			}),
		);
		const event = seen.at(-1);
		expect(event?.op).toBe("update");
		expect(event?.id).toBe(record.id);
		expect(event?.data).toMatchObject({ title: "after" });
	});

	it("publishes a remove event carrying the last-known payload", async () => {
		const record = await insert({ title: "doomed" });
		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				yield* store.delete("test.events", record.id, { ownerId: "user-1" });
			}),
		);
		const event = seen.at(-1);
		expect(event?.op).toBe("remove");
		expect(event?.id).toBe(record.id);
		expect(event?.data).toMatchObject({ title: "doomed" });
	});

	it("stamps DocumentWriteDepth into the event for cascade bounding", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				yield* store.insert("test.events", { title: "deep" });
			}).pipe(Effect.provideService(DocumentWriteDepth, 2)),
		);
		const event = seen.at(-1);
		expect(event?.op).toBe("insert");
		expect(event?.depth).toBe(2);
	});

	it("honors the ctx.tenantId attribution override", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* DocumentStore;
				yield* store.insert(
					"test.events",
					{ title: "tenant-row" },
					{
						ownerId: "user-1",
						tenantId: 1,
					},
				);
			}),
		);
		const event = seen.at(-1);
		expect(event?.op).toBe("insert");
		expect(event?.tenantId).toBe(1);
	});

	it("does not publish for failed writes", async () => {
		const before = seen.length;
		await expect(
			runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* DocumentStore;
					yield* store.insert("test.events", {} as never);
				}),
			),
		).rejects.toThrow();
		expect(seen.length).toBe(before);
	});
});
