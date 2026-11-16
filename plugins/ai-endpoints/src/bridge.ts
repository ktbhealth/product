/**
 * bridge.ts — `GET /api/ai/bridge` handler (F3b): the machine-token
 * handoff the local `ai-bridge` CLI connects to. NOT session-auth —
 * the credential is the one-shot `?token=` minted by
 * `createBridgeLinkFn` (SHA-256 lookup against `ai_agent_link`;
 * the raw token is never stored server-side).
 *
 * Contract:
 *   missing/empty token            → 400
 *   no `Upgrade: websocket`        → 400 (the route only exists to
 *                                    hand off a socket)
 *   unknown token                  → 401
 *   already-used token             → 409
 *   expired token                  → 410
 *   endpoint missing/disabled      → 403
 *   ACP_BRIDGE binding absent      → 501 (Node dev has no DOs)
 *   valid                          → consume the link (`used_at`),
 *                                    forward the upgrade request to
 *                                    `idFromName(endpointId)`'s
 *                                    AcpBridge stub via the
 *                                    ServerRuntime.acpBridge
 *                                    capability.
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
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return json("expected websocket upgrade", 400);
	}
	const runtime = getServerRuntime();
	const bridge = runtime.acpBridge;
	if (bridge === undefined) return json("bridge unavailable", 501);

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
	if (link.usedAt !== null) return json("token already used", 409);
	if (link.expiresAt.getTime() <= now.getTime()) return json("token expired", 410);

	const endpoint = await runtime.run(
		Effect.gen(function* () {
			const db = yield* Db;
			return (yield* Effect.promise(() =>
				db.select().from(aiEndpoint).where(eq(aiEndpoint.id, link.endpointId)),
			))[0];
		}),
	);
	if (endpoint === undefined || !endpoint.enabled) return json("endpoint unavailable", 403);

	// Consume the link BEFORE the handoff — a replayed upgrade can
	// never pass validation twice.
	await runtime.run(
		Effect.gen(function* () {
			const db = yield* Db;
			yield* Effect.promise(() =>
				db.update(aiAgentLink).set({ usedAt: now }).where(eq(aiAgentLink.id, link.id)),
			);
		}),
	);
	return bridge(endpoint.id, request);
};
