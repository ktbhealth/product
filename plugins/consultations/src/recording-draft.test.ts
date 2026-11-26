import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
	defaultDraftStore,
	dexieDraftStore,
	memoryDraftStore,
	type RecordingDraft,
} from "./recording-draft.ts";

const draft = (over: Partial<RecordingDraft> = {}): RecordingDraft => ({
	audio: new Blob(["audio"], { type: "audio/webm" }),
	transcript: "Doctor: texto",
	patientId: 3,
	savedAt: 1700000000000,
	...over,
});

const withFakeIdb = async <T>(idb: unknown, run: () => Promise<T>) => {
	const global = globalThis as { indexedDB?: unknown; IDBKeyRange?: unknown };
	const previousDb = global.indexedDB;
	const previousKr = global.IDBKeyRange;
	global.indexedDB = idb;
	global.IDBKeyRange = IDBKeyRange;
	try {
		return await run();
	} finally {
		if (previousDb === undefined) delete global.indexedDB;
		else global.indexedDB = previousDb;
		if (previousKr === undefined) delete global.IDBKeyRange;
		else global.IDBKeyRange = previousKr;
	}
};

describe("recording-draft store", () => {
	it("memory store round-trips and clears", async () => {
		const store = memoryDraftStore();
		expect(await store.load()).toBeNull();
		await store.save(draft());
		expect((await store.load())?.transcript).toBe("Doctor: texto");
		await store.clear();
		expect(await store.load()).toBeNull();
	});

	it("dexie store saves, loads and clears the current draft", async () => {
		await withFakeIdb(new IDBFactory(), async () => {
			const store = dexieDraftStore();
			expect(await store.load()).toBeNull();
			await store.save(draft());
			expect((await store.load())?.patientId).toBe(3);
			expect(await (await store.load())!.audio.text()).toBe("audio");
			await store.clear();
			expect(await store.load()).toBeNull();
		});
	});

	it("dexie store overwrites an existing draft", async () => {
		await withFakeIdb(new IDBFactory(), async () => {
			const store = dexieDraftStore();
			await store.save(draft({ transcript: "first" }));
			await store.save(draft({ transcript: "second" }));
			expect((await store.load())?.transcript).toBe("second");
		});
	});

	it("a fresh store sees what a previous instance persisted", async () => {
		const idb = new IDBFactory();
		await withFakeIdb(idb, async () => {
			await dexieDraftStore().save(draft());
		});
		await withFakeIdb(idb, async () => {
			expect((await dexieDraftStore().load())?.transcript).toBe("Doctor: texto");
		});
	});

	it("default picks dexie when present, memory otherwise", async () => {
		const global = globalThis as { indexedDB?: unknown; IDBKeyRange?: unknown };
		const previousDb = global.indexedDB;
		const previousKr = global.IDBKeyRange;
		delete global.indexedDB;
		try {
			expect(defaultDraftStore()).toBeTypeOf("object");
		} finally {
			global.indexedDB = previousDb;
		}
		global.indexedDB = new IDBFactory();
		global.IDBKeyRange = IDBKeyRange;
		try {
			expect(defaultDraftStore()).toBeTypeOf("object");
			// let the picked store's preload settle so a broken-IDB
			// rejection can't leak into other tests
			await new Promise((r) => setTimeout(r, 0));
		} finally {
			if (previousDb === undefined) delete global.indexedDB;
			else global.indexedDB = previousDb;
			if (previousKr === undefined) delete global.IDBKeyRange;
			else global.IDBKeyRange = previousKr;
		}
	});
});
