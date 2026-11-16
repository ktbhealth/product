import { createPluginApiRoute } from "@ktb/server-fns";

import { handleBridgeUpgrade } from "../bridge.ts";

/**
 * GET /api/ai/bridge — the local ai-bridge CLI's WebSocket upgrade
 * handoff (F3b). Machine-token auth only (one-shot `?token=`); the
 * session gate does NOT apply — the handler validates the link row
 * itself and forwards to the endpoint's AcpBridge durable object.
 * Lives under the shared "/api" mount via `ai-endpoints.routes`.
 */
export const Route = createPluginApiRoute("ai-endpoints.routes")("/api/ai/bridge")({
	server: {
		handlers: {
			GET: async ({ request }: { readonly request: Request }) => handleBridgeUpgrade(request),
		},
	},
});
