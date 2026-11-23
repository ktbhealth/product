import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlDatabase, SqlStatement } from "@ktb/db";

import { AcpBridge, type BridgeSocket, type BridgeDoState } from "./do.ts";

/**
 * The DO is structural — these fakes stand in for workerd's state,
 * WebSocketPair and the D1 binding.
 */

class FakeSocket implements BridgeSocket {
	readonly sent: string[] = [];
	closed: { code?: number; reason?: string } | null = null;
	send(data: string | ArrayBuffer): void {
		this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
	}
	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
}

class FakePair {
	0 = new FakeSocket();
	1 = new FakeSocket();
}

const makeState = (restored: readonly FakeSocket[] = []) => {
	const accepted: FakeSocket[] = [];
	const tags: (readonly string[] | undefined)[] = [];
	const waits: Promise<unknown>[] = [];
	const state: BridgeDoState & {
		readonly accepted: readonly FakeSocket[];
		readonly tags: readonly (readonly string[] | undefined)[];
		readonly waits: readonly Promise<unknown>[];
	} = {
		id: {},
		accepted,
		tags,
		waits,
		acceptWebSocket: (ws, t) => {
			accepted.push(ws as FakeSocket);
			tags.push(t);
		},
		getWebSockets: () => restored,
		waitUntil: (p) => {
			waits.push(p);
		},
	};
	return state;
};

/** Recording SqlDatabase fake — the DO now stamps last_seen_at through
 * drizzle, so tests observe the prepared SQL + bound params instead of
 * a hand-rolled prepare/bind/run surface. */
const makeDb = () => {
	const calls: { sql: string; args: readonly unknown[] }[] = [];
	const record = (sql: string, args: readonly unknown[]) => {
		calls.push({ sql, args });
		return { success: true, results: [], meta: {} };
	};
	const database: SqlDatabase = {
		prepare: (sql: string) => {
			let args: readonly unknown[] = [];
			const statement: SqlStatement = {
				bind: (...values: unknown[]) => {
					args = values;
					return statement;
				},
				first: async () => null,
				run: async () => record(sql, args),
				all: async () => record(sql, args),
				raw: async () => {
					record(sql, args);
					return [];
				},
			};
			return statement;
		},
		dump: async () => new ArrayBuffer(0),
		batch: async () => [],
		exec: async () => ({ count: 0, duration: 0 }),
	};
	return { calls, database };
};

const upgradeReq = (endpoint = 7) =>
	new Request(`https://x/?endpoint=${endpoint}`, { headers: { Upgrade: "websocket" } });

const rpcReq = (wire: unknown) =>
	new Request("https://x/rpc", { method: "POST", body: JSON.stringify(wire) });

/** `request.json()` defers the DO's socket.send by a macrotask — tests
 * that assert on `sent` or reply before awaiting must yield first. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AcpBridge", () => {
	let realResponse: typeof Response;
	beforeEach(() => {
		(globalThis as Record<string, unknown>).WebSocketPair = FakePair;
		// Node's undici Response rejects status 101 — workerd accepts it
		// (with `webSocket`). Polyfill just the upgrade shape.
		realResponse = globalThis.Response;
		const Base = realResponse;
		globalThis.Response = class extends Base {
			readonly webSocket: unknown;
			constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
				const status = init?.status;
				super(body ?? null, status === 101 ? { ...init, status: 200 } : init);
				Object.defineProperty(this, "status", { value: status });
				this.webSocket = init?.webSocket;
			}
			static json(data: unknown, init?: ResponseInit): Response {
				return Base.json(data, init) as unknown as Response;
			}
		} as typeof Response;
	});
	afterEach(() => {
		delete (globalThis as Record<string, unknown>).WebSocketPair;
		globalThis.Response = realResponse;
	});

	it("rejects non-upgrade GETs and missing endpoint", async () => {
		const b = new AcpBridge(makeState(), {});
		const notUpgrade = await b.fetch(new Request("https://x/?endpoint=1"));
		expect(notUpgrade.status).toBe(400);
		expect(await notUpgrade.text()).toBe("expected websocket upgrade");
		const missing = await b.fetch(new Request("https://x/", { headers: { Upgrade: "websocket" } }));
		expect(missing.status).toBe(400);
		expect(await missing.text()).toBe("missing endpoint");
		const zero = await b.fetch(
			new Request("https://x/?endpoint=0", { headers: { Upgrade: "websocket" } }),
		);
		expect(zero.status).toBe(400);
		const junk = await b.fetch(
			new Request("https://x/?endpoint=abc", { headers: { Upgrade: "websocket" } }),
		);
		expect(junk.status).toBe(400);
	});

	it("accepts the bridge socket via hibernation and stamps last_seen_at", async () => {
		const state = makeState();
		const db = makeDb();
		const b = new AcpBridge(state, { DB: db.database });
		const res = await b.fetch(upgradeReq(7));
		expect(res.status).toBe(101);
		expect(state.accepted).toHaveLength(1);
		expect(state.tags[0]).toEqual(["bridge"]);
		await state.waits[0]!; // the stamp is a waitUntil'd promise
		expect(db.calls).toHaveLength(1);
		expect(db.calls[0]!.sql).toContain("last_seen_at");
		expect(db.calls[0]!.args[1]).toBe(7);
		// timestamp_ms maps Date → epoch ms, same wire value as before.
		expect(typeof db.calls[0]!.args[0]).toBe("number");
	});

	it("answers 503 offline before any socket is held", async () => {
		const b = new AcpBridge(makeState(), {});
		const res = await b.fetch(rpcReq({ jsonrpc: "2.0", id: 1, method: "initialize" }));
		expect(res.status).toBe(503);
		expect(res.headers.get("content-type")).toBe("application/json");
		expect(await res.json()).toEqual({ error: "bridge_offline" });
	});

	it("still answers 503 offline for a malformed rpc body", async () => {
		const b = new AcpBridge(makeState(), {});
		// Offline short-circuits before the body is even parsed.
		const res = await b.fetch(rpcReq({ jsonrpc: "2.0" }));
		expect(res.status).toBe(503);
	});

	it("forwards a request and correlates the response by id", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: "req-1", method: "session/new" }));
		await tick();
		expect(JSON.parse(server.sent[0]!)).toMatchObject({ id: "req-1", method: "session/new" });
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { ok: 1 } }));
		const res = await pending;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { response: { result: { ok: number } } };
		expect(body.response.result.ok).toBe(1);
	});

	it("flushes buffered notifications with the next rpc response", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		b.webSocketMessage(
			server,
			JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } }),
		);
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 2, method: "session/prompt" }));
		await tick();
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }));
		const body = (await (await pending).json()) as {
			notifications: { method: string }[];
		};
		expect(body.notifications).toEqual([expect.objectContaining({ method: "session/update" })]);
	});

	it("forwards notifications fire-and-forget (202)", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const res = await b.fetch(rpcReq({ jsonrpc: "2.0", method: "session/cancel" }));
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ ok: true });
		expect(JSON.parse(state.accepted[0]!.sent[0]!)).toMatchObject({
			method: "session/cancel",
		});
	});

	it("400s malformed rpc bodies", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const bad = await b.fetch(rpcReq({ jsonrpc: "2.0" }));
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "bad frame" });
		const unparsable = await b.fetch(new Request("https://x/rpc", { method: "POST", body: "{" }));
		expect(unparsable.status).toBe(400);
		expect(await unparsable.json()).toEqual({ error: "bad frame" });
	});

	it("heartbeat updates last_seen_at and answers pong, never counting as rpc", async () => {
		const state = makeState();
		const db = makeDb();
		const b = new AcpBridge(state, { DB: db.database });
		await b.fetch(upgradeReq(3));
		const server = state.accepted[0]!;
		server.sent.length = 0;
		b.webSocketMessage(server, JSON.stringify({ type: "ping" }));
		await Promise.all(state.waits); // connect + heartbeat stamps
		expect(db.calls).toHaveLength(2);
		expect(JSON.parse(server.sent[0]!)).toEqual({ type: "pong" });
	});

	it("refuses agent→client requests with -32601", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		server.sent.length = 0;
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", id: 9, method: "fs/read" }));
		expect(JSON.parse(server.sent[0]!)).toEqual({
			jsonrpc: "2.0",
			id: 9,
			error: { code: -32601, message: "client does not implement fs/read" },
		});
	});

	it("ignores frames arriving on a socket that is not the bridge", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		const stranger = new FakeSocket();
		// A stray socket answering a pending id must not resolve it.
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 7, method: "m" }));
		await tick();
		b.webSocketMessage(stranger, JSON.stringify({ jsonrpc: "2.0", id: 7, result: "evil" }));
		b.webSocketMessage(stranger, JSON.stringify({ jsonrpc: "2.0", method: "evil/note" }));
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", id: 7, result: "ok" }));
		const res = await pending;
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			response: { result: string };
			notifications: unknown[];
		};
		expect(body.response.result).toBe("ok");
		expect(body.notifications).toEqual([]);
	});

	it("drops stray/invalid frames without touching pending rpcs", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		const other = new FakeSocket();
		b.webSocketMessage(other, JSON.stringify({ jsonrpc: "2.0", id: "x", result: 1 }));
		b.webSocketMessage(server, "not json");
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", id: "unknown", result: 1 }));
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 3, method: "m" }));
		await tick();
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", id: 3, result: "ok" }));
		expect((await pending).status).toBe(200);
	});

	it("times out a hung agent as 504", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {}, { rpcTimeoutMs: 5 });
		await b.fetch(upgradeReq());
		const res = await b.fetch(rpcReq({ jsonrpc: "2.0", id: 4, method: "slow" }));
		expect(res.status).toBe(504);
		expect(await res.json()).toEqual({ error: "bridge_timeout" });
	});

	it('id-less frames never correlate, not even against id "undefined"', async () => {
		const state = makeState();
		const b = new AcpBridge(state, {}, { rpcTimeoutMs: 20 });
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: "undefined", method: "m" }));
		await tick();
		// String(msg.id) of a missing id is "undefined" — a frame without
		// an id must not resolve the request that happens to share it.
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", result: "ghost" }));
		const res = await pending;
		expect(res.status).toBe(504);
	});

	it("fails in-flight rpcs fast when the socket closes, then stays offline", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 5, method: "m" }));
		await tick();
		b.webSocketClose(server, 1001, "gone", false);
		const res = await pending;
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "bridge_offline" });
		const after = await b.fetch(rpcReq({ jsonrpc: "2.0", id: 6, method: "m" }));
		expect(after.status).toBe(503);
		expect(await after.json()).toEqual({ error: "bridge_offline" });
	});

	it("a second bridge connection replaces the first socket", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const first = state.accepted[0]!;
		await b.fetch(upgradeReq());
		expect(first.closed?.reason).toBe("replaced");
		expect(state.accepted).toHaveLength(2);
		// Replies on the replaced socket are ignored.
		b.webSocketMessage(first, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "stale" }));
		const second = state.accepted[1]!;
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 1, method: "m" }));
		await tick();
		expect(JSON.parse(second.sent[0]!)).toMatchObject({ id: 1 });
		b.webSocketMessage(second, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));
		expect((await pending).status).toBe(200);
	});

	it("restores the held socket after a hibernation wake", async () => {
		const restored = new FakeSocket();
		const b = new AcpBridge(makeState([restored]), {});
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 8, method: "m" }));
		await tick();
		expect(restored.sent).toHaveLength(1);
		b.webSocketMessage(restored, JSON.stringify({ jsonrpc: "2.0", id: 8, result: "r" }));
		expect((await pending).status).toBe(200);
	});

	it("webSocketError detaches like close", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		b.webSocketError(state.accepted[0]!);
		expect((await b.fetch(rpcReq({ jsonrpc: "2.0", id: 1, method: "m" }))).status).toBe(503);
	});

	it("boots offline when the state carries no getWebSockets", async () => {
		const state: BridgeDoState = { id: {}, acceptWebSocket: () => {} };
		const b = new AcpBridge(state, {});
		expect((await b.fetch(rpcReq({ jsonrpc: "2.0", id: 1, method: "m" }))).status).toBe(503);
	});

	it("a restored socket heartbeats without an endpoint id and no DB write", async () => {
		const restored = new FakeSocket();
		const state = makeState([restored]);
		const db = makeDb();
		const b = new AcpBridge(state, { DB: db.database });
		b.webSocketMessage(restored, JSON.stringify({ type: "ping" }));
		expect(restored.sent[0]).toBe(JSON.stringify({ type: "pong" }));
		// endpointId is only set by a fresh upgrade — a restored socket
		// never knows it, so markSeen is a no-op until then.
		expect(db.calls).toHaveLength(0);
		expect(state.waits).toHaveLength(0);
	});

	it("upgrades fine without a D1 binding — stamping is best-effort", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		expect((await b.fetch(upgradeReq())).status).toBe(101);
		// No DB → no stamp was even attempted, so nothing is waitUntil'd.
		expect(state.waits).toHaveLength(0);
		b.webSocketMessage(state.accepted[0]!, JSON.stringify({ type: "ping" }));
		expect(state.accepted[0]!.sent[0]).toBe(JSON.stringify({ type: "pong" }));
	});

	it("upgrades on a bare state — no getWebSockets, no waitUntil", async () => {
		// workerd always provides both, but the class is structural:
		// missing optional slices must degrade, not throw.
		const accepted: FakeSocket[] = [];
		const state: BridgeDoState = {
			id: {},
			acceptWebSocket: (ws) => {
				accepted.push(ws as FakeSocket);
			},
		};
		const db = makeDb();
		const b = new AcpBridge(state, { DB: db.database });
		expect((await b.fetch(upgradeReq())).status).toBe(101);
		expect(accepted).toHaveLength(1);
	});

	it("swallows a failed last_seen_at write — never breaks the socket path", async () => {
		const failing = async (): Promise<never> => {
			throw new Error("d1 down");
		};
		const statement: SqlStatement = {
			bind: () => statement,
			first: failing,
			run: failing,
			all: failing,
			raw: failing,
		};
		const db: SqlDatabase = {
			prepare: () => statement,
			dump: async () => new ArrayBuffer(0),
			batch: async () => [],
			exec: async () => ({ count: 0, duration: 0 }),
		};
		const state = makeState();
		const b = new AcpBridge(state, { DB: db });
		expect((await b.fetch(upgradeReq())).status).toBe(101);
		expect(state.waits).toHaveLength(1);
		await state.waits[0]!; // resolves — the rejection is swallowed
	});

	it("closing a replaced socket is ignored — only the current socket detaches", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const first = state.accepted[0]!;
		await b.fetch(upgradeReq());
		b.webSocketClose(first, 1000, "replaced", true);
		b.webSocketError(first);
		// The second socket is still live.
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 3, method: "m" }));
		await tick();
		expect(JSON.parse(state.accepted[1]!.sent[0]!)).toMatchObject({ id: 3 });
		b.webSocketMessage(state.accepted[1]!, JSON.stringify({ jsonrpc: "2.0", id: 3, result: "x" }));
		expect((await pending).status).toBe(200);
	});

	it("answers 500 when workerd's WebSocketPair is absent", async () => {
		delete (globalThis as Record<string, unknown>).WebSocketPair;
		const b = new AcpBridge(makeState(), {});
		const res = await b.fetch(upgradeReq());
		expect(res.status).toBe(500);
		expect(await res.text()).toBe("durable objects require workerd");
	});

	it("answers 503 when the notification send throws", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		server.send = () => {
			throw new Error("dead");
		};
		const res = await b.fetch(rpcReq({ jsonrpc: "2.0", method: "session/cancel" }));
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "bridge_offline" });
	});

	it("answers 503 when the request forward throws", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		server.send = () => {
			throw new Error("dead");
		};
		const res = await b.fetch(rpcReq({ jsonrpc: "2.0", id: 9, method: "m" }));
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "bridge_offline" });
	});

	it("answers 404 outside the upgrade and /rpc routes", async () => {
		const b = new AcpBridge(makeState(), {});
		const other = await b.fetch(new Request("https://x/other", { method: "POST" }));
		expect(other.status).toBe(404);
		expect(await other.text()).toBe("not found");
		const del = await b.fetch(new Request("https://x/rpc", { method: "DELETE" }));
		expect(del.status).toBe(404);
	});

	it("decodes binary (ArrayBuffer) agent frames", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 4, method: "m" }));
		await tick();
		b.webSocketMessage(
			server,
			new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 4, result: "bin" })).buffer,
		);
		const res = await pending;
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ response: { result: "bin" } });
	});

	it("detaches when the pong reply fails", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		// Fail ONLY the pong write — a blanket send failure would also
		// break the follow-up rpc and mask a missing detach.
		server.send = (data) => {
			if (String(data).includes('"pong"')) throw new Error("dead");
			FakeSocket.prototype.send.call(server, data);
		};
		b.webSocketMessage(server, JSON.stringify({ type: "ping" }));
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 1, method: "m" }));
		await tick();
		// If the socket survived the failed pong, answer its rpc so the
		// run terminates — the status assertion is what fails.
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x" }));
		const res = await pending;
		expect(res.status).toBe(503);
	});

	it("detaches when the -32601 refusal fails to send", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		server.send = (data) => {
			if (String(data).includes("-32601")) throw new Error("dead");
			FakeSocket.prototype.send.call(server, data);
		};
		b.webSocketMessage(
			server,
			JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file" }),
		);
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 1, method: "m" }));
		await tick();
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x" }));
		const res = await pending;
		expect(res.status).toBe(503);
	});

	it("ignores bare non-RPC JSON frames", async () => {
		const state = makeState();
		const b = new AcpBridge(state, {});
		await b.fetch(upgradeReq());
		const server = state.accepted[0]!;
		b.webSocketMessage(server, JSON.stringify({ stray: true }));
		b.webSocketMessage(server, JSON.stringify({ id: 99 }));
		const pending = b.fetch(rpcReq({ jsonrpc: "2.0", id: 2, method: "m" }));
		await tick();
		b.webSocketMessage(server, JSON.stringify({ jsonrpc: "2.0", id: 2, result: "ok" }));
		expect((await pending).status).toBe(200);
	});
});
