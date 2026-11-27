import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { insertJobRun, listJobRuns } from "@ktb/jobs-port";

import { openWorkerDb, workerDbFilename } from "./db.ts";

const WEB_DIR = fileURLToPath(new URL("../../../apps/web", import.meta.url));

describe("openWorkerDb", () => {
	it("returns undefined when JOBS_DB=off", () => {
		expect(openWorkerDb({ JOBS_DB: "off" })).toBeUndefined();
	});

	it("opens a migrated db that round-trips job_runs rows", async () => {
		const db = openWorkerDb({ DATABASE_URL: ":memory:" });
		expect(db).toBeDefined();
		await insertJobRun(db!, {
			id: "run-1",
			kind: "jobs.ping",
			status: "queued",
		});
		const runs = await listJobRuns(db!, { kind: "jobs.ping" });
		expect(runs.map((r) => r.id)).toContain("run-1");
	});
});

describe("workerDbFilename", () => {
	it("keeps :memory: and absolute paths untouched", () => {
		expect(workerDbFilename(":memory:")).toBe(":memory:");
		expect(workerDbFilename("sqlite::memory:")).toBe(":memory:");
		const abs = fileURLToPath(new URL("../../../tmp/x.db", import.meta.url));
		expect(workerDbFilename(abs)).toBe(abs);
	});

	it("resolves relative paths against apps/web, not the worker cwd", () => {
		expect(workerDbFilename("./data/app.db")).toBe(`${WEB_DIR}/data/app.db`);
		expect(workerDbFilename("sqlite:./data/app.db")).toBe(`${WEB_DIR}/data/app.db`);
		expect(workerDbFilename("file:./x.db")).toBe(`${WEB_DIR}/x.db`);
	});
});
