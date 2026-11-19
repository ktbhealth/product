import { describe, expect, it } from "vitest";

import { insertJobRun, listJobRuns } from "@ktb/jobs-port";

import { openWorkerDb } from "./db.ts";

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
