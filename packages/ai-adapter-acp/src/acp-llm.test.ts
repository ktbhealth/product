import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { PortError } from "@ktb/eval-core";
import { fnvHex, LlmPort } from "@ktb/eval-consultation";

import { makeAcpSessionLlm } from "./acp-llm.ts";
import type { AcpRpc } from "./acp-client.ts";

type OnNotification = (method: string, params: unknown) => void;

/** connect that replays a scripted agent turn: chunks replyText during
 * the session/prompt request, then resolves it. */
const agentConnect = (replyText: string) => {
	const methods: string[] = [];
	const calls: { method: string; params: unknown }[] = [];
	const connect = (notify: OnNotification) =>
		Effect.succeed({
			request: (method: string, params?: unknown) => {
				methods.push(method);
				calls.push({ method, params });
				if (method === "session/new") return Effect.succeed({ sessionId: "s-llm" });
				if (method === "session/prompt") {
					notify("session/update", {
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: replyText },
						},
					});
					return Effect.succeed({});
				}
				return Effect.succeed({});
			},
			notify: () => {},
		} as AcpRpc);
	return { connect, methods, calls };
};

const env = (over?: Record<string, unknown>) => ({
	taskId: "t-1",
	role: "generator" as const,
	input: "i",
	outputSchema: "Text",
	...over,
});

const run = <A>(
	layer: ReturnType<typeof makeAcpSessionLlm>,
	e: Effect.Effect<A, PortError, LlmPort>,
) => Effect.runPromise(e.pipe(Effect.provide(layer)));

describe("makeAcpSessionLlm", () => {
	it("generate opens a fresh session per call and validates the reply", async () => {
		const agent = agentConnect("texto do agente");
		const layer = makeAcpSessionLlm({ connect: agent.connect, engine: "acp-bridge" });
		const r = await run(
			layer,
			Effect.flatMap(LlmPort, (l) => l.generate(env())),
		);
		expect(r.text).toBe("texto do agente");
		expect(r.record.engine).toBe("acp-bridge");
		expect(r.record.runId).toBe("acp-bridge");
		expect(r.record.stage).toBe("script_gen");
		expect(agent.methods).toEqual(["initialize", "session/new", "session/prompt"]);
		// engineVersion was not supplied — the record must not carry the key.
		expect("engineVersion" in r.record).toBe(false);
	});

	it("forwards cwd into session/new and defaults egress to true", async () => {
		const agent = agentConnect("ok");
		const layer = makeAcpSessionLlm({ connect: agent.connect, engine: "acp", cwd: "/work" });
		const out = await run(
			layer,
			Effect.flatMap(LlmPort, (l) =>
				Effect.gen(function* () {
					const r = yield* l.generate(env());
					return { egress: l.egress, r };
				}),
			),
		);
		expect(out.egress).toBe(true);
		expect(agent.calls.find((c) => c.method === "session/new")?.params).toMatchObject({
			cwd: "/work",
		});
	});

	it("honors egress:false", async () => {
		const layer = makeAcpSessionLlm({
			connect: agentConnect("ok").connect,
			engine: "acp",
			egress: false,
		});
		const egress = await run(
			layer,
			Effect.flatMap(LlmPort, (l) => Effect.succeed(l.egress)),
		);
		expect(egress).toBe(false);
	});

	it("times out a hung prompt using the configured timeoutMs", async () => {
		const connect = () =>
			Effect.succeed({
				request: (method: string) =>
					method === "session/prompt"
						? Effect.never
						: Effect.succeed(method === "session/new" ? { sessionId: "s-t" } : {}),
				notify: () => {},
			} as AcpRpc);
		const layer = makeAcpSessionLlm({ connect, engine: "acp", timeoutMs: 20 });
		await expect(
			run(
				layer,
				Effect.flatMap(LlmPort, (l) => l.generate(env())),
			),
		).rejects.toMatchObject({
			port: "llm",
			message: expect.stringContaining("timeout after 20ms"),
		});
	});

	it("hashes the declared input contract including the seed", async () => {
		const agent = agentConnect("x");
		const layer = makeAcpSessionLlm({ connect: agent.connect, engine: "acp" });
		const r = await run(
			layer,
			Effect.flatMap(LlmPort, (l) => l.generate(env({ seed: 7 }))),
		);
		expect(r.record.inputHash).toBe(fnvHex("t-1:Text:i:7"));
		expect(r.record.latencyMs).toBeGreaterThanOrEqual(0);
		expect(r.record.latencyMs).toBeLessThan(60_000);
	});

	it("records sessionId and engineVersion when supplied", async () => {
		const agent = agentConnect("ok");
		const layer = makeAcpSessionLlm({
			connect: agent.connect,
			engine: "acp-node",
			sessionId: "sess-x",
			engineVersion: "1.2.3",
			egress: false,
		});
		const svc = await Effect.runPromise(Effect.serviceOption(LlmPort).pipe(Effect.provide(layer)));
		const llm = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) => l.generate(env())).pipe(Effect.provide(layer)),
		);
		expect(llm.record.runId).toBe("sess-x");
		expect(llm.record.engineVersion).toBe("1.2.3");
		expect(svc._tag).toBe("Some");
	});

	it("rejects an unknown outputSchema and non-string payloads", async () => {
		const agent = agentConnect("anything");
		const layer = makeAcpSessionLlm({ connect: agent.connect, engine: "acp" });
		await expect(
			run(
				layer,
				Effect.flatMap(LlmPort, (l) => l.generate(env({ outputSchema: "Frobnicate" }))),
			),
		).rejects.toMatchObject({
			port: "llm",
			message: expect.stringContaining("unknown outputSchema"),
		});
		// A validator returning a non-string payload must still fail —
		// generate never casts an object into a lie.
		const { outputValidators } = await import("@ktb/eval-consultation");
		outputValidators.NonString = () => 42;
		const editAgent = agentConnect("anything");
		const editLayer = makeAcpSessionLlm({ connect: editAgent.connect, engine: "acp" });
		await expect(
			run(
				editLayer,
				Effect.flatMap(LlmPort, (l) => l.generate(env({ outputSchema: "NonString" }))),
			),
		).rejects.toMatchObject({ port: "llm", message: expect.stringContaining("string payload") });
		delete outputValidators.NonString;
	});

	it("wraps a throwing validator as a PortError naming schema and cause", async () => {
		const { outputValidators } = await import("@ktb/eval-consultation");
		outputValidators.Boom = () => {
			throw new Error("kaput");
		};
		try {
			const agent = agentConnect("anything");
			const layer = makeAcpSessionLlm({ connect: agent.connect, engine: "acp" });
			await expect(
				run(
					layer,
					Effect.flatMap(LlmPort, (l) => l.generate(env({ outputSchema: "Boom" }))),
				),
			).rejects.toMatchObject({
				port: "llm",
				message: expect.stringContaining("payload failed Boom validation"),
			});
			await expect(
				run(
					layer,
					Effect.flatMap(LlmPort, (l) => l.generate(env({ outputSchema: "Boom" }))),
				),
			).rejects.toMatchObject({ message: expect.stringContaining("kaput") });
		} finally {
			delete outputValidators.Boom;
		}
	});

	it("correct pins EditList, decodes the reply JSON, and sends the contract", async () => {
		const edits = { ops: [{ at: 0, remove: "a", insert: "b", kind: "fix" }] };
		const agent = agentConnect(JSON.stringify(edits));
		const layer = makeAcpSessionLlm({ connect: agent.connect, engine: "acp" });
		const out = await run(
			layer,
			Effect.flatMap(LlmPort, (l) => l.correct(env({ outputSchema: "EditList" }))),
		);
		expect(out.edits.ops).toHaveLength(1);
		expect(out.record.stage).toBe("cleanup");
		// ACP sessions have no system role — the corrector contract must
		// ride in the user turn ahead of the raw transcript (I-003).
		const prompt = agent.calls.find((c) => c.method === "session/prompt")?.params as {
			prompt: { text: string }[];
		};
		expect(prompt.prompt[0]?.text).toContain("transcript-correction backend");
		expect(prompt.prompt[0]?.text.endsWith("\n\ni")).toBe(true);
	});

	it("correct rejects non-EditList envelopes and malformed JSON replies", async () => {
		const agent = agentConnect("not json");
		const layer = makeAcpSessionLlm({ connect: agent.connect, engine: "acp" });
		await expect(
			run(
				layer,
				Effect.flatMap(LlmPort, (l) => l.correct(env())),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("outputSchema=EditList") });
		await expect(
			run(
				layer,
				Effect.flatMap(LlmPort, (l) => l.correct(env({ outputSchema: "EditList" }))),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("EditList validation") });
	});

	it("surfaces transport failures as PortError", async () => {
		const connect = () => Effect.fail(new PortError({ port: "llm", message: "bridge_offline" }));
		const layer = makeAcpSessionLlm({ connect, engine: "acp-bridge" });
		await expect(
			run(
				layer,
				Effect.flatMap(LlmPort, (l) => l.generate(env())),
			),
		).rejects.toMatchObject({ port: "llm", message: "bridge_offline" });
	});
});
