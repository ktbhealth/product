/**
 * bridge.ts — `GET /api/ai/bridge` handler (F3b): the machine-token
 * handoff the local `ai-bridge` CLI connects to. NOT session-auth —
 * the credential is the `?token=` minted by `createBridgeLinkFn`
 * (SHA-256 lookup against `ai_agent_link`; the raw token is never
 * stored server-side).
 *
 * Contract:
 *   missing/empty token            → 400
 *   unknown token                  → 401
 *   revoked token                  → 403 (F4: admin pulled the link —
 *                                    the row stays for audit)
 *   expired token                  → 410
 *   no `Upgrade: websocket`        → 400 while the link is unused,
 *                                    409 once used (the route only
 *                                    exists to hand off a socket — a
 *                                    plain HTTP replay on a consumed
 *                                    link reports link state)
 *   ACP_BRIDGE binding absent      → 501 (Node dev has no DOs)
 *   endpoint missing/disabled      → 403
 *   valid upgrade                  → forward the upgrade request to
 *                                    `idFromName(endpointId)`'s
 *                                    AcpBridge stub via the
 *                                    ServerRuntime.acpBridge
 *                                    capability.
 *
 * SESSION MODEL: the link token is a bearer credential for the bridge
 * session, NOT a one-shot. `used_at` records the first upgrade for
 * audit only — upgrades stay allowed until `expires_at`/`revoked_at`
 * so the CLI's reconnect-on-drop actually works. There is no
 * anti-replay concern for non-upgrade HTTP: the only thing a token
 * buys is a WebSocket to the endpoint's DO, and `expires_at` bounds
 * the window.
 *
 * SECURITY INVARIANT: the agent command never comes from the server
 * — this route (and the DO behind it) only ever forwards frames;
 * `--cmd` is a local flag on the CLI.
 */

import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";

import { Db } from "@ktb/db";
import { getServerRuntime } from "@ktb/server-fns";

import { sha256Hex } from "./bridge-token.ts";
import { aiAgentLink, aiEndpoint } from "./schema.ts";

const json = (error: string, status: number): Response => Response.json({ error }, { status });

export const handleBridgeUpgrade = async (request: Request): Promise<Response> => {
	const token = new URL(request.url).searchParams.get("token");
	if (token === null || token === "") return json("missing token", 400);
	const runtime = getServerRuntime();

	const tokenHash = await sha256Hex(token);
	const link = await runtime.run(
		Effect.gen(function* () {
			const db = yield* Db;
			return (yield* Effect.promise(() =>
				db.select().from(aiAgentLink).where(eq(aiAgentLink.tokenHash, tokenHash)),
			))[0];
		}),
	);
	if (link === undefined) return json("invalid token", 401);
	const now = new Date();
	if (link.revokedAt !== null) return json("token revoked", 403);
	if (link.expiresAt.getTime() <= now.getTime()) return json("token expired", 410);

	// The route only exists to hand off a socket. A non-upgrade request
	// on an unused link is malformed (400); on a used link it's a
	// replayed URL — 409 reports "already consumed" without upgrading.
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return link.usedAt === null
			? json("expected websocket upgrade", 400)
			: json("token already used", 409);
	}

	const bridge = runtime.acpBridge;
	if (bridge === undefined) return json("bridge unavailable", 501);

	const endpoint = await runtime.run(
		Effect.gen(function* () {
			const db = yield* Db;
			return (yield* Effect.promise(() =>
				db.select().from(aiEndpoint).where(eq(aiEndpoint.id, link.endpointId)),
			))[0];
		}),
	);
	if (endpoint === undefined || !endpoint.enabled) return json("endpoint unavailable", 403);

	// First upgrade stamps used_at for audit (the "Used" column on the
	// Agents page + the waiting→connected status flip). Reconnects skip
	// the write — the token stays a valid bearer until expiry/revocation.
	if (link.usedAt === null) {
		await runtime.run(
			Effect.gen(function* () {
				const db = yield* Db;
				yield* Effect.promise(() =>
					db.update(aiAgentLink).set({ usedAt: now }).where(eq(aiAgentLink.id, link.id)),
				);
			}),
		);
	}
	return bridge(endpoint.id, request);
};
