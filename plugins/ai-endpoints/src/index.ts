import { physical } from "@tanstack/virtual-file-routes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { BotIcon, PlugZapIcon } from "lucide-react";

import { type Forbidden } from "@ktb/authz";
import { Credentials } from "@ktb/credentials";
import { Db, tx } from "@ktb/db";
import {
	LlmFactory,
	PlatformLlm,
	type LlmEndpointDescriptor,
	type LlmEndpointPreset,
} from "@ktb/eval-consultation";
// EVAL_ACTION/EVAL_RESOURCE are compile-time permission-string
// constants, not services — no dep edge on eval-validator: the rbac
// check degrades on its own when that plugin is absent.
import { EVAL_ACTION, EVAL_RESOURCE } from "@ktb/eval-validator";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";
import { Secrets } from "@ktb/vault";

import { mintBridgeToken, sha256Hex } from "./bridge-token.ts";
import { AgentsPanelPage, EndpointsPanelPage } from "./platform-page.tsx";
import { aiAgentLink, aiEndpoint, type AiAgentLink, type AiEndpoint } from "./schema.ts";

// ---------------------------------------------------------------------------
// DTOs — what the panel page and fns exchange (plain JSON on the wire).
// ---------------------------------------------------------------------------

export interface EndpointCard {
	readonly id: number;
	readonly name: string;
	readonly kind: string;
	readonly baseUrl: string;
	readonly model: string | null;
	readonly sessionId: string | null;
	readonly secretRef: string | null;
	readonly transport: string | null;
	readonly agentCmd: string | null;
	readonly sshHost: string | null;
	readonly scope: string;
	readonly isDefault: boolean;
	readonly timeoutMs: number;
	readonly enabled: boolean;
	/** Last bridge connect/heartbeat (F3b) — null when no bridge CLI
	 * has ever held a socket for this endpoint. */
	readonly lastSeenAt: Date | null;
	readonly createdAt: Date;
}

/** One-shot link the fn mints for a bridge endpoint — the raw token
 * exists ONLY in the returned command; the table keeps its SHA-256. */
export interface BridgeLink {
	readonly token: string;
	readonly expiresAt: Date;
}

/** Badge state derived from last_seen_at + open links:
 * `connected` = socket seen inside the heartbeat window,
 * `waiting` = an unused unexpired link exists, `offline` otherwise. */
export type BridgeStatus = "connected" | "waiting" | "offline";

/** Per-link lifecycle shown on the Agents page (F4): `revoked` wins
 * (admin pulled it); an unconsumed link is `waiting` until
 * `expires_at` passes (`expired`); a consumed one tracks the
 * endpoint's heartbeat — `connected` inside ~2 ping intervals,
 * `offline` after. */
export type AgentLinkStatus = "waiting" | "connected" | "offline" | "expired" | "revoked";

/** Wire row for the Agents table — joins the link to its endpoint.
 * token_hash NEVER leaves the server (only the hash exists anyway —
 * the raw token was shown once at mint). */
export interface AgentLinkRow {
	readonly id: number;
	readonly endpointId: number;
	readonly endpointName: string;
	readonly status: AgentLinkStatus;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly usedAt: Date | null;
	readonly lastSeenAt: Date | null;
}

export const agentLinkStatus = (
	link: Pick<AiAgentLink, "usedAt" | "expiresAt" | "revokedAt">,
	lastSeenAt: Date | null,
	now: number,
): AgentLinkStatus => {
	if (link.revokedAt !== null) return "revoked";
	if (link.usedAt === null) return link.expiresAt.getTime() <= now ? "expired" : "waiting";
	return lastSeenAt !== null && now - lastSeenAt.getTime() <= BRIDGE_LIVE_MS
		? "connected"
		: "offline";
};

/** Bridge liveness window: ~2 heartbeat intervals (the CLI pings
 * every 30s). */
export const BRIDGE_LIVE_MS = 90_000;

/** One-shot link lifetime — long enough to paste a command, short
 * enough that a leaked link is useless. */
export const BRIDGE_LINK_TTL_MS = 15 * 60_000;

/** Is this row an acp+ws bridge endpoint? `base_url` NULL is the
 * sentinel — the agent lives behind a local ai-bridge CLI. */
export const isBridgeEndpoint = (row: {
	readonly kind: string;
	readonly baseUrl: string | null;
	readonly transport: string | null;
}): boolean => row.kind === "acp" && (row.transport ?? "ws") === "ws" && row.baseUrl === null;

export interface EndpointInput {
	readonly name: string;
	readonly kind: string;
	readonly baseUrl: string;
	readonly model?: string;
	readonly sessionId?: string;
	readonly secretRef?: string;
	/** ACP transport — 'ws' | 'child' | 'ssh' (null/absent = 'ws'). */
	readonly transport?: string;
	/** Agent command for child/ssh transports (e.g. "claude-agent-acp"). */
	readonly agentCmd?: string;
	/** SSH target (user@host) for the ssh transport. */
	readonly sshHost?: string;
	/** Consuming surface the endpoint belongs to (default "eval"). */
	readonly scope?: string;
	readonly isDefault?: boolean;
	readonly timeoutMs?: number;
	readonly enabled?: boolean;
}

const toEndpointCard = (row: AiEndpoint): EndpointCard => ({
	id: row.id,
	name: row.name,
	kind: row.kind,
	// The column went nullable in F3b (bridge endpoints have no URL) —
	// the DTO keeps a string; "" is the bridge sentinel end to end.
	baseUrl: row.baseUrl ?? "",
	model: row.model,
	sessionId: row.sessionId,
	secretRef: row.secretRef,
	transport: row.transport,
	agentCmd: row.agentCmd,
	sshHost: row.sshHost,
	scope: row.scope,
	isDefault: row.isDefault,
	timeoutMs: row.timeoutMs,
	enabled: row.enabled,
	lastSeenAt: row.lastSeenAt,
	createdAt: row.createdAt,
});

const requireGrant = Effect.fn("AiEndpoints.gate")(function* () {
	const permissions = yield* Permissions;
	yield* permissions.requirePermission(EVAL_RESOURCE, EVAL_ACTION);
});

/** `secretRef` is an env var NAME, `credential:<id>` (legacy eval
 * credentials — resolved through the credentials store) or
 * `vault:<id>` (P-098 — THE secret store). Resolved secrets are
 * injected into the descriptor as `apiKey` and never leave the
 * server; env names pass through for adapter-side lookup. */
const descriptorOf = (row: AiEndpoint): Effect.Effect<LlmEndpointDescriptor, never, unknown> =>
	Effect.gen(function* () {
		const transport = row.transport;
		const base: LlmEndpointDescriptor = {
			kind: row.kind === "acp" ? "acp" : "openai",
			baseUrl: row.baseUrl ?? "",
			// DO name for acp+ws bridge endpoints (F3b) — the factory
			// resolves idFromName(endpointId).
			endpointId: row.id,
			...(row.model !== null ? { model: row.model } : {}),
			...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
			...(row.kind === "acp" && (transport === "child" || transport === "ssh" || transport === "ws")
				? { transport }
				: {}),
			...(row.kind === "acp" && row.agentCmd !== null ? { agentCmd: row.agentCmd } : {}),
			...(row.kind === "acp" && row.sshHost !== null ? { sshHost: row.sshHost } : {}),
			timeoutMs: row.timeoutMs,
		};
		const ref = row.secretRef;
		if (ref !== null && ref.startsWith("vault:")) {
			const secrets = yield* Effect.serviceOption(Secrets);
			/* v8 ignore next -- soft dep: vault plugin absent */
			if (Option.isNone(secrets)) return base;
			const secret = yield* secrets.value
				.resolve(ref)
				.pipe(Effect.catch(() => Effect.succeed(null)));
			/* v8 ignore next -- deleted/disabled secret leaves the endpoint without a key */
			if (secret === null) return base;
			return { ...base, apiKey: secret };
		}
		if (ref === null || !ref.startsWith("credential:"))
			return { ...base, ...(ref !== null ? { secretRef: ref } : {}) };
		const creds = yield* Effect.serviceOption(Credentials);
		/* v8 ignore next -- soft dep: credentials plugin absent */
		if (Option.isNone(creds)) return base;
		const secret = yield* creds.value.resolve(ref).pipe(
			/* v8 ignore next -- callers gate first; a flipped grant is the only typed failure */
			Effect.catch(() => Effect.succeed(null)),
		);
		/* v8 ignore next -- deleted credential leaves the endpoint without a key */
		if (secret === null) return base;
		return { ...base, apiKey: secret };
	});

// ---------------------------------------------------------------------------
// AiEndpoints — CRUD of generative providers + liveness test + the
// descriptor resolution every AI consumer goes through.
// ---------------------------------------------------------------------------

export class AiEndpoints extends Context.Service<
	AiEndpoints,
	{
		readonly list: (scope?: string) => Effect.Effect<readonly EndpointCard[], Forbidden, unknown>;
		readonly get: (id: number) => Effect.Effect<EndpointCard | null, Forbidden, unknown>;
		readonly create: (
			input: EndpointInput,
		) => Effect.Effect<{ readonly id: number }, Forbidden, unknown>;
		readonly update: (
			input: EndpointInput & { readonly id: number },
		) => Effect.Effect<void, Forbidden, unknown>;
		readonly remove: (id: number) => Effect.Effect<void, Forbidden, unknown>;
		/** Promote an endpoint to THE platform default — sets
		 * `scope='platform'` + `is_default` and clears the previous
		 * platform default in the same batch (one default per scope). */
		readonly setPlatformDefault: (id: number) => Effect.Effect<void, Forbidden, unknown>;
		/** Provider starter endpoints for the form's preset chips —
		 * declared by the bound LlmFactory (provider URLs live in the
		 * adapter edge, never in this package). */
		readonly presets: () => Effect.Effect<readonly LlmEndpointPreset[], Forbidden, unknown>;
		/** Liveness ping through LlmFactory — fails PortError when the
		 * endpoint can't produce a generation inside the test budget.
		 * Disabled endpoints can still be tested (before flipping them
		 * on); unknown ids are a no-op. */
		readonly test: (
			id: number,
		) => Effect.Effect<
			void,
			Forbidden | { readonly _tag: string; readonly message: string },
			unknown
		>;
		/** Row → LlmEndpointDescriptor with secrets injected — null
		 * when the endpoint is unknown or disabled. This is THE
		 * resolution path consumers use; they never read the table. */
		readonly resolve: (
			id: number,
		) => Effect.Effect<LlmEndpointDescriptor | null, Forbidden, unknown>;
		/** The `is_default` enabled endpoint (optionally within a
		 * scope), else the newest enabled one; null when none exist. */
		readonly resolveDefault: (
			scope?: string,
		) => Effect.Effect<LlmEndpointDescriptor | null, Forbidden, unknown>;
		/** Mint a bridge link (F3b): stores only the SHA-256 of
		 * the raw token; the fn composes the `ai-bridge connect`
		 * command with the request origin. Null for unknown/disabled/
		 * non-bridge endpoints. SECURITY INVARIANT: the agent command
		 * never comes from the server — the returned command only
		 * carries the token; `--cmd` is a local CLI flag. */
		readonly createBridgeLink: (
			endpointId: number,
			createdBy: string,
		) => Effect.Effect<BridgeLink | null, Forbidden, unknown>;
		/** Bridge status for the row badge — null for unknown/disabled/
		 * non-bridge endpoints. */
		readonly bridgeStatus: (
			endpointId: number,
		) => Effect.Effect<
			{ readonly status: BridgeStatus; readonly lastSeenAt: Date | null } | null,
			Forbidden,
			unknown
		>;
		/** All bridge links joined to their endpoint — the Agents page's
		 * consolidated view (F4). The wire never carries token_hash. */
		readonly listAgentLinks: () => Effect.Effect<readonly AgentLinkRow[], Forbidden, unknown>;
		/** Revoke a link: stamps `revoked_at` and keeps the audit row.
		 * Returns false for unknown or already-revoked ids. V1 NOTE: a
		 * live socket minted from this link is NOT severed — AcpBridge
		 * binds sockets per-endpoint (idFromName(endpointId)), not
		 * per-link, so there is no link→socket handle to drop without a
		 * new DO contract; revocation blocks FUTURE token use in
		 * /api/ai/bridge and flips the status badge. */
		readonly revokeAgentLink: (id: number) => Effect.Effect<boolean, Forbidden, unknown>;
	}
>()("@ktb/ai-endpoints/AiEndpoints") {}

export const AiEndpointsLive = Layer.effect(
	AiEndpoints,
	Effect.gen(function* () {
		const db = yield* Db;
		const factory = yield* Effect.serviceOption(LlmFactory);
		const values = (input: EndpointInput) => ({
			name: input.name,
			kind: input.kind,
			// "" is the bridge sentinel (acp+ws via the AcpBridge DO) —
			// stored NULL so "has a dialable URL" stays a real column
			// state rather than a magic string.
			baseUrl: input.baseUrl === "" ? null : input.baseUrl,
			model: input.model ?? null,
			sessionId: input.sessionId ?? null,
			secretRef: input.secretRef ?? null,
			transport: input.transport ?? null,
			agentCmd: input.agentCmd ?? null,
			sshHost: input.sshHost ?? null,
			scope: input.scope ?? "eval",
			isDefault: input.isDefault ?? false,
			timeoutMs: input.timeoutMs ?? 60_000,
			...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
		});
		const fetchRow = (id: number) =>
			Effect.promise(
				async () => (await db.select().from(aiEndpoint).where(eq(aiEndpoint.id, id)))[0],
			);
		return AiEndpoints.of({
			list: Effect.fn("AiEndpoints.list")(function* (scope?: string) {
				yield* requireGrant();
				const rows = yield* Effect.promise(() =>
					scope === undefined
						? db.select().from(aiEndpoint).orderBy(desc(aiEndpoint.id))
						: db
								.select()
								.from(aiEndpoint)
								.where(eq(aiEndpoint.scope, scope))
								.orderBy(desc(aiEndpoint.id)),
				);
				return rows.map(toEndpointCard);
			}),
			get: Effect.fn("AiEndpoints.get")(function* (id) {
				yield* requireGrant();
				const row = yield* fetchRow(id);
				return row === undefined ? null : toEndpointCard(row);
			}),
			create: Effect.fn("AiEndpoints.create")(function* (input) {
				yield* requireGrant();
				const rows = yield* Effect.promise(() =>
					db
						.insert(aiEndpoint)
						.values({ ...values(input), createdAt: new Date() })
						.returning({ id: aiEndpoint.id }),
				);
				return { id: rows[0]!.id };
			}),
			update: Effect.fn("AiEndpoints.update")(function* (input) {
				yield* requireGrant();
				yield* Effect.promise(() =>
					db.update(aiEndpoint).set(values(input)).where(eq(aiEndpoint.id, input.id)),
				);
			}),
			remove: Effect.fn("AiEndpoints.remove")(function* (id) {
				yield* requireGrant();
				yield* Effect.promise(() => db.delete(aiEndpoint).where(eq(aiEndpoint.id, id)));
			}),
			setPlatformDefault: Effect.fn("AiEndpoints.setPlatformDefault")(function* (id) {
				yield* requireGrant();
				yield* Effect.promise(() =>
					// tx() is atomic on every dialect — the old default can
					// never coexist with the new one, even on mid-write crash.
					tx(db, [
						db
							.update(aiEndpoint)
							.set({ isDefault: false })
							.where(and(eq(aiEndpoint.scope, "platform"), eq(aiEndpoint.isDefault, true))),
						db
							.update(aiEndpoint)
							.set({ scope: "platform", isDefault: true })
							.where(eq(aiEndpoint.id, id)),
					]),
				);
			}),
			presets: Effect.fn("AiEndpoints.presets")(function* () {
				yield* requireGrant();
				return Option.isNone(factory) ? [] : (factory.value.presets ?? []);
			}),
			test: Effect.fn("AiEndpoints.test")(function* (id) {
				yield* requireGrant();
				const row = yield* fetchRow(id);
				if (row === undefined) return;
				if (Option.isNone(factory)) {
					return yield* Effect.fail({
						_tag: "PortError",
						message: "no LlmFactory bound — endpoints resolve to template mode",
					} as const);
				}
				const descriptor = yield* descriptorOf(row);
				return yield* factory.value.test(descriptor);
			}),
			resolve: Effect.fn("AiEndpoints.resolve")(function* (id) {
				yield* requireGrant();
				const row = yield* fetchRow(id);
				if (row === undefined || !row.enabled) return null;
				return yield* descriptorOf(row);
			}),
			resolveDefault: Effect.fn("AiEndpoints.resolveDefault")(function* (scope?: string) {
				yield* requireGrant();
				const rows = yield* Effect.promise(() =>
					db
						.select()
						.from(aiEndpoint)
						.where(eq(aiEndpoint.enabled, true))
						.orderBy(desc(aiEndpoint.id)),
				);
				const scoped = scope === undefined ? rows : rows.filter((r) => r.scope === scope);
				const row = scoped.find((r) => r.isDefault) ?? scoped[0];
				if (row === undefined) return null;
				return yield* descriptorOf(row);
			}),
			createBridgeLink: Effect.fn("AiEndpoints.createBridgeLink")(
				function* (endpointId, createdBy) {
					yield* requireGrant();
					const row = yield* fetchRow(endpointId);
					if (row === undefined || !row.enabled || !isBridgeEndpoint(row)) return null;
					const token = mintBridgeToken();
					const tokenHash = yield* Effect.promise(() => sha256Hex(token));
					const expiresAt = new Date(Date.now() + BRIDGE_LINK_TTL_MS);
					yield* Effect.promise(() =>
						db
							.insert(aiAgentLink)
							.values({ endpointId, tokenHash, createdBy, expiresAt, createdAt: new Date() }),
					);
					return { token, expiresAt };
				},
			),
			bridgeStatus: Effect.fn("AiEndpoints.bridgeStatus")(function* (endpointId) {
				yield* requireGrant();
				const row = yield* fetchRow(endpointId);
				if (row === undefined || !row.enabled || !isBridgeEndpoint(row)) return null;
				const lastSeenAt = row.lastSeenAt;
				if (lastSeenAt !== null && Date.now() - lastSeenAt.getTime() <= BRIDGE_LIVE_MS) {
					return { status: "connected" as const, lastSeenAt };
				}
				// A minted-but-unconsumed link means a CLI command is in
				// somebody's clipboard — the badge says waiting until it
				// connects or the link expires.
				const open = yield* Effect.promise(() =>
					db
						.select({ id: aiAgentLink.id })
						.from(aiAgentLink)
						.where(
							and(
								eq(aiAgentLink.endpointId, endpointId),
								isNull(aiAgentLink.usedAt),
								isNull(aiAgentLink.revokedAt),
								gt(aiAgentLink.expiresAt, new Date()),
							),
						),
				);
				return {
					status: open.length > 0 ? ("waiting" as const) : ("offline" as const),
					lastSeenAt,
				};
			}),
			listAgentLinks: Effect.fn("AiEndpoints.listAgentLinks")(function* () {
				yield* requireGrant();
				const rows = yield* Effect.promise(() =>
					db
						.select({
							link: aiAgentLink,
							endpointName: aiEndpoint.name,
							lastSeenAt: aiEndpoint.lastSeenAt,
						})
						.from(aiAgentLink)
						.innerJoin(aiEndpoint, eq(aiAgentLink.endpointId, aiEndpoint.id))
						.orderBy(desc(aiAgentLink.id)),
				);
				const now = Date.now();
				return rows.map(({ link, endpointName, lastSeenAt }): AgentLinkRow => ({
					id: link.id,
					endpointId: link.endpointId,
					endpointName,
					status: agentLinkStatus(link, lastSeenAt, now),
					createdAt: link.createdAt,
					expiresAt: link.expiresAt,
					usedAt: link.usedAt,
					lastSeenAt,
				}));
			}),
			revokeAgentLink: Effect.fn("AiEndpoints.revokeAgentLink")(function* (id) {
				yield* requireGrant();
				const row = (yield* Effect.promise(() =>
					db.select().from(aiAgentLink).where(eq(aiAgentLink.id, id)),
				))[0];
				if (row === undefined || row.revokedAt !== null) return false;
				yield* Effect.promise(() =>
					db.update(aiAgentLink).set({ revokedAt: new Date() }).where(eq(aiAgentLink.id, id)),
				);
				return true;
			}),
		});
	}),
);

// ---------------------------------------------------------------------------
// PlatformLlm — the production surface's default-endpoint capability.
// System path (no principal): the audio pipeline resolves the enabled
// `scope='platform'` `is_default` endpoint through LlmFactory per call,
// so "Set as platform default" applies without a restart. Absent
// factory, missing default, disabled endpoint, or a resolve failure all
// answer null — consumers fall back to env config, then deterministic.
// ---------------------------------------------------------------------------

export const PlatformLlmLive = Layer.effect(
	PlatformLlm,
	Effect.gen(function* () {
		const db = yield* Db;
		const factory = yield* Effect.serviceOption(LlmFactory);
		return PlatformLlm.of({
			defaultLayer: () =>
				Effect.gen(function* () {
					if (Option.isNone(factory)) return null;
					const rows = yield* Effect.promise(() =>
						db
							.select()
							.from(aiEndpoint)
							.where(
								and(
									eq(aiEndpoint.scope, "platform"),
									eq(aiEndpoint.isDefault, true),
									eq(aiEndpoint.enabled, true),
								),
							)
							.orderBy(desc(aiEndpoint.id)),
					);
					const row = rows[0];
					if (row === undefined) return null;
					const descriptor = yield* descriptorOf(row);
					return yield* factory.value.resolve(descriptor);
				}).pipe(
					Effect.catch((error) =>
						Effect.logWarning("platform default endpoint resolution failed", {
							error: String(error),
						}).pipe(Effect.as(null)),
					),
				),
		});
	}),
);

// ---------------------------------------------------------------------------
// Plugin manifests
// ---------------------------------------------------------------------------

/** DDL mirror of schema.ts for in-memory test databases (same
 * contract as EVAL_PERSONA_TEST_DDL). */
export const AI_ENDPOINTS_TEST_DDL = `
CREATE TABLE ai_endpoint (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT, model TEXT, session_id TEXT, secret_ref TEXT, transport TEXT, agent_cmd TEXT, ssh_host TEXT, scope TEXT NOT NULL DEFAULT 'eval', is_default INTEGER NOT NULL DEFAULT 0, timeout_ms INTEGER NOT NULL DEFAULT 60000, enabled INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE ai_agent_link (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint_id INTEGER NOT NULL REFERENCES ai_endpoint(id) ON DELETE cascade, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL);
`;

export const aiEndpointsTablesPlugin = definePlugin({
	id: "ai.endpoints.tables",
	meta: { keywords: ["ai", "tables"] },
	requiredDeps: [],
	tables: { aiAgentLink, aiEndpoint },
});

export const aiEndpointsServicesPlugin = definePlugin({
	id: "ai.endpoints.services",
	meta: { keywords: ["ai", "services"] },
	requiredDeps: [aiEndpointsTablesPlugin.id],
	// credential:/vault: ref paths resolve through the credentials
	// and vault stores when those plugins are enabled — absence
	// just skips them.
	optionalDeps: ["credentials.services", "vault.secrets"],
	services: Layer.mergeAll(AiEndpointsLive, PlatformLlmLive),
});

export const aiEndpointsChromePlugin = definePlugin({
	id: "ai.endpoints.chrome",
	meta: { keywords: ["ai", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "ai-endpoints.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/ai/endpoints",
					label: "Endpoints",
					icon: PlugZapIcon,
					group: "AI",
				},
			},
		},
		{
			id: "ai-agents.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/ai/agents",
					label: "Agents",
					icon: BotIcon,
					group: "AI",
				},
			},
		},
	],
});

// Route subtree (P-033 style): the bridge handoff route module lives
// in THIS package (src/api-routes/**) and mounts under the shared
// "/api" prefix via a physical() scan — machine-token auth, no
// session. Route modules must live directly in src/api-routes/ — the
// generator scans every .ts file there, so tests stay outside it.
export const aiEndpointsRoutesPlugin = definePlugin({
	// The arch route gate derives this id from the package dir:
	// plugins/ai-endpoints → "ai-endpoints.routes".
	id: "ai-endpoints.routes",
	meta: { keywords: ["ai", "routes"] },
	routes: [physical("/api", "../../../../plugins/ai-endpoints/src/api-routes")],
});

export const aiEndpointsPanelPlugin = definePlugin({
	id: "ai.endpoints.panel",
	meta: { keywords: ["ai", "ui"] },
	requiredDeps: [platformPanelPlugin.id, aiEndpointsServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "ai.endpoints",
				path: "/platform/ai/endpoints",
				component: EndpointsPanelPage,
				guard: () =>
					Effect.gen(function* () {
						const permissions = yield* Permissions;
						return yield* permissions.can(EVAL_RESOURCE, EVAL_ACTION);
					}),
				loader: () =>
					Effect.gen(function* () {
						const endpoints = yield* AiEndpoints;
						return yield* endpoints
							.list()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as EndpointCard[])));
					}),
			},
			{
				id: "ai.agents",
				path: "/platform/ai/agents",
				component: AgentsPanelPage,
				guard: () =>
					Effect.gen(function* () {
						const permissions = yield* Permissions;
						return yield* permissions.can(EVAL_RESOURCE, EVAL_ACTION);
					}),
				// Links + bridge endpoints (the New-link dialog's select
				// options) — one loader payload, Forbidden degrades to
				// empty lists like the endpoints page.
				loader: () =>
					Effect.gen(function* () {
						const endpoints = yield* AiEndpoints;
						return yield* Effect.all({
							links: endpoints.listAgentLinks(),
							endpoints: endpoints.list(),
						}).pipe(
							Effect.catchTag("Forbidden", () =>
								Effect.succeed({
									links: [] as AgentLinkRow[],
									endpoints: [] as EndpointCard[],
								}),
							),
						);
					}),
			},
		],
	},
});

export const plugins: readonly Plugin[] = [
	aiEndpointsTablesPlugin,
	aiEndpointsServicesPlugin,
	aiEndpointsRoutesPlugin,
	aiEndpointsChromePlugin,
	aiEndpointsPanelPlugin,
];

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"ai.endpoints.tables": true;
		"ai.endpoints.services": true;
		"ai-endpoints.routes": true;
		"ai.endpoints.chrome": true;
		"ai.endpoints.panel": true;
	}
}
