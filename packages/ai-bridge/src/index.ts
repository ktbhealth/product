/**
 * @ktb/ai-bridge — the ACP bridge (F3b).
 *
 *   do.ts  — `AcpBridge` Durable Object: holds the bridge's outbound
 *            WebSocket per ai_endpoint, forwards JSON-RPC frames,
 *            heartbeats last_seen_at. Worker-side; all types are
 *            structural so tests mock state/sockets/env.
 *   cli.ts — `ai-bridge connect <url> --cmd "…"`: the user-side dumb
 *            byte pipe (WebSocket ↔ agent stdio). SECURITY INVARIANT:
 *            the agent command never comes from the server — `--cmd`
 *            is a local flag; the server only sends frames.
 */

export { AcpBridge } from "./do.ts";
export type { AcpBridgeEnv, BridgeDoState, BridgeSocket } from "./do.ts";
export { connect, main, parseArgs } from "./cli.ts";
export type {
	BridgeDeps,
	BridgeProcess,
	BridgeWebSocket,
	ConnectOptions,
	SpawnBridge,
	WebSocketImpl,
} from "./cli.ts";
