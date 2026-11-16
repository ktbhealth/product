import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { desc, eq } from "drizzle-orm";
import { PlugZapIcon } from "lucide-react";

import { type Forbidden } from "@ktb/authz";
import { Credentials } from "@ktb/credentials";
import { Db } from "@ktb/db";
import {
	LlmFactory,
	type LlmEndpointDescriptor,
	type LlmEndpointPreset,
} from "@ktb/eval-consultation";
import { EVAL_ACTION, EVAL_RESOURCE } from "@ktb/eval-validator";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";

import { EndpointsPanelPage } from "./platform-page.tsx";
import { aiEndpoint, type AiEndpoint } from "./schema.ts";

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
	readonly scope: string;
	readonly isDefault: boolean;
	readonly timeoutMs: number;
	readonly enabled: boolean;
	readonly createdAt: Date;
}

export interface EndpointInput {
	readonly name: string;
	readonly kind: string;
	readonly baseUrl: string;
	readonly model?: string;
	readonly sessionId?: string;
	readonly secretRef?: string;
	/** ACP transport — 'ws' | 'child' | 'ssh' (null/absent = 'ws'). */
	readonly transport?: string;
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
	baseUrl: row.baseUrl,
	model: row.model,
	sessionId: row.sessionId,
	secretRef: row.secretRef,
	transport: row.transport,
	scope: row.scope,
	isDefault: row.isDefault,
	timeoutMs: row.timeoutMs,
	enabled: row.enabled,
	createdAt: row.createdAt,
});

const requireGrant = Effect.fn("AiEndpoints.gate")(function* () {
	const permissions = yield* Permissions;
	yield* permissions.requirePermission(EVAL_RESOURCE, EVAL_ACTION);
});

/** `secretRef` is either an env var NAME or `credential:<id>` — the
 * latter resolves through the credentials store so raw secrets are
 * injected into the descriptor and never leave the server. */
const descriptorOf = (row: AiEndpoint): Effect.Effect<LlmEndpointDescriptor, never, unknown> =>
	Effect.gen(function* () {
		const transport = row.transport;
		const base: LlmEndpointDescriptor = {
			kind: row.kind === "acp" ? "acp" : "openai",
			baseUrl: row.baseUrl,
			...(row.model !== null ? { model: row.model } : {}),
			...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
			...(row.kind === "acp" && (transport === "child" || transport === "ssh" || transport === "ws")
				? { transport }
				: {}),
			timeoutMs: row.timeoutMs,
		};
		const ref = row.secretRef;
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
			baseUrl: input.baseUrl,
			model: input.model ?? null,
			sessionId: input.sessionId ?? null,
			secretRef: input.secretRef ?? null,
			transport: input.transport ?? null,
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
					db.insert(aiEndpoint).values(values(input)).returning({ id: aiEndpoint.id }),
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
		});
	}),
);

// ---------------------------------------------------------------------------
// Plugin manifests
// ---------------------------------------------------------------------------

/** DDL mirror of schema.ts for in-memory test databases (same
 * contract as EVAL_PERSONA_TEST_DDL). */
export const AI_ENDPOINTS_TEST_DDL = `
CREATE TABLE ai_endpoint (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT, session_id TEXT, secret_ref TEXT, transport TEXT, scope TEXT NOT NULL DEFAULT 'eval', is_default INTEGER NOT NULL DEFAULT 0, timeout_ms INTEGER NOT NULL DEFAULT 60000, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
`;

export const aiEndpointsTablesPlugin = definePlugin({
	id: "ai.endpoints.tables",
	requiredDeps: [],
	tables: { aiEndpoint },
});

export const aiEndpointsServicesPlugin = definePlugin({
	id: "ai.endpoints.services",
	requiredDeps: [aiEndpointsTablesPlugin.id],
	// The credential:<id> ref path resolves through the credentials
	// store when that plugin is enabled — absence just skips it.
	optionalDeps: ["credentials.services"],
	services: AiEndpointsLive,
});

export const aiEndpointsChromePlugin = definePlugin({
	id: "ai.endpoints.chrome",
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "ai-endpoints.sidebar",
			region: "console.sidebar",
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
	],
});

export const aiEndpointsPanelPlugin = definePlugin({
	id: "ai.endpoints.panel",
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
		],
	},
});

export const plugins: readonly Plugin[] = [
	aiEndpointsTablesPlugin,
	aiEndpointsServicesPlugin,
	aiEndpointsChromePlugin,
	aiEndpointsPanelPlugin,
];

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"ai.endpoints.tables": true;
		"ai.endpoints.services": true;
		"ai.endpoints.chrome": true;
		"ai.endpoints.panel": true;
	}
}
