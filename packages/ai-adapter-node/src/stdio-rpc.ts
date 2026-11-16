/**
 * stdio-rpc.ts — JSON-RPC over a spawned process's stdio. ACP's wire
 * convention (agentclientprotocol.com): every message is ONE line of
 * JSON — requests are written to stdin, responses and notifications
 * arrive on stdout. `Content-Length:`-framed messages (LSP-style) are
 * also accepted since some agents pick that framing over stdio. Ids
 * are client-generated (`req-N`) and correlated against pending calls;
 * agent→client requests are refused with -32601 so a permission/fs-
 * seeking agent never hangs a turn waiting for a reply that cannot
 * come.
 *
 * Node/Bun only — callers gate on `process` before reaching this
 * module; `node:child_process` is imported lazily so the package still
 * loads under workerd (it just can't spawn).
 */

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { PortError } from "@ktb/eval-core";

const causeMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const fail = (message: string, cause?: unknown) => new PortError({ port: "llm", message, cause });

/** The narrow slice of node's ChildProcess the transport needs —
 * satisfied structurally so tests inject fakes via `spawnImpl`. */
export interface SpawnedProcess {
	readonly stdin: {
		readonly write: (chunk: string) => void;
		readonly end?: () => void;
	};
	readonly stdout: {
		readonly on: (event: "data", listener: (chunk: string | Uint8Array) => void) => unknown;
	};
	readonly on: (
		event: "exit" | "error" | "close",
		listener: (...args: readonly unknown[]) => void,
	) => unknown;
	// No signal arg — `ChildProcess.kill` narrows to Signals; a
	// parameter-free view is all the transport needs.
	readonly kill: () => void;
}

export type SpawnImpl = (command: string, args: readonly string[]) => SpawnedProcess;

/** Lazy `node:child_process` — the module import itself never touches
 * platform APIs so the package loads under workerd; only this call
 * does. */
const nodeSpawn: Effect.Effect<SpawnImpl, PortError> = Effect.tryPromise({
	try: async () => {
		const cp = await import("node:child_process");
		return (command, args) =>
			cp.spawn(command, args as string[], { stdio: ["pipe", "pipe", "inherit"] });
	},
	catch: () => fail("acp child/ssh requires a Node/Bun runtime (node:child_process unavailable)"),
});

export interface StdioRpcOptions {
	readonly argv: readonly string[];
	readonly spawnImpl?: SpawnImpl;
	/** Agent→client notifications (method, params) — `session/update`
	 * chunks land here. */
	readonly onNotification?: (method: string, params: unknown) => void;
}

export interface StdioRpc {
	readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, PortError>;
	/** Notifications are best-effort — a closed stdin drops them
	 * silently (the session is already dead). */
	readonly notify: (method: string, params?: unknown) => void;
}

interface WireMessage {
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

/** Spawn `argv` and speak line-framed JSON-RPC. Scoped: releasing the
 * scope kills the child and closes stdin. Once the transport dies
 * (exit, spawn error, corrupt frame) every pending AND future request
 * fails with the same PortError — a half-dead session never produces
 * half-results. */
export const makeStdioRpc = (
	opts: StdioRpcOptions,
): Effect.Effect<StdioRpc, PortError, Scope.Scope> =>
	Effect.gen(function* () {
		const spawn = opts.spawnImpl !== undefined ? opts.spawnImpl : yield* nodeSpawn;
		const command = opts.argv[0];
		if (command === undefined || command === "") {
			return yield* fail("acp transport: empty spawn command");
		}
		const proc = yield* Effect.acquireRelease(
			Effect.try({
				try: () => spawn(command, opts.argv.slice(1)),
				catch: (cause) => fail(`acp transport: spawn ${command} failed: ${causeMessage(cause)}`),
			}),
			(p) =>
				Effect.sync(() => {
					p.kill();
					p.stdin.end?.();
				}),
		);

		const write = (msg: unknown) => {
			proc.stdin.write(`${JSON.stringify(msg)}\n`);
		};

		let dead: PortError | null = null;
		const pending = new Map<string, (outcome: Effect.Effect<unknown, PortError>) => void>();
		let nextId = 0;
		const failAll = (err: PortError) => {
			if (dead === null) dead = err;
			const resumes = [...pending.values()];
			pending.clear();
			for (const resume of resumes) resume(Effect.fail(err));
		};

		// Raw-byte buffer: Content-Length counts BYTES, so decoding
		// before framing would mis-slice multibyte payloads.
		let buf = new Uint8Array(0);
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const CRLF = encoder.encode("\r\n\r\n");
		const LF_LF = encoder.encode("\n\n");
		const CL_PREFIX = encoder.encode("Content-Length:");
		const indexOfSeq = (seq: Uint8Array, from = 0) => {
			outer: for (let i = from; i + seq.length <= buf.length; i++) {
				for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
				return i;
			}
			return -1;
		};
		/** Extract the next complete frame (raw JSON bytes) or null when
		 * the buffer holds only a partial one. `null` on corrupt framing
		 * is never legal mid-stream — the caller fails the session. */
		const takeFrame = (): Uint8Array | null => {
			if (indexOfSeq(CL_PREFIX) === 0) {
				let sep = indexOfSeq(CRLF);
				let headerEnd = sep + CRLF.length;
				if (sep === -1) {
					sep = indexOfSeq(LF_LF);
					headerEnd = sep + LF_LF.length;
				}
				if (sep === -1) return null;
				const len = Number(
					/Content-Length:\s*(\d+)/i.exec(decoder.decode(buf.subarray(0, sep)))?.[1],
				);
				if (!Number.isFinite(len)) {
					// Corrupt header — drop it and surface a non-JSON frame
					// so the caller fails the session as malformed framing.
					buf = buf.subarray(headerEnd);
					return encoder.encode("<corrupt header>");
				}
				if (buf.length - headerEnd < len) return null;
				const frame = buf.subarray(headerEnd, headerEnd + len);
				buf = buf.subarray(headerEnd + len);
				return frame;
			}
			const nl = buf.indexOf(0x0a);
			if (nl === -1) return null;
			const frame = buf.subarray(0, nl);
			buf = buf.subarray(nl + 1);
			return frame;
		};
		proc.stdout.on("data", (chunk) => {
			const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
			const next = new Uint8Array(buf.length + bytes.length);
			next.set(buf);
			next.set(bytes, buf.length);
			buf = next;
			for (let frame = takeFrame(); frame !== null; frame = takeFrame()) {
				const line = decoder.decode(frame);
				if (line.trim() === "") continue;
				let msg: WireMessage;
				try {
					msg = JSON.parse(line) as WireMessage;
				} catch {
					// A non-JSON line on stdout corrupts framing — there is
					// no way to know where the next message starts; kill the
					// session rather than guess.
					failAll(fail("acp transport: invalid json-rpc frame"));
					return;
				}
				if (msg.method !== undefined && msg.id !== undefined) {
					// Agent→client REQUEST (fs, permissions, terminals) —
					// refuse instead of leaving the agent blocked forever.
					write({
						jsonrpc: "2.0",
						id: msg.id,
						error: { code: -32601, message: `client does not implement ${msg.method}` },
					});
				} else if (msg.method !== undefined) {
					opts.onNotification?.(msg.method, msg.params);
				} else if (msg.id !== undefined) {
					const resume = pending.get(String(msg.id));
					// A response for an unknown id is late (post-timeout)
					// or bogus — either way nothing waits on it.
					if (resume === undefined) continue;
					pending.delete(String(msg.id));
					resume(
						msg.error !== undefined
							? Effect.fail(fail(`agent error ${msg.error.code}: ${msg.error.message}`))
							: Effect.succeed(msg.result),
					);
				}
			}
		});
		proc.on("exit", (code) => {
			failAll(fail(`acp agent exited (code ${code ?? "unknown"})`));
		});
		proc.on("error", (err) => {
			failAll(fail(`acp agent error: ${causeMessage(err)}`));
		});

		return {
			request: (method, params) =>
				Effect.callback<unknown, PortError>((resume) => {
					if (dead !== null) {
						resume(Effect.fail(dead));
						return undefined;
					}
					const id = `req-${++nextId}`;
					pending.set(id, resume);
					try {
						write({
							jsonrpc: "2.0",
							id,
							method,
							...(params !== undefined ? { params } : {}),
						});
					} catch (cause) {
						pending.delete(id);
						resume(
							Effect.fail(fail(`acp transport: stdin write failed: ${causeMessage(cause)}`, cause)),
						);
						return undefined;
					}
					// Interruption (timeout, scope teardown) drops the
					// pending entry so a late response is ignored.
					return Effect.sync(() => {
						pending.delete(id);
					});
				}),
			notify: (method, params) => {
				try {
					write({
						jsonrpc: "2.0",
						method,
						...(params !== undefined ? { params } : {}),
					});
				} catch {
					// Best-effort — a dead stdin is fine for notifications.
				}
			},
		};
	});
