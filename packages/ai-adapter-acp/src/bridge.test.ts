import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { fnvHex, LlmPort } from "@ktb/eval-consultation";

import { makeBridgeAcpLlm, makeBridgeRpc, type BridgeNamespace } from "./bridge.ts";

const chunk = (text: string) => ({
	jsonrpc: "2.0",
	method: "session/update",
	params: {
		update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
	},
});

interface Wire {
	readonly id?: string;
	readonly method: string;
	readonly params?: unknown;
}

/** Fake DO namespace: each stub.fetch call runs the scripted handler;
 * the canned `response` must NOT set `id` — the fake echoes the
 * request id back the way the real DO does. */
const fakeNs = (
	handler: (wire: Wire) => {
		readonly response?: {
			readonly result?: unknown;
			readonly error?: { code: number; message: string };
		};
		readonly notifications?: readonly unknown[];
		readonly status?: number;
		readonly body?: string;
	},
) => {
	const wires: Wire[] = [];
	const urls: string[] = [];
	const inits: (RequestInit | undefined)[] = [];
	const ns: BridgeNamespace = {
		idFromName: (name: string) => name,
		get: (id: unknown) => ({
			fetch: async (url: unknown, init?: RequestInit) => {
				urls.push(String(url));
				inits.push(init);
				const wire = JSON.parse(String((init as { body: string }).body)) as Wire;
				wires.push(wire);
				const reply = handler(wire);
				if (reply.body !== undefined)
					return new Response(reply.body, { status: reply.status ?? 200 });
				const out: Record<string, unknown> = { notifications: reply.notifications ?? [] };
				if (reply.response !== undefined) out.response = { id: wire.id, ...reply.response };
				return new Response(JSON.stringify(out), { status: reply.status ?? 200 });
			},
		}),
	};
	return { ns, wires, urls, inits };
};

const ok = (result: unknown = {}) => ({ response: { result } });
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("makeBridgeRpc", () => {
	it("forwards requests over the DO and replays buffered notifications", async () => {
		const { ns, wires } = fakeNs(() => ({
			response: { result: { answer: 42 } },
			notifications: [chunk("hey")],
		}));
		const seen: { method: string; params: unknown }[] = [];
		const rpc = makeBridgeRpc({
			ns,
			name: "ep-1",
			onNotification: (m, p) => seen.push({ method: m, params: p }),
		});
		const out = await Effect.runPromise(rpc.request("initialize", { v: 1 }));
		expect(out).toEqual({ answer: 42 });
		expect(wires[0]).toMatchObject({
			jsonrpc: "2.0",
			method: "initialize",
			params: { v: 1 },
		});
		expect(wires[0]!.id).toMatch(/^req-/);
		expect(urls[0]).toBe("https://acp-bridge.internal/rpc");
		expect(inits[0]?.method).toBe("POST");
		expect(inits[0]?.headers).toEqual({ "Content-Type": "application/json" });
		expect(seen).toHaveLength(1);
		expect(seen[0]!.method).toBe("session/update");
	});

	it("correlates request ids sequentially", async () => {
		const { ns, wires } = fakeNs(() => ok());
		const rpc = makeBridgeRpc({ ns, name: "e" });
		await Effect.runPromise(rpc.request("a"));
		await Effect.runPromise(rpc.request("b"));
		expect(wires[0]!.id).toBe("req-1");
		expect(wires[1]!.id).toBe("req-2");
	});

	it("sends notifications fire-and-forget", async () => {
		const { ns, wires } = fakeNs(() => ({ status: 202 }));
		const rpc = makeBridgeRpc({ ns, name: "ep-1" });
		rpc.notify("session/cancel", { sessionId: "s" });
		await tick();
		expect(wires[0]).toMatchObject({
			jsonrpc: "2.0",
			method: "session/cancel",
			params: { sessionId: "s" },
		});
		expect(wires[0]!.id).toBeUndefined();
		// A dead socket on a notification must not throw.
		const dead = makeBridgeRpc({
			ns: {
				idFromName: (n: string) => n,
				get: () => ({ fetch: async () => Promise.reject(new Error("down")) }),
			},
			name: "e",
		});
		dead.notify("session/cancel");
		await tick();
	});

	it("fails agent-replied errors and id mismatches as PortError", async () => {
		const errNs = fakeNs(() => ({
			response: { error: { code: -32601, message: "agent said no" } },
		}));
		const rpc = makeBridgeRpc({ ns: errNs.ns, name: "e" });
		await expect(Effect.runPromise(rpc.request("x"))).rejects.toMatchObject({
			message: "agent error -32601: agent said no",
		});
		// No `response` at all → id mismatch.
		const mismatch = fakeNs(() => ({}));
		const rpc2 = makeBridgeRpc({ ns: mismatch.ns, name: "e" });
		await expect(Effect.runPromise(rpc2.request("x"))).rejects.toMatchObject({
			port: "llm",
			message: expect.stringContaining("id mismatch"),
		});
		// A response correlated to a different id → id mismatch too.
		const wrongId = fakeNs(() => ({
			body: JSON.stringify({ response: { id: "req-999", result: {} } }),
		}));
		const rpc3 = makeBridgeRpc({ ns: wrongId.ns, name: "e" });
		await expect(Effect.runPromise(rpc3.request("x"))).rejects.toMatchObject({
			port: "llm",
			message: expect.stringContaining("id mismatch"),
		});
	});

	it("maps DO status codes to PortError and survives bad bodies", async () => {
		const offline = makeBridgeRpc({ ns: fakeNs(() => ({ status: 503 })).ns, name: "e" });
		await expect(Effect.runPromise(offline.request("x"))).rejects.toMatchObject({
			message: "acp bridge: bridge_offline",
		});
		const hung = makeBridgeRpc({ ns: fakeNs(() => ({ status: 504 })).ns, name: "e" });
		await expect(Effect.runPromise(hung.request("x"))).rejects.toMatchObject({
			message: "acp bridge: bridge 504",
		});
		const bad = makeBridgeRpc({
			ns: fakeNs(() => ({ body: "not json" })).ns,
			name: "e",
		});
		await expect(Effect.runPromise(bad.request("x"))).rejects.toMatchObject({
			message: expect.stringContaining("bad response"),
		});
		const broken = makeBridgeRpc({
			ns: {
				idFromName: (n: string) => n,
				get: () => ({ fetch: async () => Promise.reject(new Error("stub dead")) }),
			},
			name: "e",
		});
		await expect(Effect.runPromise(broken.request("x"))).rejects.toMatchObject({
			message: expect.stringContaining("stub dead"),
		});
		// A non-Error rejection stringifies instead of unwrapping.
		const strung = makeBridgeRpc({
			ns: {
				idFromName: (n: string) => n,
				get: () => ({ fetch: async () => Promise.reject("socket gone") }),
			},
			name: "e",
		});
		await expect(Effect.runPromise(strung.request("x"))).rejects.toMatchObject({
			message: "acp bridge: socket gone",
		});
	});

	it("tolerates missing notifications and skips frames with no method or sink", async () => {
		// A body without a `notifications` key exercises the `?? []` arm.
		const bare = fakeNs((wire) => ({
			body: JSON.stringify({ response: { id: wire.id, result: "ok" } }),
		}));
		const rpc = makeBridgeRpc({ ns: bare.ns, name: "e" });
		await expect(Effect.runPromise(rpc.request("x"))).resolves.toBe("ok");
		// Notifications present but no sink, plus a methodless frame —
		// both replay guards take their skip arm.
		const noisy = fakeNs(() => ({
			response: { result: "ok" },
			notifications: [{ method: "session/update", params: {} }, { params: {} }],
		}));
		const seen: { method: string; params: unknown }[] = [];
		const rpc2 = makeBridgeRpc({
			ns: noisy.ns,
			name: "e",
			onNotification: (m, p) => seen.push({ method: m, params: p }),
		});
		await expect(Effect.runPromise(rpc2.request("x"))).resolves.toBe("ok");
		// The methodless frame is skipped; only the real notification lands.
		expect(seen).toEqual([{ method: "session/update", params: {} }]);
	});

	it("replays notifications on session/new (agent hello during setup)", async () => {
		const { ns } = fakeNs((wire) =>
			wire.method === "session/new"
				? { response: { result: { sessionId: "s-9" } }, notifications: [chunk("unused")] }
				: ok(),
		);
		const seen: string[] = [];
		const rpc = makeBridgeRpc({ ns, name: "e", onNotification: (m) => seen.push(m) });
		await Effect.runPromise(rpc.request("session/new", {}));
		expect(seen).toEqual(["session/update"]);
	});
});

describe("makeBridgeAcpLlm", () => {
	const env = { taskId: "t", role: "generator" as const, input: "i", outputSchema: "Text" };

	it("drives a full session over the DO and returns the agent text", async () => {
		const { ns, wires } = fakeNs((wire) => {
			if (wire.method === "session/prompt")
				return { response: { result: {} }, notifications: [chunk("hello "), chunk("bridge")] };
			if (wire.method === "session/new") return ok({ sessionId: "s-b" });
			return ok();
		});
		const layer = makeBridgeAcpLlm({ ns, endpointId: 9 });
		const out = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) => l.generate(env)).pipe(Effect.provide(layer)),
		);
		expect(out.text).toBe("hello bridge");
		expect(out.record.engine).toBe("acp-bridge");
		// engineVersion defaults to a stable hash of the endpoint id.
		expect(out.record.engineVersion).toBe(fnvHex("bridge:9"));
		expect(wires.map((w) => w.method)).toEqual(["initialize", "session/new", "session/prompt"]);
	});

	it("times out a hung DO request using the configured timeoutMs", async () => {
		const ns: BridgeNamespace = {
			idFromName: (n: string) => n,
			get: () => ({
				fetch: (_url: unknown, init?: RequestInit) =>
					new Promise<Response>((resolve) =>
						setTimeout(() => {
							const wire = JSON.parse(String((init as { body: string }).body)) as Wire;
							resolve(
								new Response(
									JSON.stringify({
										notifications: [],
										response: {
											id: wire.id,
											result: wire.method === "session/new" ? { sessionId: "s-b" } : {},
										},
									}),
									{ status: 200 },
								),
							);
						}, 50),
					),
			}),
		};
		const layer = makeBridgeAcpLlm({ ns, endpointId: 9, timeoutMs: 10 });
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) => l.generate(env)).pipe(Effect.provide(layer)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("timeout") });
	});

	it("forwards sessionId/cwd/timeoutMs/egress into the session layer", async () => {
		const { ns, wires } = fakeNs((wire) =>
			wire.method === "session/new" ? ok({ sessionId: "s-b" }) : ok(),
		);
		const layer = makeBridgeAcpLlm({
			ns,
			endpointId: 9,
			sessionId: "run-77",
			cwd: "/work",
			timeoutMs: 5_000,
			egress: false,
		});
		const out = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) => {
				expect(l.egress).toBe(false);
				return l.generate(env);
			}).pipe(Effect.provide(layer)),
		);
		expect(out.record.runId).toBe("run-77");
		expect(wires.find((w) => w.method === "session/new")).toMatchObject({
			params: { cwd: "/work" },
		});
	});

	it("surfaces bridge_offline when the DO has no attached socket", async () => {
		const { ns } = fakeNs(() => ({ status: 503 }));
		const layer = makeBridgeAcpLlm({ ns, endpointId: 9 });
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) => l.generate(env)).pipe(Effect.provide(layer)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("bridge_offline") });
	});
});
