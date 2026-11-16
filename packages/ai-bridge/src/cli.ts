#!/usr/bin/env bun
/**
 * cli.ts — `ai-bridge`: the user-side half of the ACP bridge (F3b).
 *
 *   ai-bridge connect <url> --cmd "<agent command>" [--once] [--retries N]
 *
 * DUMB BYTE PIPE: relays JSON-RPC frames between the platform's held
 * WebSocket (outbound wss to POST /api/ai/bridge?token=…, upgraded by
 * the AcpBridge durable object) and the child process's stdio. ACP
 * semantics live entirely on the server side — this file knows only
 * frames.
 *
 * SECURITY INVARIANT: the agent command NEVER comes from the server.
 * `--cmd` is a local flag; the server sends only frames. The one-shot
 * token rides inside <url> (`?token=…`) — minted by the endpoint UI,
 * never stored server-side.
 *
 * Node/Bun only. WebSocket is the runtime global (Bun, Node ≥22); the
 * child spawns through `sh -c` so quoting in --cmd works. Reconnects
 * with exponential backoff on socket drop (the agent process stays up
 * — the wire, not the agent, is what died); `--once` disables it.
 * stdout framing is the shared ACP convention (line-delimited or
 * Content-Length) from @ktb/ai-adapter-acp.
 */

import { makeFrameExtractor, decodeFrame } from "@ktb/ai-adapter-acp";

const HEARTBEAT_MS = 30_000;
const MAX_BACKOFF_MS = 10_000;
const DEFAULT_RETRIES = 5;
const OPEN = 1;

/** The WebSocket slice the relay needs — the runtime global satisfies
 * it; tests inject a fake through `deps.ws`. */
export interface BridgeWebSocket {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
}
export type WebSocketImpl = new (url: string) => BridgeWebSocket;

/** The stdio slice of the spawned agent — same structural contract as
 * @ktb/ai-adapter-node's SpawnedProcess. */
export interface BridgeProcess {
	readonly stdin: {
		readonly write: (chunk: string) => void;
		readonly end?: () => void;
	};
	readonly stdout: {
		readonly on: (event: "data", listener: (chunk: string | Uint8Array) => void) => void;
	};
	readonly on: (
		event: "exit" | "error" | "close",
		listener: (...args: readonly unknown[]) => void,
	) => void;
	readonly kill: () => void;
}
export type SpawnBridge = (cmd: string) => BridgeProcess;

export interface BridgeDeps {
	readonly ws?: WebSocketImpl;
	readonly spawn?: SpawnBridge;
	readonly heartbeatMs?: number;
	readonly backoffMs?: (attempt: number) => number;
	readonly log?: (line: string) => void;
}

export interface ConnectOptions {
	readonly url: string;
	readonly cmd: string;
	readonly once?: boolean;
	readonly retries?: number;
}

const log = (deps: BridgeDeps, line: string) => (deps.log ?? console.error)(`[ai-bridge] ${line}`);

const decodeData = (data: unknown): string | null => {
	if (typeof data === "string") return data;
	if (data instanceof Uint8Array) return new TextDecoder().decode(data);
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	return null;
};

/**
 * Connect the bridge. Resolves to the process exit code — drops,
 * agent death and give-ups are all non-zero; a clean socket close
 * under `--once` is the only 0.
 */
export const connect = async (opts: ConnectOptions, deps: BridgeDeps = {}): Promise<number> => {
	let spawn = deps.spawn;
	if (spawn === undefined) {
		const { spawn: cpSpawn } = await import("node:child_process");
		spawn = (cmd: string) =>
			cpSpawn("sh", ["-c", cmd], {
				stdio: ["pipe", "pipe", "inherit"],
			}) as unknown as BridgeProcess;
	}
	const proc = spawn(opts.cmd);

	// Agent lifecycle — the process stays up across reconnects; only
	// its death (or ours) ends the bridge.
	let dead = false;
	const deadWaiters: (() => void)[] = [];
	const markDead = () => {
		dead = true;
		for (const w of deadWaiters.splice(0)) w();
	};
	proc.on("exit", markDead);
	proc.on("error", markDead);

	// Agent output → the CURRENT socket, registered once (reconnects
	// swap `ws`, not the listener). Wire frames pass through untouched.
	let ws: BridgeWebSocket | null = null;
	const frames = makeFrameExtractor();
	proc.stdout.on("data", (chunk) => {
		frames.push(chunk);
		for (let f = frames.next(); f !== null; f = frames.next()) {
			const line = decodeFrame(f);
			const socket = ws;
			if (line.trim() === "" || socket === null || socket.readyState !== OPEN) continue;
			try {
				socket.send(line);
			} catch {
				// send() throwing means the socket is gone — the close
				// event follows and drives the reconnect.
			}
		}
	});

	/** One attach attempt; resolves when the socket drops or the agent
	 * dies mid-attach. */
	const attempt = (): Promise<"closed" | "spawn_dead"> =>
		new Promise((resolve) => {
			const WS = deps.ws ?? (globalThis.WebSocket as unknown as WebSocketImpl);
			const socket = new WS(opts.url);
			let settled = false;
			const onDead = () => done("spawn_dead");
			const done = (why: "closed" | "spawn_dead") => {
				if (settled) return;
				settled = true;
				clearInterval(ping);
				const i = deadWaiters.indexOf(onDead);
				if (i !== -1) deadWaiters.splice(i, 1);
				/* v8 ignore next -- else arm unreachable: done() settles once per
				   attempt and the loop can't attach a newer socket while
				   attempt() is still in flight */
				if (ws === socket) ws = null;
				try {
					socket.close();
				} catch {
					// already closing
				}
				resolve(why);
			};
			deadWaiters.push(onDead);
			// Heartbeat control frame — the DO stamps last_seen_at off
			// it; it never reaches the agent (the DO answers pong itself).
			const ping = setInterval(() => {
				if (socket.readyState !== OPEN) return;
				try {
					socket.send(JSON.stringify({ type: "ping" }));
				} catch {
					done("closed");
				}
			}, deps.heartbeatMs ?? HEARTBEAT_MS);
			ws = socket;
			socket.onopen = () => log(deps, `connected ${opts.url}`);
			socket.onmessage = (event) => {
				const text = decodeData(event.data);
				if (text === null) return;
				// Socket → agent stdin: line-delimited JSON-RPC (the ACP
				// stdio convention — the shared framing accepts
				// Content-Length on the way back if the agent prefers it).
				try {
					proc.stdin.write(`${text}\n`);
				} catch {
					done("spawn_dead");
				}
			};
			socket.onclose = () => done("closed");
			socket.onerror = () => done("closed");
		});

	let tries = 0;
	const retries = opts.retries ?? DEFAULT_RETRIES;
	while (true) {
		if (dead) {
			log(deps, "agent process exited — stopping");
			return 1;
		}
		const why = await attempt();
		if (why === "spawn_dead" || dead) {
			log(deps, "agent process exited — stopping");
			return 1;
		}
		if (opts.once === true) {
			log(deps, "socket closed (--once)");
			return 1;
		}
		tries += 1;
		if (tries > retries) {
			log(deps, `giving up after ${retries} retries`);
			return 1;
		}
		const wait = (deps.backoffMs ?? ((n) => Math.min(2 ** n * 500, MAX_BACKOFF_MS)))(tries);
		log(deps, `socket dropped — reconnecting in ${wait}ms (attempt ${tries}/${retries})`);
		await new Promise((r) => setTimeout(r, wait));
	}
};

interface ParsedArgs {
	readonly url: string;
	readonly cmd: string;
	readonly once: boolean;
	readonly retries?: number;
}

const USAGE =
	'usage: ai-bridge connect <url> --cmd "<agent command>" [--once] [--retries N]\n' +
	"  the agent command is LOCAL — the server only ever sends frames.";

export const parseArgs = (argv: readonly string[]): ParsedArgs | null => {
	const [sub, ...rest] = argv;
	if (sub !== "connect") return null;
	let url: string | undefined;
	let cmd: string | undefined;
	let once = false;
	let retries: number | undefined;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--cmd") {
			cmd = rest[++i];
		} else if (a === "--once") {
			once = true;
		} else if (a === "--retries") {
			const n = Number(rest[++i]);
			if (Number.isInteger(n) && n >= 0) {
				retries = n;
			} else {
				return null;
			}
		} else if (!a.startsWith("-") && url === undefined) {
			url = a;
		} else {
			return null;
		}
	}
	if (url === undefined || cmd === undefined || cmd.trim() === "") return null;
	return { url, cmd, once, ...(retries !== undefined ? { retries } : {}) };
};

export const main = async (argv: readonly string[]): Promise<number> => {
	const parsed = parseArgs(argv);
	if (parsed === null) {
		console.error(USAGE);
		return 2;
	}
	return connect(parsed);
};

// Entry gate: `bunx @ktb/ai-bridge` / `bun src/cli.ts` — under vitest
// the module is imported, not run (import.meta.main is Bun's marker).
/* v8 ignore next 4 -- process entry point; unit tests import, never exec */
if (import.meta.main === true) {
	process.exit(await main(process.argv.slice(2)));
}
