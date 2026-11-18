import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, eq } from "drizzle-orm";

import { Audit } from "@ktb/audit";
import { Forbidden } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { PlatformAdmin, type PlatformAdminShape } from "@ktb/platform";
import { requireTenantRole, Tenant, TenantForbidden } from "@ktb/tenant";

import { aiModel, type AiModel, type AiModelKind } from "./schema.ts";

/**
 * AiModels — the platform model catalog (P-098 WS-B).
 *
 * Owns model records: the provider-side `modelId`, the serving
 * `endpointId` (soft ref into plugins/ai-provider), capability tags,
 * context/cost metadata and the per-scope default flag. Consumers
 * (LLM factories, eval judges, transcription adapters) resolve a
 * `ModelCard` server-side — `resolve`/`resolveDefault` are ungated
 * capability reads like `Secrets.resolve`/`Machines.resolve`: the row
 * id is the capability, user-facing surfaces use the gated
 * `get`/`list`. Disabled rows resolve to null so callers fall back
 * honestly instead of dialing a retired model.
 *
 * Authz mirrors `Machines`: platform scope → `PlatformAdmin`; tenant
 * scope → bound tenant (members read, admins write). Mutations and
 * resolves audit.
 */

const PLATFORM_SCOPE = "platform";

export class ModelError extends Data.TaggedError("ModelError")<{
	readonly reason: "not-found" | "tenant-mismatch" | "invalid" | "duplicate";
	readonly detail?: string;
}> {}

/** Wire-facing model DTO. */
export interface ModelCard {
	readonly id: number;
	readonly scope: string;
	readonly tenantId: number | null;
	readonly endpointId: number | null;
	readonly name: string;
	readonly modelId: string;
	readonly kind: AiModelKind;
	readonly capabilities: ReadonlyArray<string>;
	readonly contextTokens: number | null;
	readonly costTier: string | null;
	readonly isDefault: boolean;
	readonly enabled: boolean;
	readonly createdAt: Date;
	readonly updatedAt: Date | null;
}

// ── Repo functions (testable, no service context) ────────────────

const parseCapabilities = (raw: string | null): ReadonlyArray<string> => {
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
	} catch {
		return [];
	}
};

const toCard = (row: AiModel): ModelCard => ({
	id: row.id,
	scope: row.scope,
	tenantId: row.tenantId,
	endpointId: row.endpointId,
	name: row.name,
	modelId: row.modelId,
	kind: row.kind as AiModelKind,
	capabilities: parseCapabilities(row.capabilities),
	contextTokens: row.contextTokens,
	costTier: row.costTier,
	isDefault: row.isDefault,
	enabled: row.enabled === 1,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

export async function listModels(
	db: DbClient,
	scope: string,
	endpointId?: number,
): Promise<AiModel[]> {
	const conditions = [eq(aiModel.scope, scope)];
	if (endpointId !== undefined) conditions.push(eq(aiModel.endpointId, endpointId));
	return db
		.select()
		.from(aiModel)
		.where(and(...conditions))
		.orderBy(aiModel.name);
}

export async function getModelById(db: DbClient, id: number): Promise<AiModel | null> {
	const rows = await db.select().from(aiModel).where(eq(aiModel.id, id)).limit(1);
	return rows[0] ?? null;
}

export async function getModelByName(
	db: DbClient,
	scope: string,
	name: string,
): Promise<AiModel | null> {
	const rows = await db
		.select()
		.from(aiModel)
		.where(and(eq(aiModel.scope, scope), eq(aiModel.name, name)))
		.limit(1);
	return rows[0] ?? null;
}

export async function insertModel(
	db: DbClient,
	row: {
		readonly scope: string;
		readonly tenantId: number | null;
		readonly endpointId: number | null;
		readonly name: string;
		readonly modelId: string;
		readonly kind: AiModelKind;
		readonly capabilities: string | null;
		readonly contextTokens: number | null;
		readonly costTier: string | null;
		readonly isDefault: boolean;
	},
): Promise<AiModel> {
	const rows = await db
		.insert(aiModel)
		.values({ ...row, enabled: 1, createdAt: new Date() })
		.returning();
	return rows[0]!;
}

export async function updateModel(
	db: DbClient,
	id: number,
	patch: Partial<{
		endpointId: number | null;
		name: string;
		modelId: string;
		kind: AiModelKind;
		capabilities: string | null;
		contextTokens: number | null;
		costTier: string | null;
		isDefault: boolean;
		enabled: number;
	}>,
): Promise<AiModel> {
	const rows = await db
		.update(aiModel)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(aiModel.id, id))
		.returning();
	return rows[0]!;
}

export async function deleteModel(db: DbClient, id: number): Promise<void> {
	await db.delete(aiModel).where(eq(aiModel.id, id));
}

// ── Authz ────────────────────────────────────────────────────────

/** Scope-aware gate — `scope` is "platform" | String(tenantId).
 * platform → PlatformAdmin; tenant → bound-tenant admin (write) /
 * member (read). */
const requireScopeAccess = (admin: PlatformAdminShape, scope: string, min: "admin" | "member") => {
	if (scope === PLATFORM_SCOPE) return admin.requireAdmin();
	const tenantId = Number(scope);
	return Effect.gen(function* () {
		const tenant = yield* Tenant;
		if (tenant === null || Number(tenant.id) !== tenantId)
			return yield* Effect.fail(new ModelError({ reason: "tenant-mismatch" }));
		yield* requireTenantRole(min === "admin" ? "admin" : "member", `ai-model.${min}`);
	});
};

const scopeFor = (input: {
	readonly scope: "platform" | "tenant";
	readonly tenantId?: number | null;
}): { readonly scope: string; readonly tenantId: number | null } =>
	input.scope === "tenant" && input.tenantId != null
		? { scope: String(input.tenantId), tenantId: input.tenantId }
		: { scope: PLATFORM_SCOPE, tenantId: null };

// ── Service ──────────────────────────────────────────────────────

export class AiModels extends Context.Service<
	AiModels,
	{
		readonly list: (input?: {
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
			readonly endpointId?: number;
		}) => Effect.Effect<ReadonlyArray<ModelCard>, ModelError | TenantForbidden | Forbidden>;
		readonly get: (
			id: number,
		) => Effect.Effect<ModelCard | null, ModelError | TenantForbidden | Forbidden>;
		readonly create: (input: {
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
			readonly endpointId?: number | null;
			readonly name: string;
			readonly modelId: string;
			readonly kind?: AiModelKind;
			readonly capabilities?: ReadonlyArray<string>;
			readonly contextTokens?: number | null;
			readonly costTier?: string | null;
			readonly isDefault?: boolean;
		}) => Effect.Effect<ModelCard, ModelError | TenantForbidden | Forbidden>;
		readonly update: (input: {
			readonly id: number;
			readonly endpointId?: number | null;
			readonly name?: string;
			readonly modelId?: string;
			readonly kind?: AiModelKind;
			readonly capabilities?: ReadonlyArray<string>;
			readonly contextTokens?: number | null;
			readonly costTier?: string | null;
			readonly isDefault?: boolean;
			readonly enabled?: boolean;
		}) => Effect.Effect<ModelCard, ModelError | TenantForbidden | Forbidden>;
		readonly remove: (id: number) => Effect.Effect<void, ModelError | TenantForbidden | Forbidden>;
		/** Server-side capability read for system consumers (LLM
		 * factories, eval judges) — ungated like `Secrets.resolve`:
		 * the model id is the capability. Disabled/unknown → null.
		 * Audit-logged. */
		readonly resolve: (id: number) => Effect.Effect<ModelCard | null, ModelError>;
		/** The scope's default enabled model (optionally filtered by
		 * endpoint) — falls back to null when none is flagged. */
		readonly resolveDefault: (input?: {
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
			readonly endpointId?: number;
		}) => Effect.Effect<ModelCard | null, ModelError | TenantForbidden | Forbidden>;
	}
>()("@ktb/ai-model/AiModels") {}

/** Audit write — best-effort; detail carries ids/labels only. */
const recordAudit = (
	action: string,
	row: { readonly id: number; readonly scope: string; readonly name: string },
	detail?: Record<string, unknown>,
) =>
	Effect.gen(function* () {
		const audit = yield* Effect.serviceOption(Audit);
		if (audit._tag !== "Some") return;
		const tenantId = row.scope === PLATFORM_SCOPE ? null : Number(row.scope);
		yield* audit.value.record({
			action,
			targetType: "ai_model",
			targetId: row.id,
			detail: { name: row.name, scope: row.scope, ...detail },
			tenantId: Number.isFinite(tenantId) ? tenantId : null,
		});
	});

export const AiModelsLive = Layer.effect(
	AiModels,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;

		const requireModel = Effect.fn("AiModels.requireModel")(function* (id: number) {
			const row = yield* Effect.promise(() => getModelById(db, id));
			if (row === null) return yield* Effect.fail(new ModelError({ reason: "not-found" }));
			return row;
		});

		const requireWrite = Effect.fn("AiModels.requireWrite")(function* (row: AiModel) {
			yield* requireScopeAccess(platformAdmin, row.scope, "admin");
		});

		const validate = Effect.fn("AiModels.validate")(function* (input: {
			readonly name: string;
			readonly modelId: string;
		}) {
			const name = input.name.trim();
			const modelId = input.modelId.trim();
			if (name === "" || modelId === "")
				return yield* Effect.fail(
					new ModelError({ reason: "invalid", detail: "name and modelId are required" }),
				);
			return { name, modelId };
		});

		return AiModels.of({
			list: Effect.fn("AiModels.list")(function* (input) {
				const { scope } = scopeFor({
					scope: input?.scope ?? "platform",
					tenantId: input?.tenantId ?? null,
				});
				yield* requireScopeAccess(platformAdmin, scope, "member");
				const rows = yield* Effect.promise(() => listModels(db, scope, input?.endpointId));
				return rows.map(toCard);
			}),

			get: Effect.fn("AiModels.get")(function* (id) {
				const row = yield* Effect.promise(() => getModelById(db, id));
				if (row === null) return null;
				yield* requireScopeAccess(platformAdmin, row.scope, "member");
				return toCard(row);
			}),

			create: Effect.fn("AiModels.create")(function* (input) {
				const { scope, tenantId } = scopeFor({
					scope: input.scope ?? "platform",
					tenantId: input.tenantId ?? null,
				});
				yield* requireScopeAccess(platformAdmin, scope, "admin");
				const { name, modelId } = yield* validate(input);
				const existing = yield* Effect.promise(() => getModelByName(db, scope, name));
				if (existing !== null)
					return yield* Effect.fail(
						new ModelError({ reason: "duplicate", detail: `model "${name}" exists` }),
					);
				const row = yield* Effect.promise(() =>
					insertModel(db, {
						scope,
						tenantId,
						endpointId: input.endpointId ?? null,
						name,
						modelId,
						kind: input.kind ?? "chat",
						capabilities:
							input.capabilities === undefined ? null : JSON.stringify(input.capabilities),
						contextTokens: input.contextTokens ?? null,
						costTier: input.costTier ?? null,
						isDefault: input.isDefault === true,
					}),
				);
				yield* recordAudit("ai-model.create", row);
				return toCard(row);
			}),

			update: Effect.fn("AiModels.update")(function* (input) {
				const row = yield* requireModel(input.id);
				yield* requireWrite(row);
				if (input.name !== undefined && input.name.trim() === "")
					return yield* Effect.fail(new ModelError({ reason: "invalid", detail: "name is empty" }));
				if (input.modelId !== undefined && input.modelId.trim() === "")
					return yield* Effect.fail(
						new ModelError({ reason: "invalid", detail: "modelId is empty" }),
					);
				const patch: Parameters<typeof updateModel>[2] = {
					...(input.endpointId !== undefined ? { endpointId: input.endpointId } : {}),
					...(input.name !== undefined ? { name: input.name.trim() } : {}),
					...(input.modelId !== undefined ? { modelId: input.modelId.trim() } : {}),
					...(input.kind !== undefined ? { kind: input.kind } : {}),
					...(input.capabilities !== undefined
						? { capabilities: JSON.stringify(input.capabilities) }
						: {}),
					...(input.contextTokens !== undefined ? { contextTokens: input.contextTokens } : {}),
					...(input.costTier !== undefined ? { costTier: input.costTier } : {}),
					...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
					...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
				};
				const updated = yield* Effect.promise(() => updateModel(db, row.id, patch));
				yield* recordAudit("ai-model.update", updated);
				return toCard(updated);
			}),

			remove: Effect.fn("AiModels.remove")(function* (id) {
				const row = yield* requireModel(id);
				yield* requireWrite(row);
				yield* Effect.promise(() => deleteModel(db, row.id));
				yield* recordAudit("ai-model.remove", row);
			}),

			resolve: Effect.fn("AiModels.resolve")(function* (id) {
				const row = yield* Effect.promise(() => getModelById(db, id));
				if (row === null || row.enabled !== 1) return null;
				yield* recordAudit("ai-model.resolve", row);
				return toCard(row);
			}),

			resolveDefault: Effect.fn("AiModels.resolveDefault")(function* (input) {
				const { scope } = scopeFor({
					scope: input?.scope ?? "platform",
					tenantId: input?.tenantId ?? null,
				});
				yield* requireScopeAccess(platformAdmin, scope, "member");
				const rows = yield* Effect.promise(() => listModels(db, scope, input?.endpointId));
				const enabled = rows.filter((r) => r.enabled === 1);
				const flagged = enabled.find((r) => r.isDefault === true);
				return flagged !== undefined ? toCard(flagged) : null;
			}),
		});
	}),
);
