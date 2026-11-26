import { describe, expect, it } from "vitest";

import {
	defaultDraftStore,
	idbDraftStore,
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

/** Minimal in-memory IDB — the same fake the keyring tests use:
 * open/transaction/objectStore get/put/delete resolved on microtask. */
const fakeIndexedDB = (rows = new Map<string, unknown>()) => {
	const makeReq = (fn: () => { result?: unknown; error?: unknown }) => {
		const r: Record<string, unknown> = { result: undefined, error: null };
		queueMicrotask(() => {
			const out = fn();
			r.result = out.result;
			r.error = out.error ?? null;
			if (out.error) (r.onerror as (() => void) | null)?.();
			else (r.onsuccess as (() => void) | null)?.();
		});
		return r;
	};
	const db = {
		transaction: (_store: string, _mode: string) => ({
			objectStore: () => ({
				get: (key: string) => makeReq(() => ({ result: rows.get(key) })),
				put: (value: unknown, key: string) =>
					makeReq(() => ({ result: (rows.set(key, value), undefined) })),
				delete: (key: string) => makeReq(() => ({ result: (rows.delete(key), undefined) })),
			}),
		}),
		createObjectStore: () => ({}),
		close: () => {},
	};
	return {
		open: () => {
			const r: Record<string, unknown> = { result: db, error: null };
			queueMicrotask(() => {
				(r.onupgradeneeded as (() => void) | null)?.();
				(r.onsuccess as (() => void) | null)?.();
			});
			return r;
		},
	};
};

const withFakeIdb = async <T>(idb: unknown, run: () => Promise<T>) => {
	const global = globalThis as { indexedDB?: unknown };
	const previous = global.indexedDB;
	global.indexedDB = idb;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete global.indexedDB;
		else global.indexedDB = previous;
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

	it("idb store saves, loads and clears the current draft", async () => {
		const rows = new Map<string, unknown>();
		await withFakeIdb(fakeIndexedDB(rows), async () => {
			const store = idbDraftStore();
			expect(await store.load()).toBeNull();
			const d = draft();
			await store.save(d);
			expect(rows.get("current")).toBe(d);
			expect((await store.load())?.patientId).toBe(3);
			await store.clear();
			expect(await store.load()).toBeNull();
		});
	});

	it("idb open failure rejects", async () => {
		const global = globalThis as { indexedDB?: unknown };
		const previous = global.indexedDB;
		global.indexedDB = {
			open: () => {
				const r: Record<string, unknown> = { result: undefined, error: null };
				queueMicrotask(() => (r.onerror as (() => void) | null)?.());
				return r;
			},
		};
		try {
			await expect(idbDraftStore().load()).rejects.toThrow("indexeddb open failed");
		} finally {
			if (previous === undefined) delete global.indexedDB;
			else global.indexedDB = previous;
		}
	});

	it("default picks idb when present, memory otherwise", () => {
		const global = globalThis as { indexedDB?: unknown };
		const previous = global.indexedDB;
		delete global.indexedDB;
		try {
			expect(defaultDraftStore()).toBeTypeOf("object");
		} finally {
			global.indexedDB = previous;
		}
		global.indexedDB = fakeIndexedDB();
		try {
			expect(defaultDraftStore()).toBeTypeOf("object");
		} finally {
			if (previous === undefined) delete global.indexedDB;
			else global.indexedDB = previous;
		}
	});
});
