import { describe, expect, it, vi } from "vitest";

// F3b: platform.ts publishes the AcpBridge durable-object handoff on the
// server runtime — the bridge route calls it with (endpointId, request)
// and the DO stamps ai_endpoint.last_seen_at on connect/heartbeat.
// Each scenario re-imports the module after rewiring the env double —
// vi.resetModules gives a fresh env + composition.

const compose = async (configure: (env: Record<string, unknown>) => void) => {
	vi.resetModules();
	const { env } = await import("#/test/cloudflare-workers.ts");
	configure(env as Record<string, unknown>);
	await import("./platform.ts");
	const { getServerRuntime } = await import("@ktb/server-fns");
	return getServerRuntime();
};

describe("platform acpBridge capability", () => {
	it(
		"rewrites ?endpoint= and dispatches to the named durable object",
		{ timeout: 30_000 }, // first compose pays the full app import cost
		async () => {
			const seen: { id: unknown; request: Request }[] = [];
			const runtime = await compose((env) => {
				env.ACP_BRIDGE = {
					idFromName: (name: string) => `do-${name}`,
					get: (id: unknown) => ({
						fetch: async (request: Request) => {
							seen.push({ id, request });
							return new Response("bridged");
						},
					}),
				};
			});

			expect(runtime.acpBridge).toBeDefined();
			const res = await runtime.acpBridge!(
				7,
				new Request("https://app.test/api/ai/bridge?token=tok"),
			);
			expect(await res.text()).toBe("bridged");
			expect(seen).toHaveLength(1);
			// The namespace lookup keys on the endpoint id.
			expect(seen[0]!.id).toBe("do-7");
			const url = new URL(seen[0]!.request.url);
			expect(url.searchParams.get("endpoint")).toBe("7");
			expect(url.searchParams.get("token")).toBe("tok");
		},
	);

	it("stays undefined when the binding is absent", async () => {
		const runtime = await compose((env) => {
			env.ACP_BRIDGE = undefined;
		});
		expect(runtime.acpBridge).toBeUndefined();
	});
});
