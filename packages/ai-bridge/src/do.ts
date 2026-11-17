/**
 * do.ts — `AcpBridge` Durable Object: holds ONE active bridge
 * WebSocket per ai_endpoint (`idFromName(endpointId)`), with the
 * hibernation API so an idle bridge costs nothing.
 *
 * The bridge CLI is a DUMB BYTE PIPE: it relays JSON-RPC frames
 * between the held socket and a locally spawned agent's stdio. All
 * ACP semantics (initialize/session/prompt) live worker-side in
 * @ktb/ai-adapter-acp. SECURITY INVARIANT: the agent command never
 * comes from the server — it is a local `--cmd` flag on the CLI; this
 * object only ever forwards frames.
 *
 * Worker-facing contract (`stub.fetch`):
 *   GET with `Upgrade: websocket` + `?endpoint=<id>` — the bridge's
 *     inbound socket. Replaces any live socket (reconnect wins),
 *     stamps ai_endpoint.last_seen_at.
 *   POST /rpc — body is a JSON-RPC request or notification:
 *     `{id, method}` → forwarded over the socket; the response (same
 *       `id`) is awaited (~60s backstop) and answered as
 *       `{response, notifications}` — agent notifications buffered
 *       while requests were in flight are flushed with it.
 *     `{method}` (no id) → fire-and-forget, 202.
 *   Errors: 400 bad frame · 503 bridge_offline (no live socket —
 *   clears pending callers) · 504 bridge_timeout.
 *
 * Bridge-facing wire (one WS message = one JSON message):
 *   agent→worker frames pass through untouched; `{"type":"ping"}` is
 *   a control frame (heartbeat → last_seen_at, answered `pong`) and
 *   never reaches the RPC path. Agent→client REQUESTS (fs/permission/
 *   terminal) are refused with -32601 — same contract as the stdio
 *   transport.
 *
 * All types are structural — the class runs under workerd but is
 * fully mockable for tests (fake state, sockets, env).
 */

import { eq } from "drizzle-orm";

import { makeDb, type DbClient, type SqlDatabase } from "@ktb/db";
import { aiEndpoint } from "@ktb/db/schema";

const RPC_TIMEOUT_MS = 60_000;

/** The WebSocket slice the DO uses (workerd's WebSocket satisfies it). */
export interface BridgeSocket {
	send(data: string | ArrayBuffer): void;
	close(code?: number, reason?: string): void;
}

/** The DurableObjectState slice this class needs. */
export interface BridgeDoState {
	readonly id: { readonly toString?: () => string };
	acceptWebSocket(ws: BridgeSocket, tags?: readonly string[]): void;
	/** Live sockets surviving hibernation — restores `socket` on wake. */
	getWebSockets?(): readonly BridgeSocket[];
	waitUntil?(promise: Promise<unknown>): void;
}

/** The DB port for the last_seen_at write — the worker's SqlDatabase
 * binding (D1 today), adapted to drizzle lazily on first stamp. */
export interface AcpBridgeEnv {
	readonly DB?: SqlDatabase;
}

interface WireMessage {
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: unknown;
	readonly type?: string;
	readonly error?: { readonly code: number; readonly message: string };
}

type PendingOutcome =
	| { readonly kind: "response"; readonly response: WireMessage }
	| { readonly kind: "offline" }
	| { readonly kind: "timeout" };

interface Pending {
	readonly resolve: (outcome: PendingOutcome) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

export class AcpBridge {
	private socket: BridgeSocket | null = null;
	private endpointId: number | null = null;
	private db: DbClient | null = null;
	private readonly pending = new Map<string, Pending>();
	private notifies: WireMessage[] = [];
	private readonly rpcTimeoutMs: number;

	constructor(
		private readonly state: BridgeDoState,
		private readonly env: AcpBridgeEnv,
		/** Test knob — workerd constructs with (state, env) only. */
		opts?: { readonly rpcTimeoutMs?: number },
	) {
		this.rpcTimeoutMs = opts?.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
		// Hibernation wake: the runtime kept the accepted socket alive —
		// reclaim it as THE bridge socket (single-socket invariant).
		const live = state.getWebSockets?.() ?? [];
		this.socket = live[0] ?? null;
	}

	/** Drizzle client over the SqlDatabase binding — built once per DO
	 * instance (hibernation wakes construct fresh). */
	private stampDb(): DbClient | null {
		const raw = this.env.DB;
		if (raw === undefined) return null;
		this.db ??= makeDb(raw);
		return this.db;
	}

	/** Status-badge write — connect + heartbeat. Goes through drizzle
	 * (typed `ai_endpoint` update), never raw SQL. Best-effort: a
	 * failed stamp never breaks the socket path. */
	private markSeen() {
		if (this.endpointId === null) return;
		const db = this.stampDb();
		if (db === null) return;
		const endpointId = this.endpointId;
		const done = (async () => {
			await db
				.update(aiEndpoint)
				.set({ lastSeenAt: new Date() })
				.where(eq(aiEndpoint.id, endpointId));
		})().catch(() => {});
		this.state.waitUntil?.(done);
	}

	private detach(ws: BridgeSocket) {
		if (this.socket !== ws) return;
		this.socket = null;
		// The bridge is gone — every in-flight RPC fails fast instead of
		// hanging to its timeout.
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			this.pending.delete(id);
			p.resolve({ kind: "offline" });
		}
	}

	private upgrade(request: Request): Response {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("expected websocket upgrade", { status: 400 });
		}
		const endpointParam = new URL(request.url).searchParams.get("endpoint");
		const endpointId = endpointParam === null ? NaN : Number(endpointParam);
		if (!Number.isInteger(endpointId) || endpointId <= 0) {
			return new Response("missing endpoint", { status: 400 });
		}
		// A second bridge (reconnect, second machine) REPLACES the live
		// socket — stale holders must not steal replies.
		this.socket?.close(1000, "replaced");
		this.endpointId = endpointId;
		// workerd's WebSocketPair global, resolved structurally so this
		// module typechecks/tests outside workers-types (tests inject a
		// fake pair on globalThis).
		const Pair = (
			globalThis as {
				readonly WebSocketPair?: new () => { 0: BridgeSocket; 1: BridgeSocket };
			}
		).WebSocketPair;
		if (Pair === undefined) {
			return new Response("durable objects require workerd", { status: 500 });
		}
		const pair = new Pair();
		const client = pair[0];
		const server = pair[1];
		this.state.acceptWebSocket(server, ["bridge"]);
		this.socket = server;
		this.markSeen();
		return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
	}

	private async rpc(request: Request): Promise<Response> {
		if (this.socket === null) return json({ error: "bridge_offline" }, 503);
		const wire = (await request.json().catch(() => null)) as WireMessage | null;
		if (wire === null || typeof wire.method !== "string") {
			return json({ error: "bad frame" }, 400);
		}
		const socket = this.socket;
		if (wire.id === undefined) {
			// Notification — forwarded, never correlated.
			try {
				socket.send(JSON.stringify(wire));
			} catch {
				return json({ error: "bridge_offline" }, 503);
			}
			return json({ ok: true }, 202);
		}
		const id = String(wire.id);
		const outcome = await new Promise<PendingOutcome>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ kind: "timeout" });
			}, this.rpcTimeoutMs);
			this.pending.set(id, { resolve, timer });
			try {
				socket.send(JSON.stringify(wire));
			} catch {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ kind: "offline" });
			}
		});
		switch (outcome.kind) {
			case "offline":
				return json({ error: "bridge_offline" }, 503);
			case "timeout":
				return json({ error: "bridge_timeout" }, 504);
			case "response":
				// Flush notifications buffered while this request was in
				// flight — the worker-side client replays them in order.
				return json({ response: outcome.response, notifications: this.notifies.splice(0) });
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET") return this.upgrade(request);
		if (request.method === "POST" && url.pathname === "/rpc") return this.rpc(request);
		return new Response("not found", { status: 404 });
	}

	webSocketMessage(ws: BridgeSocket, message: string | ArrayBuffer): void {
		if (ws !== this.socket) return;
		const text = typeof message === "string" ? message : new TextDecoder().decode(message);
		let msg: WireMessage;
		try {
			msg = JSON.parse(text) as WireMessage;
		} catch {
			// A non-JSON frame from our own bridge is protocol corruption —
			// drop it; pending RPCs keep their timeout budget.
			return;
		}
		// Control frame: heartbeat. Not JSON-RPC — refresh liveness and
		// answer pong so the CLI can measure round-trips if it wants.
		if (msg.type === "ping") {
			this.markSeen();
			try {
				ws.send(JSON.stringify({ type: "pong" }));
			} catch {
				this.detach(ws);
			}
			return;
		}
		if (msg.method !== undefined && msg.id !== undefined) {
			// Agent→client REQUEST (fs, permissions, terminals) — refuse
			// instead of leaving the agent blocked forever (same -32601
			// contract as the stdio transport).
			try {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: msg.id,
						error: { code: -32601, message: `client does not implement ${msg.method}` },
					}),
				);
			} catch {
				this.detach(ws);
			}
			return;
		}
		if (msg.method !== undefined) {
			// Agent→client notification — buffered until the next RPC
			// response flushes it to the worker side.
			this.notifies.push(msg);
			return;
		}
		if (msg.id !== undefined) {
			const p = this.pending.get(String(msg.id));
			if (p === undefined) return;
			clearTimeout(p.timer);
			this.pending.delete(String(msg.id));
			p.resolve({ kind: "response", response: msg });
		}
	}

	webSocketClose(ws: BridgeSocket, _code: number, _reason: string, _wasClean: boolean): void {
		this.detach(ws);
	}

	webSocketError(ws: BridgeSocket): void {
		this.detach(ws);
	}
}
