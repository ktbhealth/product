import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureSessionUser, getServerRuntime, runAs } from "@ktb/server-fns";
import type { LlmEndpointPreset } from "@ktb/eval-consultation";

import {
	AiEndpoints,
	type AgentLinkRow,
	type BridgeStatus,
	type EndpointCard,
	type EndpointInput,
} from "./index.ts";

// AI endpoint server fns: the /platform/ai/endpoints surface mutates
// through these. The service re-checks the eval.validator grant inside
// runAs; `Forbidden` collapses to `{ ok: false }` like the other
// admin fns. Wire inputs tolerate undefined/null keys the same way
// eval-validator's ReviewInput does.

const optStr = Schema.optional(Schema.Union([Schema.String, Schema.Null]));
const optNum = Schema.optional(Schema.Union([Schema.Number, Schema.Null]));

const IdInput = Schema.Struct({ id: Schema.Number });
const EndpointSaveInput = Schema.Struct({
	id: optNum,
	name: Schema.String,
	kind: Schema.Literals(["acp", "openai"]),
	baseUrl: Schema.String,
	model: optStr,
	sessionId: optStr,
	secretRef: optStr,
	transport: Schema.optional(Schema.Union([Schema.Literals(["ws", "child", "ssh"]), Schema.Null])),
	agentCmd: optStr,
	sshHost: optStr,
	machineId: optNum,
	scope: optStr,
	isDefault: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])),
	timeoutMs: optNum,
	enabled: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])),
});

const decodeId = Schema.decodeUnknownSync(IdInput);
const decodeEndpoint = Schema.decodeUnknownSync(EndpointSaveInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

const run = <A, E>(
	user: Awaited<ReturnType<typeof ensureSessionUser>>,
	eff: Effect.Effect<A, E, unknown>,
) => runAs(user, Effect.scoped(eff));

const endpointFrom = (d: Schema.Schema.Type<typeof EndpointSaveInput>): EndpointInput => ({
	name: d.name,
	kind: d.kind,
	baseUrl: d.baseUrl,
	...(d.model != null ? { model: d.model } : {}),
	...(d.sessionId != null ? { sessionId: d.sessionId } : {}),
	...(d.secretRef != null ? { secretRef: d.secretRef } : {}),
	...(d.transport != null ? { transport: d.transport } : {}),
	...(d.agentCmd != null ? { agentCmd: d.agentCmd } : {}),
	...(d.sshHost != null ? { sshHost: d.sshHost } : {}),
	...(d.machineId != null ? { machineId: d.machineId } : {}),
	...(d.scope != null ? { scope: d.scope } : {}),
	...(d.isDefault != null ? { isDefault: d.isDefault } : {}),
	...(d.timeoutMs != null ? { timeoutMs: d.timeoutMs } : {}),
	...(d.enabled != null ? { enabled: d.enabled } : {}),
});

export const listEndpointsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<Result<readonly EndpointCard[]>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				const data = yield* s.list();
				return { ok: true as const, data };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	},
);

export const listEndpointPresetsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<Result<readonly LlmEndpointPreset[]>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				const data = yield* s.presets();
				return { ok: true as const, data };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	},
);

export const saveEndpointFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeEndpoint(input))
	.handler(async ({ data }): Promise<Result<{ id: number }>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				const input = endpointFrom(data);
				const r =
					data.id != null
						? yield* s.update({ id: data.id, ...input }).pipe(Effect.map(() => ({ id: data.id! })))
						: yield* s.create(input);
				return { ok: true as const, data: r };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const deleteEndpointFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				yield* s.remove(data.id);
				return { ok: true as const, data: null };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const setPlatformDefaultEndpointFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				yield* s.setPlatformDefault(data.id);
				return { ok: true as const, data: null };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

/**
 * Mint a bridge link (F3b). Returns the FULL `ai-bridge connect`
 * command ONCE — the raw token lives only inside it; the
 * table stores SHA-256. SECURITY INVARIANT: the command's `--cmd`
 * part is a suggestion for the local CLI flag, never something the
 * server sends to the agent — the CLI only ever receives frames.
 * `null` data for unknown/disabled/non-bridge endpoints or no grant.
 */
export const createBridgeLinkFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<{ command: string; expiresAt: Date } | null>> => {
		const user = await ensureSessionUser();
		const { getRequestUrl } = await import("@tanstack/react-start/server");
		const origin = new URL(getRequestUrl()).origin;
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				const link = yield* s.createBridgeLink(data.id, user.id);
				if (link === null) return { ok: true as const, data: null };
				// The CLI argv prefix comes from the composition root — dev
				// resolves the repo's cli.ts (the package is unpublished, so
				// bunx 404s); the bunx fallback is the prod path for the day
				// it ships. --cmd suggests the ACP adapter package: Claude
				// Code 2.x has no `claude agent acp` subcommand —
				// @agentclientprotocol/claude-agent-acp is the adapter, and
				// bunx needs no install.
				const cli = getServerRuntime().aiBridgeCli ?? "bunx @ktb/ai-bridge";
				const command =
					`${cli} connect ` +
					`${origin}/api/ai/bridge?token=${link.token} ` +
					`--cmd "bunx @agentclientprotocol/claude-agent-acp"`;
				return { ok: true as const, data: { command, expiresAt: link.expiresAt } };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

/** Bridge status poll for the connect dialog — `null` for
 * unknown/disabled/non-bridge endpoints or no grant. */
export const endpointBridgeStatusFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		async ({ data }): Promise<Result<{ status: BridgeStatus; lastSeenAt: Date | null } | null>> => {
			const user = await ensureSessionUser();
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* AiEndpoints;
					const status = yield* s.bridgeStatus(data.id);
					return { ok: true as const, data: status };
				}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
			);
		},
	);

/** Agents page list (F4): every bridge link joined to its endpoint —
 * the wire never carries token_hash. `{ ok: false }` without the
 * eval.validator grant. */
export const listAgentLinksFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<Result<readonly AgentLinkRow[]>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				const data = yield* s.listAgentLinks();
				return { ok: true as const, data };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	},
);

/** Revoke a bridge link (F4): stamps revoked_at — future token use is
 * refused and the row flips to `revoked`. `data.revoked` is false for
 * unknown or already-revoked ids. */
export const revokeAgentLinkFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<{ revoked: boolean }>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				const revoked = yield* s.revokeAgentLink(data.id);
				return { ok: true as const, data: { revoked } };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const }))),
		);
	});

export const testEndpointFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<{ message?: string }>> => {
		const user = await ensureSessionUser();
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* AiEndpoints;
				yield* s.test(data.id);
				return { ok: true as const, data: {} };
			}).pipe(
				Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
				Effect.catch((e) =>
					Effect.succeed({
						ok: false as const,
						data: {
							message:
								typeof e === "object" && e !== null && "message" in e
									? String((e as { message: unknown }).message)
									: String(e),
						},
					}),
				),
			),
		);
	});
