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

import { createCollection } from "@tanstack/db";
import Dexie, { type EntityTable } from "dexie";

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
const ROW_KEY = "current";

/** Collection rows carry the table's primary key alongside the draft. */
interface DraftRow extends RecordingDraft {
	readonly id: string;
}

type DraftsDb = Dexie & { drafts: EntityTable<DraftRow, "id"> };

const draftsDb = (): DraftsDb => {
	const g = globalThis as { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange };
	// Deps resolve at construction, not module load — tests inject fakes
	// through the same globals.
	const db = new Dexie(DB_NAME, {
		indexedDB: g.indexedDB,
		IDBKeyRange: g.IDBKeyRange,
	}) as DraftsDb;
	db.version(1).stores({ drafts: "id" });
	return db;
};

/**
 * IndexedDB store: a TanStack DB collection synced from a Dexie table.
 * The collection hydrates from Dexie on preload; mutations write
 * optimistically and the onInsert/onUpdate/onDelete handlers persist
 * back through Dexie — the collection stays the single read surface.
 * Persisted mutations drop their optimistic copy once settled, so each
 * handler re-syncs from Dexie to land the authoritative row.
 */
export const dexieDraftStore = (): RecordingDraftStore => {
	const db = draftsDb();
	let channel: {
		begin(): void;
		truncate(): void;
		write(msg: { type: "insert"; value: DraftRow }): void;
		commit(): void;
		markReady(): void;
		fail(err: unknown): void;
	} | null = null;
	const resync = async () => {
		if (!channel) return;
		const rows = await db.drafts.toArray();
		channel.begin();
		channel.truncate();
		for (const row of rows) channel.write({ type: "insert", value: row });
		channel.commit();
	};
	const collection = createCollection<DraftRow, string>({
		id: "consultation-recording-drafts",
		getKey: (row) => row.id,
		startSync: true,
		sync: {
			sync: (params) => {
				channel = params;
				void resync().then(
					() => channel?.markReady(),
					(err) => channel?.fail(err),
				);
			},
		},
		utils: { refetch: resync },
		onInsert: async ({ transaction, collection }) => {
			for (const m of transaction.mutations) await db.drafts.put(m.modified);
			await collection.utils.refetch();
		},
		onUpdate: async ({ transaction, collection }) => {
			for (const m of transaction.mutations) await db.drafts.put(m.modified);
			await collection.utils.refetch();
		},
		onDelete: async ({ transaction, collection }) => {
			for (const m of transaction.mutations) await db.drafts.delete(m.key);
			await collection.utils.refetch();
		},
	});
	const ready = collection.preload();
	return {
		load: async () => {
			await ready;
			const row = collection.get(ROW_KEY);
			if (!row) return null;
			const { audio, transcript, patientId, savedAt } = row;
			return { audio, transcript, patientId, savedAt };
		},
		save: async (draft) => {
			await ready;
			const row: DraftRow = { ...draft, id: ROW_KEY };
			const tx = collection.has(ROW_KEY)
				? collection.update(ROW_KEY, (d) => Object.assign(d, row))
				: collection.insert(row);
			await tx.when("settled");
		},
		clear: async () => {
			await ready;
			if (collection.has(ROW_KEY)) {
				await collection.delete(ROW_KEY).when("settled");
			}
		},
	};
};

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
	typeof indexedDB === "undefined" ? memoryDraftStore() : dexieDraftStore();
