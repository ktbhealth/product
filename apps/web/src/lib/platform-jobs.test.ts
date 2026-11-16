import { describe, expect, it, vi } from "vitest";

import { getJobRun, type JobEnvelope } from "@ktb/jobs-port";

// platform.ts publishes the generic jobs enqueuer (PL-007) on the server
// runtime when AUDIO_QUEUE is bound — same recompose pattern as
// platform-ops-probes.test.ts.

const compose = async (configure: (env: Record<string, unknown>) => void) => {
	vi.resetModules();
	const { env } = await import("#/test/cloudflare-workers.ts");
	configure(env as Record<string, unknown>);
	const platform = await import("./platform.ts");
	const { getServerRuntime } = await import("@ktb/server-fns");
	return { runtime: getServerRuntime(), platform };
};

describe("platform jobs enqueuer", () => {
	it(
		"enqueues envelopes through the bound queue and writes job_runs",
		{ timeout: 30_000 }, // first compose pays the full app import cost
		async () => {
			const sent: JobEnvelope[] = [];
			const { runtime, platform } = await compose((env) => {
				env.AUDIO_QUEUE = {
					send: async (body: unknown) => {
						sent.push(body as JobEnvelope);
					},
				};
			});

			expect(runtime.jobs).toBeDefined();
			const envelope = (await runtime.jobs!.enqueue(
				"test.kind",
				{ v: 1 },
				{
					tenantId: 3,
					payloadRef: "ref-1",
				},
			)) as JobEnvelope;
			expect(envelope).toMatchObject({
				kind: "test.kind",
				payload: { v: 1 },
				tenantId: 3,
			});
			expect(typeof envelope.id).toBe("string");
			expect(sent).toEqual([envelope]);

			// The job_runs projection row was written by the port adapter.
			expect(await getJobRun(platform.db, envelope.id)).toMatchObject({
				kind: "test.kind",
				status: "queued",
				payloadRef: "ref-1",
				tenantId: 3,
			});
		},
	);

	it("leaves jobs undefined when the queue binding is absent", async () => {
		const { runtime } = await compose((env) => {
			env.AUDIO_QUEUE = undefined;
		});
		expect(runtime.jobs).toBeUndefined();
	});
});
