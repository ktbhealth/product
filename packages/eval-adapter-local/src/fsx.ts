import * as fs from "node:fs";
import * as path from "node:path";

/**
 * fsx.ts — durable filesystem primitives for the local adapters.
 *
 * `write()`/`rename()` only mean "in the page cache" — a process
 * crash keeps them, but a power loss does not. Everything here
 * fsyncs: data before rename, directory after rename, so the
 * store's ordering guarantees survive both.
 */

/** fsync a directory entry so a rename inside it survives power
 * loss — without it the directory metadata can be lost even when
 * the file data was fsynced. */
export const fsyncDir = (dir: string): void => {
	const fd = fs.openSync(dir, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
};

/** fsync file data through the OS cache. */
export const fsyncFile = (p: string): void => {
	const fd = fs.openSync(p, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
};

/** Atomic AND durable write: tmp + fsync + rename + dir fsync, so
 * neither a process crash nor a power loss leaves a half file or a
 * missing directory entry. The .tmp-<pid> suffix lets the store
 * sweep orphans from dead processes on open. */
export const writeAtomic = (p: string, bytes: Uint8Array): void => {
	const tmp = `${p}.tmp-${process.pid}`;
	const fd = fs.openSync(tmp, "w");
	try {
		fs.writeSync(fd, bytes);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, p);
	fsyncDir(path.dirname(p));
};

/** Append one line atomically+ durably. */
export const appendDurable = (p: string, line: string): void => {
	const fd = fs.openSync(p, "a");
	try {
		fs.writeSync(fd, line);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
};

/** Tmp files younger than this could belong to a live sibling
 * process sharing the workdir — only sweep stale ones. */
const TMP_ORPHAN_MAX_AGE_MS = 60_000;

/** Drop leftover `.tmp-*` files from crashed writes. Skips fresh
 * ones: two processes sharing a workdir must not delete each
 * other's in-flight tmp. Only called at layer init, before this
 * process writes anything. */
export const sweepOrphanTmps = (dir: string, now = Date.now()): void => {
	for (const name of fs.readdirSync(dir)) {
		if (!name.includes(".tmp-")) continue;
		const p = path.join(dir, name);
		try {
			if (now - fs.statSync(p).mtimeMs > TMP_ORPHAN_MAX_AGE_MS) fs.rmSync(p);
		} catch {
			// Vanished between readdir/stat — another process beat us
			// to it; that IS the sweep.
		}
	}
};
