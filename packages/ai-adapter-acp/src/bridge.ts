/**
 * bridge.ts — `AcpRpc` over the AcpBridge durable object (F3b).
 *
 * Under workerd there is no stdio: the local `ai-bridge` CLI holds an
 * outbound WebSocket to the DO (`idFromName(endpointId)`) and relays
 * frames to the agent process it spawned locally — the agent command
 * NEVER travels through the server. This transport POSTs each
 * JSON-RPC request to `stub.fetch("/rpc")`; the DO forwards it over
 * the held socket and answers `{response, notifications}` once the
 * agent replies (notifications emitted while the request was in
 * flight are flushed with the response and replayed into the
 * session's sink in order). A dead bridge answers 503
 * `bridge_offline`; a hung one 504 `bridge_timeout`; a notification
 * (no `id`) is fire-and-forget 202.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PortError } from "@ktb/eval-core";
import { fnvHex, type LlmPort } from "@ktb/eval-consultation";

import type { AcpRpc } from "./acp-client.ts";
import { makeAcpSessionLlm } from "./acp-llm.ts";

const fail = (message: string, cause?: unknown) => new PortError({ port: "llm", message, cause });

/** The structural slice of the DurableObjectNamespace the factory
 * needs — the composition root publishes `env.ACP_BRIDGE`; ports
 * never see the binding type itself. */
export interface BridgeStub {
	readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}
export interface BridgeNamespace {
	readonly idFromName: (name: string) => unknown;
	readonly get: (id: unknown) => BridgeStub;
}

interface WireMessage {
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

const causeMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export interface BridgeRpcOptions {
	readonly ns: BridgeNamespace;
	/** DO instance name — the endpoint id as a string (the route
	 * upgrades to `idFromName(endpointId)`). */
	readonly name: string;
	readonly onNotification?: (method: string, params: unknown) => void;
}

/** JSON-RPC transport: one `stub.fetch` per request, responses
 * correlated by the DO. No `dead` latch — every call is independent;
 * offline detection is the DO's job (503 → PortError). */
export const makeBridgeRpc = (opts: BridgeRpcOptions): AcpRpc => {
	const stub = opts.ns.get(opts.ns.idFromName(opts.name));
	// The DO correlates replies by id alone on a socket SHARED by every
	// rpc instance bound to the same endpoint — a per-instance `req-1`
	// counter would collide across concurrent sessions (cross-talk,
	// wrong responses, timeouts). A random per-instance nonce makes
	// ids unique on the shared JSON-RPC channel.
	const nonce = crypto.randomUUID();
	let nextId = 0;
	const post = (wire: unknown) =>
		Effect.tryPromise({
			try: () =>
				stub.fetch("https://acp-bridge.internal/rpc", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(wire),
				}),
			catch: (cause) => fail(`acp bridge: ${causeMessage(cause)}`, cause),
		});
	return {
		request: (method, params) =>
			Effect.gen(function* () {
				const id = `req-${nonce}-${++nextId}`;
				const res = yield* post({
					jsonrpc: "2.0",
					id,
					method,
					...(params !== undefined ? { params } : {}),
				});
				if (!res.ok) {
					// Remote-controlled bodies stay out of the wire-visible
					// message; the DO's own labels are fixed strings.
					const tag = res.status === 503 ? "bridge_offline" : `bridge ${res.status}`;
					return yield* fail(`acp bridge: ${tag}`);
				}
				const body = (yield* Effect.tryPromise({
					try: () => res.json(),
					catch: (cause) => fail(`acp bridge: bad response: ${causeMessage(cause)}`, cause),
				})) as { readonly response?: WireMessage; readonly notifications?: WireMessage[] };
				// Replay the notifications the DO buffered while this
				// request was in flight — the session's chunk accumulator
				// only sees session/update payloads.
				for (const n of body.notifications ?? []) {
					if (n.method !== undefined) opts.onNotification?.(n.method, n.params);
				}
				const response = body.response;
				if (response === undefined || String(response.id) !== id) {
					return yield* fail("acp bridge: response id mismatch");
				}
				if (response.error !== undefined) {
					return yield* fail(`agent error ${response.error.code}: ${response.error.message}`);
				}
				return (response as { readonly result?: unknown }).result;
			}),
		notify: (method, params) => {
			// Fire-and-forget — the DO returns 202 immediately; a dead
			// stub fetch is fine for notifications (the session is
			// already gone). Swallow rejections so nothing unhandles.
			void post({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })
				.pipe(Effect.runPromise)
				.catch(() => {});
		},
	};
};

export interface BridgeAcpLlmOptions {
	readonly ns: BridgeNamespace;
	/** The ai_endpoint row id — DO name AND registry identity. */
	readonly endpointId: number;
	readonly sessionId?: string;
	readonly cwd?: string;
	readonly timeoutMs?: number;
	readonly egress?: boolean;
	readonly engineVersion?: string;
}

/** LlmPort for an acp+ws endpoint whose agent lives behind a bridge
 * CLI: ACP session semantics over the DO-held socket, same
 * generate/correct contract as the spawned-agent driver. */
export const makeBridgeAcpLlm = (opts: BridgeAcpLlmOptions): Layer.Layer<LlmPort> =>
	makeAcpSessionLlm({
		connect: (onNotification) =>
			Effect.succeed(makeBridgeRpc({ ns: opts.ns, name: String(opts.endpointId), onNotification })),
		engine: "acp-bridge",
		...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		...(opts.egress !== undefined ? { egress: opts.egress } : {}),
		engineVersion: opts.engineVersion ?? fnvHex(`bridge:${opts.endpointId}`),
	});
