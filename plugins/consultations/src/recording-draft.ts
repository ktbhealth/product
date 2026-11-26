/**
 * T-222: draft persistence for the new-consultation recorder. When the
 * doctor stops a recording and leaves the page before saving, the audio
 * blob + transcript used to live only in memory — the whole session was
 * lost. The draft lands in IndexedDB (survives tab close, crash, and
 * browser restart) and the page offers "restore / discard" on the next
 * visit; a successful save clears it.
 *
 * Trust boundary: the blob is stored raw — same exposure as the
 * in-memory MediaRecorder buffer on the doctor's device. ZK rows encrypt
 * on UPLOAD (uploadSessionAudio), not at rest on this device.
 */

export interface RecordingDraft {
	readonly audio: Blob;
	readonly transcript: string;
	readonly patientId: number | null;
	readonly savedAt: number;
}

export interface RecordingDraftStore {
	load(): Promise<RecordingDraft | null>;
	save(draft: RecordingDraft): Promise<void>;
	clear(): Promise<void>;
}

const DB_NAME = "ktb-consultation-drafts";
const IDB_STORE = "draft";
const IDB_KEY = "current";

const request = <T>(req: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexeddb request failed"));
	});

const openDb = (): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexeddb open failed"));
	});

/** Every op opens the DB, runs, and closes — draft writes are rare
 * (once per finished recording), so there's nothing to keep warm. */
export const idbDraftStore = (): RecordingDraftStore => ({
	load: async () => {
		const db = await openDb();
		try {
			const tx = db.transaction(IDB_STORE, "readonly");
			return ((await request(tx.objectStore(IDB_STORE).get(IDB_KEY))) ??
				null) as RecordingDraft | null;
		} finally {
			db.close();
		}
	},
	save: async (draft) => {
		const db = await openDb();
		try {
			const tx = db.transaction(IDB_STORE, "readwrite");
			await request(tx.objectStore(IDB_STORE).put(draft, IDB_KEY));
		} finally {
			db.close();
		}
	},
	clear: async () => {
		const db = await openDb();
		try {
			const tx = db.transaction(IDB_STORE, "readwrite");
			await request(tx.objectStore(IDB_STORE).delete(IDB_KEY));
		} finally {
			db.close();
		}
	},
});

/** Volatile store for tests and SSR — keeps the page free of IDB
 * guards (same pattern as the keyring's memoryStore). */
export const memoryDraftStore = (): RecordingDraftStore => {
	let saved: RecordingDraft | null = null;
	return {
		load: async () => saved,
		save: async (draft) => {
			saved = draft;
		},
		clear: async () => {
			saved = null;
		},
	};
};

/** Auto-select: IndexedDB when present (browser), memory otherwise. */
export const defaultDraftStore = (): RecordingDraftStore =>
	typeof indexedDB === "undefined" ? memoryDraftStore() : idbDraftStore();
