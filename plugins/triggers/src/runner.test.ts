import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import {
	DocumentStore,
	DocumentWriteDepth,
	type DocumentRecordWrittenEvent,
	type DocumentStoreShape,
} from "@ktb/document-store";

import { defineTrigger, type TriggerDef } from "./definition.ts";
import type { TriggerHookHandle, TriggersHooksService } from "./hooks.ts";
import { dispatchTriggerEvent, TRIGGER_MAX_DEPTH, triggerMatches } from "./runner.ts";

const ev = (over: Partial<DocumentRecordWrittenEvent> = {}): DocumentRecordWrittenEvent =>
	({
		_tag: "document-store.record-written",
		collection: "src",
		id: 1,
		op: "insert",
		data: { name: "Ana", flag: true },
		ownerId: "user-1",
		tenantId: null,
		depth: 0,
		...over,
	}) as DocumentRecordWrittenEvent;

const def = (over: Partial<TriggerDef> = {}): TriggerDef =>
	defineTrigger({
		id: "t-1",
		collection: "src",
		action: { kind: "hook", hook: "h" },
		...over,
	});

/** Recording hooks stub — `invoke` logs the id and delegates. */
const hooksStub = (
	impl?: (id: string, handle: TriggerHookHandle) => Effect.Effect<unknown, unknown, unknown>,
) => {
	const invoked: Array<{ id: string; handle: TriggerHookHandle }> = [];
	const hooks = {
		register: () => {},
		get: () => undefined,
		invoke: (id: string, handle: TriggerHookHandle) => {
			invoked.push({ id, handle });
			return impl === undefined ? Effect.void : impl(id, handle);
		},
	} as unknown as TriggersHooksService;
	return { hooks, invoked };
};

/** Minimal DocumentStore stub — records calls, returns a fake record. */
const storeStub = () => {
	const calls: Array<{
		method: string;
		collection: unknown;
		data: unknown;
		id: unknown;
		ctx: unknown;
		depth: number;
	}> = [];
	const record = {
		id: 99,
		collectionId: 1,
		collection: "dst",
		data: {},
		ownerId: "user-1",
		tenantId: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const shape = {
		ensureCollection: () => Effect.die("unused"),
		insert: (collection: unknown, data: unknown, ctx: unknown) =>
			Effect.gen(function* () {
				calls.push({
					method: "insert",
					collection,
					data,
					id: undefined,
					ctx,
					depth: yield* DocumentWriteDepth,
				});
				return record;
			}),
		get: () => Effect.succeed(null),
		find: () => Effect.succeed({ rows: [], total: 0 }),
		update: (collection: unknown, id: unknown, data: unknown, ctx: unknown) =>
			Effect.gen(function* () {
				calls.push({
					method: "update",
					collection,
					data,
					id,
					ctx,
					depth: yield* DocumentWriteDepth,
				});
				return record;
			}),
		delete: () => Effect.void,
	} as unknown as DocumentStoreShape;
	return { shape, calls };
};

const withStore = <A, E>(
	effect: Effect.Effect<A, E, never>,
	shape: DocumentStoreShape | undefined,
) => (shape === undefined ? effect : effect.pipe(Effect.provideService(DocumentStore, shape)));

describe("triggerMatches", () => {
	it("matches on collection + default ops", () => {
		expect(triggerMatches(def(), ev())).toBe(true);
		expect(triggerMatches(def(), ev({ op: "remove" }))).toBe(true);
		expect(triggerMatches(def(), ev({ collection: "other" }))).toBe(false);
	});

	it("filters by ops when declared", () => {
		const insertOnly = def({ ops: ["insert"] });
		expect(triggerMatches(insertOnly, ev({ op: "insert" }))).toBe(true);
		expect(triggerMatches(insertOnly, ev({ op: "update" }))).toBe(false);
		expect(triggerMatches(insertOnly, ev({ op: "remove" }))).toBe(false);
	});

	it("evaluates when against the written doc's data", () => {
		const gated = def({ when: { path: "flag", op: "eq", value: true } });
		expect(triggerMatches(gated, ev({ data: { flag: true } }))).toBe(true);
		expect(triggerMatches(gated, ev({ data: { flag: false } }))).toBe(false);
		expect(triggerMatches(gated, ev({ data: {} }))).toBe(false);
	});
});

describe("dispatchTriggerEvent", () => {
	it("skips events at the cascade depth cap", async () => {
		const { hooks, invoked } = hooksStub();
		const { shape, calls } = storeStub();
		const writeDef = def({
			action: {
				kind: "collection-write",
				collection: "dst",
				mapping: {},
				mode: "insert",
			},
		});
		await withStore(
			dispatchTriggerEvent([writeDef], hooks, ev({ depth: TRIGGER_MAX_DEPTH })),
			shape,
		).pipe(Effect.runPromise);
		expect(calls).toHaveLength(0);
		expect(invoked).toHaveLength(0);
	});

	it("runs hook actions with the trigger + event handle", async () => {
		const { hooks, invoked } = hooksStub(() => Effect.succeed("ok"));
		const d = def({ id: "hooked" });
		await Effect.runPromise(dispatchTriggerEvent([d], hooks, ev()));
		expect(invoked).toHaveLength(1);
		expect(invoked[0]?.id).toBe("h");
		expect(invoked[0]?.handle.trigger.id).toBe("hooked");
		expect(invoked[0]?.handle.event.collection).toBe("src");
	});

	it("ignores defs that do not match", async () => {
		const { hooks, invoked } = hooksStub();
		await Effect.runPromise(dispatchTriggerEvent([def({ collection: "other" })], hooks, ev()));
		expect(invoked).toHaveLength(0);
	});

	it("collection-write insert resolves templates and propagates attribution", async () => {
		const { hooks } = hooksStub();
		const { shape, calls } = storeStub();
		const writeDef = def({
			id: "mirror",
			action: {
				kind: "collection-write",
				collection: "dst",
				mapping: {
					name: "$record.data.name",
					op: "$record.op",
					trigger: "$trigger.id",
					literal: "plain",
					missing: "$record.data.nope",
					unknownRoot: "$bogus.path",
					num: "$record.id",
				},
				mode: "insert",
			},
		});
		await withStore(
			dispatchTriggerEvent([writeDef], hooks, ev({ id: 42, tenantId: 5 })),
			shape,
		).pipe(Effect.runPromise);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.method).toBe("insert");
		expect(call?.collection).toBe("dst");
		expect(call?.data).toEqual({
			name: "Ana",
			op: "insert",
			trigger: "mirror",
			literal: "plain",
			missing: "$record.data.nope",
			unknownRoot: "$bogus.path",
			num: 42,
		});
		expect(call?.ctx).toEqual({ ownerId: "user-1", tenantId: 5 });
		// cascade depth: the store call runs one level deeper than the event
		expect(call?.depth).toBe(1);
	});

	it("collection-write update resolves the id template", async () => {
		const { hooks } = hooksStub();
		const { shape, calls } = storeStub();
		const writeDef = def({
			action: {
				kind: "collection-write",
				collection: "dst",
				mapping: { v: "$record.data.name" },
				mode: "update",
				id: "$record.id",
			},
		});
		await withStore(dispatchTriggerEvent([writeDef], hooks, ev({ id: 9 })), shape).pipe(
			Effect.runPromise,
		);
		expect(calls[0]?.method).toBe("update");
		expect(calls[0]?.id).toBe(9);
		expect(calls[0]?.data).toEqual({ v: "Ana" });
	});

	it("collection-write update with an unresolvable id logs and skips", async () => {
		const { hooks } = hooksStub();
		const { shape, calls } = storeStub();
		const writeDef = def({
			action: {
				kind: "collection-write",
				collection: "dst",
				mapping: {},
				mode: "update",
				id: "$record.data.missing",
			},
		});
		await withStore(dispatchTriggerEvent([writeDef], hooks, ev()), shape).pipe(Effect.runPromise);
		expect(calls).toHaveLength(0);
	});

	it("collection-write update without an id template logs and skips", async () => {
		const { hooks } = hooksStub();
		const { shape, calls } = storeStub();
		// Bypass assertTriggerDef (which requires id on update) — the
		// runtime must still fail safe on a hand-built def.
		const writeDef = {
			id: "t-1",
			collection: "src",
			action: {
				kind: "collection-write",
				collection: "dst",
				mapping: {},
				mode: "update",
			},
		} as TriggerDef;
		await withStore(dispatchTriggerEvent([writeDef], hooks, ev()), shape).pipe(Effect.runPromise);
		expect(calls).toHaveLength(0);
	});

	it("collection-write without DocumentStore logs and skips", async () => {
		const { hooks } = hooksStub();
		const writeDef = def({
			action: {
				kind: "collection-write",
				collection: "dst",
				mapping: {},
				mode: "insert",
			},
		});
		// No DocumentStore in context — serviceOption resolves None.
		await Effect.runPromise(dispatchTriggerEvent([writeDef], hooks, ev()));
	});

	it("isolates match defects per def — a poison `when` doesn't mask siblings", async () => {
		const { hooks, invoked } = hooksStub();
		// Hand-built def bypassing assertTriggerDef: `when` is not a
		// condition object, so evaluateCondition defects inside
		// triggerMatches. Matching must isolate it, not the whole event.
		const poison = {
			id: "poison",
			collection: "src",
			when: "not-a-condition",
			action: { kind: "hook", hook: "bad" },
		} as unknown as TriggerDef;
		const good = def({ id: "good" });
		await Effect.runPromise(dispatchTriggerEvent([poison, good], hooks, ev()));
		expect(invoked).toHaveLength(1);
		expect(invoked[0]?.handle.trigger.id).toBe("good");
	});

	it("collection-write skips prototype-polluting mapping keys", async () => {
		const { hooks } = hooksStub();
		const { shape, calls } = storeStub();
		// Bypass assertTriggerDef — the runtime guard is defense-in-depth.
		const writeDef = {
			id: "t-1",
			collection: "src",
			action: {
				kind: "collection-write",
				collection: "dst",
				mapping: { __proto__: "$record.data.name", ok: "$record.data.name" },
				mode: "insert",
			},
		} as unknown as TriggerDef;
		await withStore(dispatchTriggerEvent([writeDef], hooks, ev()), shape).pipe(Effect.runPromise);
		expect(calls).toHaveLength(1);
		const data = calls[0]?.data as Record<string, unknown>;
		expect(data).toEqual({ ok: "Ana" });
		expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
	});

	it("isolates failures per trigger — a throwing hook does not stop siblings", async () => {
		const calls: string[] = [];
		const hooks = {
			register: () => {},
			get: () => undefined,
			invoke: (id: string) => {
				calls.push(id);
				return id === "bad" ? Effect.fail(new Error("boom")) : Effect.void;
			},
		} as unknown as TriggersHooksService;
		const bad = def({ id: "bad", action: { kind: "hook", hook: "bad" } });
		const good = def({ id: "good", action: { kind: "hook", hook: "good" } });
		await Effect.runPromise(dispatchTriggerEvent([bad, good], hooks, ev()));
		expect(calls).toEqual(["bad", "good"]);
	});

	it("isolates defects per trigger", async () => {
		const { hooks, invoked } = hooksStub(() => Effect.die(new Error("defect")));
		await Effect.runPromise(dispatchTriggerEvent([def()], hooks, ev()));
		expect(invoked).toHaveLength(1);
	});

	it("survives store failures", async () => {
		const { hooks } = hooksStub();
		const failing = {
			ensureCollection: () => Effect.die("unused"),
			insert: () => Effect.fail(new Error("store down")),
			get: () => Effect.succeed(null),
			find: () => Effect.succeed({ rows: [], total: 0 }),
			update: () => Effect.die("unused"),
			delete: () => Effect.void,
		} as unknown as DocumentStoreShape;
		const writeDef = def({
			action: {
				kind: "collection-write",
				collection: "dst",
				mapping: {},
				mode: "insert",
			},
		});
		await withStore(dispatchTriggerEvent([writeDef], hooks, ev()), failing).pipe(Effect.runPromise);
	});
});
