import { index, integer, sqliteTable, text } from "../../../packages/db/src/table.ts";

/**
 * `ai_endpoint` — a generative provider any AI-capable plugin can
 * pick: `acp` JSON-RPC agents or `openai` chat-completions endpoints
 * (Ollama/LM Studio/GPT/Gemini-compat). `secret_ref` stores either the
 * NAME of an env var holding the API key or a `credential:<id>` ref
 * into the credentials store — raw keys never live in tables.
 * Promoted from `eval_llm_endpoint` (F1): `scope` names the consuming
 * surface ("eval" for the lab pickers) and `is_default` marks the
 * endpoint `resolveDefault` hands to callers that don't name one.
 */
export const aiEndpoint = sqliteTable(
	"ai_endpoint",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		name: text().notNull(),
		/** acp | openai */
		kind: text().notNull(),
		/** Nullable since F3b: acp+ws bridge endpoints connect through the
		 * AcpBridge durable object instead of dialing a URL — the local
		 * `ai-bridge` CLI owns the agent process. */
		baseUrl: text("base_url"),
		/** Chat model id (openai kind); unused for acp. */
		model: text(),
		sessionId: text("session_id"),
		/** Env var NAME or `credential:<id>` — never the key itself. */
		secretRef: text("secret_ref"),
		/** ACP transport: ws (HTTP, default) | child | ssh — non-ws
		 * transports need a Node-runtime driver. */
		transport: text(),
		/** Agent command for child/ssh ACP transports — e.g.
		 * "claude-agent-acp". Spawned by @ktb/ai-adapter-node. */
		agentCmd: text("agent_cmd"),
		/** SSH target (user@host) for the ssh transport — agentCmd runs
		 * on that host. */
		sshHost: text("ssh_host"),
		/** Consuming surface — e.g. "eval" for the lab's pickers. */
		scope: text().notNull().default("eval"),
		/** Preferred endpoint for callers that don't name one. */
		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		timeoutMs: integer("timeout_ms").notNull().default(60_000),
		enabled: integer({ mode: "boolean" }).notNull().default(true),
		/** Last time a bridge CLI held a live socket for this endpoint
		 * (connect + heartbeat) — drives the bridge status badge. Null when
		 * no bridge has ever connected. */
		lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("ai_endpoint_enabled_idx").on(table.enabled)],
);
export type AiEndpoint = typeof aiEndpoint.$inferSelect;

/**
 * `ai_agent_link` — bearer connect links for the ACP bridge (F3b).
 * `createBridgeLinkFn` mints a 128-bit token, stores only its SHA-256
 * (raw token shown once, never persisted) and hands the admin the
 * `ai-bridge connect` command. `GET /api/ai/bridge?token=` upgrades to
 * the endpoint's AcpBridge durable object — the token is a session
 * bearer valid for upgrades until `expires_at` (~15min) or
 * `revoked_at`, so the CLI can reconnect after a socket drop.
 * `used_at` stamps the FIRST upgrade for audit (Agents page "Used"
 * column + status flip) — it does NOT gate reconnects. The agent
 * command itself is NEVER stored or sent by the server — it is a local
 * `--cmd` flag on the CLI. `revoked_at` (F4) marks a link the admin
 * pulled from the Agents page — the row stays for audit, the token
 * dies for future upgrades.
 */
export const aiAgentLink = sqliteTable(
	"ai_agent_link",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		endpointId: integer("endpoint_id")
			.notNull()
			.references(() => aiEndpoint.id, { onDelete: "cascade" }),
		/** SHA-256 hex of the raw token — lookup key; the token itself
		 * is never stored. */
		tokenHash: text("token_hash").notNull().unique(),
		/** User id of the admin who minted the link. */
		createdBy: text("created_by").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		usedAt: integer("used_at", { mode: "timestamp_ms" }),
		/** Admin revocation (F4) — the bridge route refuses the token and
		 * the Agents page shows `revoked`; nullable keeps the audit row. */
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("ai_agent_link_endpoint_idx").on(table.endpointId)],
);
export type AiAgentLink = typeof aiAgentLink.$inferSelect;
