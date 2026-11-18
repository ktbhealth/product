import { describe, expect, it } from "vitest";

import { jobHandlers } from "@ktb/jobs-port";

import { registerWorkerHandlers } from "./handlers.ts";

describe("registerWorkerHandlers", () => {
	it("registers the jobs.ping smoke kind idempotently", async () => {
		registerWorkerHandlers();
		registerWorkerHandlers();
		const reg = jobHandlers["jobs.ping"];
		expect(reg?.handle).toBeTypeOf("function");
		await reg!.handle({}, { id: "1", kind: "jobs.ping", payload: {}, tenantId: null });
	});
});
