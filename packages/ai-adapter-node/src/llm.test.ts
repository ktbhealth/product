import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import { makeAcpSessionLlm } from "@ktb/ai-adapter-acp";
import {
	fnvHex,
	LlmPort,
	outputValidators,
	type LlmEndpointDescriptor,
	type TaskEnvelope,
} from "@ktb/eval-consultation";

import { makeNodeAcpLlm, resolveNodeAcp } from "./llm.ts";
import { makeStdioRpc, type SpawnedProcess, type SpawnImpl } from "./stdio-rpc.ts";

// Spy on the two delegation boundaries (call-through wrappers) so tests
// can assert which option keys were forwarded — an explicit
// `key: undefined` is observable here even though downstream `??` /
// `!== undefined` guards treat it like an absent key.
vi.mock("@ktb/ai-adapter-acp", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/ai-adapter-acp")>();
	return { ...actual, makeAcpSessionLlm: vi.fn(actual.makeAcpSessionLlm) };
});
vi.mock("./stdio-rpc.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./stdio-rpc.ts")>();
	return { ...actual, makeStdioRpc: vi.fn(actual.makeStdioRpc) };
});

// --- fake ACP agent (in-memory, same helper shape as acp-client.test) -------

interface FakeProc extends SpawnedProcess {
	readonly frames: Record<string, unknown>[];
}

const agentProc = (
	replyText: string,
	opts?: { readonly promptDelayMs?: number },
): { proc: FakeProc; spawnImpl: () => FakeProc } => {
	const frames: Record<string, unknown>[] = [];
	const outHandlers: ((chunk: string | Uint8Array) => void)[] = [];
	const evtHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
	let lineBuf = "";
	const send = (o: unknown) => {
		for (const h of outHandlers) h(`${JSON.stringify(o)}\n`);
	};
	const proc: FakeProc = {
		frames,
		stdin: {
			write: (chunk) => {
				lineBuf += chunk;
				const lines = lineBuf.split("\n");
				lineBuf = lines.pop()!;
				for (const line of lines) {
					if (line.trim() === "") continue;
					const msg = JSON.parse(line) as Record<string, unknown>;
					frames.push(msg);
					if (msg.method === "initialize") {
						send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
					} else if (msg.method === "session/new") {
						send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-fake" } });
					} else if (msg.method === "session/prompt") {
						const reply = () => {
							send({
								jsonrpc: "2.0",
								method: "session/update",
								params: {
									sessionId: "sess-fake",
									update: {
										sessionUpdate: "agent_message_chunk",
										content: { type: "text", text: replyText },
									},
								},
							});
							send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
						};
						if (opts?.promptDelayMs === undefined) reply();
						else setTimeout(reply, opts.promptDelayMs);
					}
				}
			},
			end: () => {},
		},
		stdout: {
			on: (_event, listener) => {
				outHandlers.push(listener);
			},
		},
		on: (event, listener) => {
			evtHandlers.set(event, [...(evtHandlers.get(event) ?? []), listener]);
		},
		kill: () => {},
	};
	return { proc, spawnImpl: () => proc };
};

/** Real spawned agent — CJS so `node -e`/`bun -e` both run it. */
const REAL_AGENT_SCRIPT = [
	'let b="";const send=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
	'process.stdin.on("data",(d)=>{b+=d;const ls=b.split("\\n");b=ls.pop();',
	"for(const l of ls){if(!l.trim())continue;const m=JSON.parse(l);",
	'if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1}});',
	'else if(m.method==="session/new")send({jsonrpc:"2.0",id:m.id,result:{sessionId:"s-real"}});',
	'else if(m.method==="session/prompt"){',
	'send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"s-real",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"real-reply"}}}});',
	'send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});}}});',
].join("");

const env = (over?: Partial<TaskEnvelope>): TaskEnvelope => ({
	taskId: "t-1",
	role: "generator",
	input: "say hi",
	outputSchema: "Text",
	...over,
});

const generate = (opts: Parameters<typeof makeNodeAcpLlm>[0], envelope = env()) =>
	Effect.runPromise(
		Effect.flatMap(LlmPort, (l) => l.generate(envelope)).pipe(Effect.provide(makeNodeAcpLlm(opts))),
	);

describe("makeNodeAcpLlm", () => {
	it("generates text from the agent's message chunks (real spawn)", async () => {
		const out = await generate({ argv: [process.execPath, "-e", REAL_AGENT_SCRIPT] });
		expect(out.text).toBe("real-reply");
		expect(out.record.engine).toBe("acp-node");
		expect(out.record.stage).toBe("script_gen");
		expect(out.record.runId).toBe("acp-node");
	});

	it("threads sessionId/engineVersion/cwd and the seeded input hash", async () => {
		const { proc, spawnImpl } = agentProc("reply");
		const out = await generate(
			{
				argv: ["agent"],
				spawnImpl,
				sessionId: "sess-9",
				engineVersion: "ep-1",
				cwd: "/work",
				timeoutMs: 5_000,
			},
			env({ seed: 3 }),
		);
		expect(out.text).toBe("reply");
		expect(out.record.runId).toBe("sess-9");
		expect(out.record.engineVersion).toBe("ep-1");
		expect(out.record.seed).toBe(3);
		expect(proc.frames.find((f) => f.method === "session/new")).toMatchObject({
			params: { cwd: "/work" },
		});
	});

	it("times out a stalled prompt at the configured timeoutMs", async () => {
		const { spawnImpl } = agentProc("too-late", { promptDelayMs: 200 });
		const err = await generate({ argv: ["a"], spawnImpl, timeoutMs: 25 }, env()).then(
			() => null,
			(e) => e,
		);
		expect(err.message).toContain("timeout");
	});

	it("rejects an unknown outputSchema before validating", async () => {
		const { spawnImpl } = agentProc("reply");
		const err = await generate({ argv: ["a"], spawnImpl }, env({ outputSchema: "Nope" })).then(
			() => null,
			(e) => e,
		);
		expect(err.message).toContain("unknown outputSchema: Nope");
	});

	it("fails typed when the reply fails the declared validator", async () => {
		// Empty reply text → ConsultationScript's non-empty check throws.
		const { spawnImpl } = agentProc("");
		const err = await generate(
			{ argv: ["a"], spawnImpl },
			env({ outputSchema: "ConsultationScript" }),
		).then(
			() => null,
			(e) => e,
		);
		expect(err.message).toContain("payload failed ConsultationScript validation");
	});

	it("wraps a non-Error validator throw in the PortError message", async () => {
		const { spawnImpl } = agentProc("reply");
		// Adapters may register custom validators — a non-Error throw
		// (a plain string) still lands in the typed message.
		(outputValidators as Record<string, unknown>).NonErr = () => {
			throw "plain failure";
		};
		try {
			const err = await generate({ argv: ["a"], spawnImpl }, env({ outputSchema: "NonErr" })).then(
				() => null,
				(e) => e,
			);
			expect(err.message).toContain("plain failure");
		} finally {
			delete (outputValidators as Record<string, unknown>).NonErr;
		}
	});

	it("rejects a validator that succeeds with a non-string payload", async () => {
		const { spawnImpl } = agentProc("reply");
		(outputValidators as Record<string, unknown>).NotString = () => ({ nope: 1 });
		try {
			const err = await generate(
				{ argv: ["a"], spawnImpl },
				env({ outputSchema: "NotString" }),
			).then(
				() => null,
				(e) => e,
			);
			expect(err.message).toContain("requires a string payload, NotString produced object");
		} finally {
			delete (outputValidators as Record<string, unknown>).NotString;
		}
	});

	it("surfaces transport failures as PortError", async () => {
		const err = await generate({ argv: ["definitely-not-a-real-command-ktb-xyz"] }, env()).then(
			() => null,
			(e) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect(err._tag).toBe("PortError");
	});

	it("correct: parses the agent's reply text as an EditList", async () => {
		const edits = { ops: [{ at: 0, remove: "a", insert: "b", kind: "fix" }] };
		const { spawnImpl } = agentProc(JSON.stringify(edits));
		const out = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) =>
				l.correct(env({ role: "corrector", outputSchema: "EditList" })),
			).pipe(Effect.provide(makeNodeAcpLlm({ argv: ["a"], spawnImpl }))),
		);
		expect(out.edits.ops).toHaveLength(1);
		expect(out.record.stage).toBe("cleanup");
	});

	it("correct: enforces the EditList contract and fails on bad JSON", async () => {
		const { spawnImpl } = agentProc("not json");
		const layer = makeNodeAcpLlm({ argv: ["a"], spawnImpl });
		const schemaErr = await Effect.runPromise(
			Effect.flip(
				Effect.flatMap(LlmPort, (l) => l.correct(env({ role: "corrector", outputSchema: "Text" }))),
			).pipe(Effect.provide(layer)),
		);
		expect(schemaErr.message).toContain("outputSchema=EditList");
		const parseErr = await Effect.runPromise(
			Effect.flip(
				Effect.flatMap(LlmPort, (l) =>
					l.correct(env({ role: "corrector", outputSchema: "EditList" })),
				),
			).pipe(Effect.provide(layer)),
		);
		expect(parseErr.message).toContain("payload failed EditList validation");
	});

	it("declares egress by default and honors the override", async () => {
		const read = (opts: Parameters<typeof makeNodeAcpLlm>[0]) =>
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) => Effect.succeed(l.egress)).pipe(
					Effect.provide(makeNodeAcpLlm(opts)),
				),
			);
		expect(await read({ argv: ["a"], spawnImpl: agentProc("x").spawnImpl })).toBe(true);
		expect(await read({ argv: ["a"], egress: false, spawnImpl: agentProc("x").spawnImpl })).toBe(
			false,
		);
	});

	it("omits unset options when building the ACP session layer", async () => {
		const { spawnImpl } = agentProc("ok");
		await generate({ argv: ["a"], spawnImpl });
		const layerOpts = vi.mocked(makeAcpSessionLlm).mock.calls.at(-1)![0];
		for (const key of ["cwd", "sessionId", "timeoutMs", "egress", "engineVersion"]) {
			expect(key in layerOpts, key).toBe(false);
		}
	});

	it("passes permissionPolicy to the transport only when set", async () => {
		const { spawnImpl } = agentProc("ok");
		await generate({ argv: ["a"], spawnImpl, permissionPolicy: "allow" });
		let rpcOpts = vi.mocked(makeStdioRpc).mock.calls.at(-1)![0];
		expect(rpcOpts.permissionPolicy).toBe("allow");
		await generate({ argv: ["a"], spawnImpl });
		rpcOpts = vi.mocked(makeStdioRpc).mock.calls.at(-1)![0];
		expect("permissionPolicy" in rpcOpts).toBe(false);
	});

	it("omits spawnImpl when none was configured", async () => {
		// The bogus argv fails the real spawn path, but makeStdioRpc is
		// still invoked — inspect the options object it received.
		await generate({ argv: ["definitely-not-a-real-command-ktb-xyz"] }).then(
			() => null,
			() => null,
		);
		const rpcOpts = vi.mocked(makeStdioRpc).mock.calls.at(-1)![0];
		expect("spawnImpl" in rpcOpts).toBe(false);
	});
});

describe("resolveNodeAcp", () => {
	const resolve = (d: LlmEndpointDescriptor, spawnImpl?: SpawnImpl) =>
		Effect.runPromise(resolveNodeAcp(d, spawnImpl !== undefined ? { spawnImpl } : undefined));

	it("refuses ws descriptors — they belong to @ktb/ai-adapter-acp", async () => {
		await expect(resolve({ kind: "acp", baseUrl: "http://x" })).rejects.toMatchObject({
			port: "llm",
			message: expect.stringContaining("ai-adapter-acp"),
		});
	});

	it("fails typed without a Node/Bun runtime", async () => {
		vi.stubGlobal("process", undefined);
		try {
			await expect(
				resolve({ kind: "acp", baseUrl: "x", transport: "child", agentCmd: "cat" }),
			).rejects.toMatchObject({
				message: expect.stringContaining("requires a Node/Bun runtime"),
			});
			await expect(
				resolve({
					kind: "acp",
					baseUrl: "x",
					transport: "ssh",
					agentCmd: "cat",
					sshHost: "u@h",
				}),
			).rejects.toMatchObject({ message: expect.stringContaining("@ktb/ai-adapter-node") });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("requires agentCmd for child/ssh and sshHost for ssh", async () => {
		await expect(resolve({ kind: "acp", baseUrl: "x", transport: "child" })).rejects.toMatchObject({
			message: expect.stringContaining("require agentCmd"),
		});
		await expect(
			resolve({ kind: "acp", baseUrl: "x", transport: "child", agentCmd: "   " }),
		).rejects.toMatchObject({ message: expect.stringContaining("require agentCmd") });
		await expect(
			resolve({ kind: "acp", baseUrl: "x", transport: "ssh", agentCmd: "claude-agent-acp" }),
		).rejects.toMatchObject({ message: expect.stringContaining("require sshHost") });
		await expect(
			resolve({
				kind: "acp",
				baseUrl: "x",
				transport: "ssh",
				agentCmd: "claude-agent-acp",
				sshHost: " ",
			}),
		).rejects.toMatchObject({ message: expect.stringContaining("require sshHost") });
	});

	it("spawns the agentCmd argv for child descriptors", async () => {
		const { spawnImpl } = agentProc("child-ok");
		const captured: string[][] = [];
		const layer = await resolve(
			{
				kind: "acp",
				baseUrl: "x",
				transport: "child",
				agentCmd: "claude-agent-acp",
				sessionId: "sess-7",
				timeoutMs: 9_000,
			},
			(cmd, args) => {
				captured.push([cmd, ...args]);
				return spawnImpl();
			},
		);
		const out = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) => l.generate(env())).pipe(Effect.provide(layer)),
		);
		expect(out.text).toBe("child-ok");
		expect(out.record.runId).toBe("sess-7");
		expect(out.record.engineVersion).toBe(fnvHex("child:claude-agent-acp"));
		expect(captured[0]).toEqual(["claude-agent-acp"]);
	});

	it("spawns ssh <host> <cmd> for ssh descriptors", async () => {
		const { spawnImpl } = agentProc("ssh-ok");
		const captured: string[][] = [];
		const layer = await resolve(
			{
				kind: "acp",
				baseUrl: "x",
				transport: "ssh",
				agentCmd: "gemini --acp",
				sshHost: "u@h",
				sessionId: "ssh-sess",
				timeoutMs: 7_000,
			},
			(cmd, args) => {
				captured.push([cmd, ...args]);
				return spawnImpl();
			},
		);
		const out = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) => l.generate(env())).pipe(Effect.provide(layer)),
		);
		expect(out.text).toBe("ssh-ok");
		expect(out.record.runId).toBe("ssh-sess");
		expect(out.record.engineVersion).toBe(fnvHex("ssh:u@h:gemini --acp"));
		expect(captured[0]).toEqual(["ssh", "u@h", "gemini --acp"]);
	});

	it("honors descriptor timeoutMs for child and ssh transports", async () => {
		// The agent answers the handshake but stalls the prompt turn
		// past the 25ms budget — a dropped or widened timeout lets the
		// delayed reply through instead of failing.
		for (const transport of ["child", "ssh"] as const) {
			const { spawnImpl } = agentProc("too-late", { promptDelayMs: 200 });
			const layer = await resolve(
				{
					kind: "acp",
					baseUrl: "x",
					transport,
					agentCmd: "agent --acp",
					...(transport === "ssh" ? { sshHost: "u@h" } : {}),
					timeoutMs: 25,
				},
				spawnImpl,
			);
			const err = await Effect.runPromise(
				Effect.flip(Effect.flatMap(LlmPort, (l) => l.generate(env())).pipe(Effect.provide(layer))),
			);
			expect(err.message).toContain("timeout");
		}
	});

	it("splits agentCmd on whitespace runs, not single spaces", async () => {
		const { spawnImpl } = agentProc("ws-ok");
		const captured: string[][] = [];
		const layer = await resolve(
			{ kind: "acp", baseUrl: "x", transport: "child", agentCmd: "claude  agent\t--flag" },
			(cmd, args) => {
				captured.push([cmd, ...args]);
				return spawnImpl();
			},
		);
		await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) => l.generate(env())).pipe(Effect.provide(layer)),
		);
		expect(captured[0]).toEqual(["claude", "agent", "--flag"]);
	});

	it("resolves a bare ssh descriptor — defaults and no spawn override", async () => {
		const layer = await resolve({
			kind: "acp",
			baseUrl: "x",
			transport: "ssh",
			agentCmd: "gemini --acp",
			sshHost: "u@h",
		});
		expect(layer).toBeDefined();
	});

	it("resolves a bare child descriptor — defaults and no spawn override", async () => {
		const layer = await resolve({
			kind: "acp",
			baseUrl: "x",
			transport: "child",
			agentCmd: "claude acp",
		});
		expect(layer).toBeDefined();
	});
});
