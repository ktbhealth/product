import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, desc, eq } from "drizzle-orm";

import { Audit } from "@ktb/audit";
import { Forbidden } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { PlatformAdmin, type PlatformAdminShape } from "@ktb/platform";
import { requireTenantRole, Tenant, TenantForbidden } from "@ktb/tenant";

import { aiPrompt, type AiPrompt } from "./schema.ts";

/**
 * AiPrompts — the versioned prompt registry (P-098 WS-C).
 *
 * Owns prompt rows: `{name, version, locale, template, variables,
 * modelHint, isSystem}`. This service IS the PromptPort consumers
 * bind: `resolve(name, {version?, locale?})` returns the newest
 * matching enabled version (exact locale → locale-neutral ""),
 * `resolveDefault` the scope's flagged default. Both are ungated
 * capability reads like `Secrets.resolve`/`Machines.resolve` —
 * prompt names are not secrets; the row id/version is the pin.
 * Unknown/disabled → null so callers fall back to their built-in
 * template honestly.
 *
 * Writes are append-mostly: `create` always inserts a NEW version
 * (history never mutates); `update` edits metadata/template of an
 * existing version in place (draft correction before consumers pin
 * it); `remove` deletes a version row.
 *
 * Authz mirrors `AiModels`: platform scope → `PlatformAdmin`; tenant
 * scope → bound tenant (members read, admins write). Mutations and
 * resolves audit.
 */

const PLATFORM_SCOPE = "platform";

export class PromptError extends Data.TaggedError("PromptError")<{
	readonly reason: "not-found" | "tenant-mismatch" | "invalid" | "duplicate";
	readonly detail?: string;
}> {}

export interface PromptVariable {
	readonly name: string;
	readonly required?: boolean;
	readonly description?: string;
}

/** Wire-facing prompt DTO — template included (prompts are not secrets). */
export interface PromptCard {
	readonly id: number;
	readonly scope: string;
	readonly tenantId: number | null;
	readonly name: string;
	readonly version: number;
	readonly locale: string;
	readonly template: string;
	readonly variables: ReadonlyArray<PromptVariable>;
	readonly modelHint: string | null;
	readonly isSystem: boolean;
	readonly isDefault: boolean;
	readonly enabled: boolean;
	readonly createdAt: Date;
	readonly updatedAt: Date | null;
}

// ── Repo functions (testable, no service context) ────────────────

const parseVariables = (raw: string | null): ReadonlyArray<PromptVariable> => {
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(v): v is PromptVariable =>
				typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string",
		);
	} catch {
		return [];
	}
};

const toCard = (row: AiPrompt): PromptCard => ({
	id: row.id,
	scope: row.scope,
	tenantId: row.tenantId,
	name: row.name,
	version: row.version,
	locale: row.locale,
	template: row.template,
	variables: parseVariables(row.variables),
	modelHint: row.modelHint,
	isSystem: row.isSystem,
	isDefault: row.isDefault,
	enabled: row.enabled === 1,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

/** Versions of one prompt family in a scope, newest first. */
export async function listPromptVersions(
	db: DbClient,
	scope: string,
	name: string,
): Promise<AiPrompt[]> {
	return db
		.select()
		.from(aiPrompt)
		.where(and(eq(aiPrompt.scope, scope), eq(aiPrompt.name, name)))
		.orderBy(desc(aiPrompt.version));
}

export async function listPrompts(db: DbClient, scope: string): Promise<AiPrompt[]> {
	return db.select().from(aiPrompt).where(eq(aiPrompt.scope, scope)).orderBy(aiPrompt.name);
}

export async function getPromptById(db: DbClient, id: number): Promise<AiPrompt | null> {
	const rows = await db.select().from(aiPrompt).where(eq(aiPrompt.id, id)).limit(1);
	return rows[0] ?? null;
}

export async function getPromptVersion(
	db: DbClient,
	scope: string,
	name: string,
	version: number,
	locale: string,
): Promise<AiPrompt | null> {
	const rows = await db
		.select()
		.from(aiPrompt)
		.where(
			and(
				eq(aiPrompt.scope, scope),
				eq(aiPrompt.name, name),
				eq(aiPrompt.version, version),
				eq(aiPrompt.locale, locale),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

export async function insertPrompt(
	db: DbClient,
	row: {
		readonly scope: string;
		readonly tenantId: number | null;
		readonly name: string;
		readonly version: number;
		readonly locale: string;
		readonly template: string;
		readonly variables: string | null;
		readonly modelHint: string | null;
		readonly isSystem: boolean;
		readonly isDefault: boolean;
	},
): Promise<AiPrompt> {
	const rows = await db
		.insert(aiPrompt)
		.values({ ...row, enabled: 1, createdAt: new Date() })
		.returning();
	return rows[0]!;
}

export async function updatePrompt(
	db: DbClient,
	id: number,
	patch: Partial<{
		template: string;
		variables: string | null;
		modelHint: string | null;
		isSystem: boolean;
		isDefault: boolean;
		enabled: number;
	}>,
): Promise<AiPrompt> {
	const rows = await db
		.update(aiPrompt)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(aiPrompt.id, id))
		.returning();
	return rows[0]!;
}

export async function deletePrompt(db: DbClient, id: number): Promise<void> {
	await db.delete(aiPrompt).where(eq(aiPrompt.id, id));
}

// ── Authz ────────────────────────────────────────────────────────

const requireScopeAccess = (admin: PlatformAdminShape, scope: string, min: "admin" | "member") => {
	if (scope === PLATFORM_SCOPE) return admin.requireAdmin();
	const tenantId = Number(scope);
	return Effect.gen(function* () {
		const tenant = yield* Tenant;
		if (tenant === null || Number(tenant.id) !== tenantId)
			return yield* Effect.fail(new PromptError({ reason: "tenant-mismatch" }));
		yield* requireTenantRole(min === "admin" ? "admin" : "member", `ai-prompt.${min}`);
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

export class AiPrompts extends Context.Service<
	AiPrompts,
	{
		/** Prompt families visible to the caller's scope — one card per
		 * (name, version, locale) row, name+version ordered. */
		readonly list: (input?: {
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
			readonly name?: string;
		}) => Effect.Effect<ReadonlyArray<PromptCard>, PromptError | TenantForbidden | Forbidden>;
		readonly get: (
			id: number,
		) => Effect.Effect<PromptCard | null, PromptError | TenantForbidden | Forbidden>;
		/** Append a new version of `name` (version auto = max+1 unless
		 * pinned). History is never mutated by create. */
		readonly create: (input: {
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
			readonly name: string;
			readonly version?: number;
			readonly locale?: string;
			readonly template: string;
			readonly variables?: ReadonlyArray<PromptVariable>;
			readonly modelHint?: string | null;
			readonly isSystem?: boolean;
			readonly isDefault?: boolean;
		}) => Effect.Effect<PromptCard, PromptError | TenantForbidden | Forbidden>;
		/** Edit an existing version's mutable fields (template,
		 * variables, hints, flags) — name/version/locale are identity. */
		readonly update: (input: {
			readonly id: number;
			readonly template?: string;
			readonly variables?: ReadonlyArray<PromptVariable>;
			readonly modelHint?: string | null;
			readonly isSystem?: boolean;
			readonly isDefault?: boolean;
			readonly enabled?: boolean;
		}) => Effect.Effect<PromptCard, PromptError | TenantForbidden | Forbidden>;
		readonly remove: (id: number) => Effect.Effect<void, PromptError | TenantForbidden | Forbidden>;
		/** THE PromptPort read — ungated capability resolution:
		 * newest enabled version matching name (+ optional version pin,
		 * locale with "" fallback). Unknown/disabled → null. */
		readonly resolve: (input: {
			readonly name: string;
			readonly version?: number;
			readonly locale?: string;
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
		}) => Effect.Effect<PromptCard | null, PromptError>;
	}
>()("@ktb/ai-prompt/AiPrompts") {}

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
			targetType: "ai_prompt",
			targetId: row.id,
			detail: { name: row.name, scope: row.scope, ...detail },
			tenantId: Number.isFinite(tenantId) ? tenantId : null,
		});
	});

export const AiPromptsLive = Layer.effect(
	AiPrompts,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;

		const requirePrompt = Effect.fn("AiPrompts.requirePrompt")(function* (id: number) {
			const row = yield* Effect.promise(() => getPromptById(db, id));
			if (row === null) return yield* Effect.fail(new PromptError({ reason: "not-found" }));
			return row;
		});

		const requireWrite = Effect.fn("AiPrompts.requireWrite")(function* (row: AiPrompt) {
			yield* requireScopeAccess(platformAdmin, row.scope, "admin");
		});

		/** Pick the best matching enabled row for a resolve request:
		 * version pin first, then locale (exact → ""), newest version. */
		const pickResolved = (
			rows: readonly AiPrompt[],
			input: { readonly version?: number; readonly locale?: string },
		): AiPrompt | null => {
			const enabled = rows.filter((r) => r.enabled === 1);
			const versionMatch =
				input.version !== undefined ? enabled.filter((r) => r.version === input.version) : enabled;
			if (versionMatch.length === 0) return null;
			const locale = input.locale;
			if (locale !== undefined && locale !== "") {
				const exact = versionMatch.filter((r) => r.locale === locale);
				if (exact.length > 0) return exact[0]!;
				const neutral = versionMatch.filter((r) => r.locale === "");
				if (neutral.length > 0) return neutral[0]!;
				return null;
			}
			// No locale requested — prefer locale-neutral, then any.
			const neutral = versionMatch.filter((r) => r.locale === "");
			return neutral[0] ?? versionMatch[0] ?? null;
		};

		return AiPrompts.of({
			list: Effect.fn("AiPrompts.list")(function* (input) {
				const { scope } = scopeFor({
					scope: input?.scope ?? "platform",
					tenantId: input?.tenantId ?? null,
				});
				yield* requireScopeAccess(platformAdmin, scope, "member");
				const rows =
					input?.name !== undefined
						? yield* Effect.promise(() => listPromptVersions(db, scope, input.name!))
						: yield* Effect.promise(() => listPrompts(db, scope));
				return rows.map(toCard);
			}),

			get: Effect.fn("AiPrompts.get")(function* (id) {
				const row = yield* Effect.promise(() => getPromptById(db, id));
				if (row === null) return null;
				yield* requireScopeAccess(platformAdmin, row.scope, "member");
				return toCard(row);
			}),

			create: Effect.fn("AiPrompts.create")(function* (input) {
				const { scope, tenantId } = scopeFor({
					scope: input.scope ?? "platform",
					tenantId: input.tenantId ?? null,
				});
				yield* requireScopeAccess(platformAdmin, scope, "admin");
				const name = input.name.trim();
				const template = input.template;
				if (name === "" || template.trim() === "")
					return yield* Effect.fail(
						new PromptError({ reason: "invalid", detail: "name and template are required" }),
					);
				const locale = input.locale ?? "";
				const existing = yield* Effect.promise(() => listPromptVersions(db, scope, name));
				const version =
					input.version ?? existing.reduce((max, r) => Math.max(max, r.version), 0) + 1;
				const dup = yield* Effect.promise(() => getPromptVersion(db, scope, name, version, locale));
				if (dup !== null)
					return yield* Effect.fail(
						new PromptError({
							reason: "duplicate",
							detail: `prompt "${name}" v${version} (${locale || "neutral"}) exists`,
						}),
					);
				const row = yield* Effect.promise(() =>
					insertPrompt(db, {
						scope,
						tenantId,
						name,
						version,
						locale,
						template,
						variables: input.variables === undefined ? null : JSON.stringify(input.variables),
						modelHint: input.modelHint ?? null,
						isSystem: input.isSystem === true,
						isDefault: input.isDefault === true,
					}),
				);
				yield* recordAudit("ai-prompt.create", row, { version });
				return toCard(row);
			}),

			update: Effect.fn("AiPrompts.update")(function* (input) {
				const row = yield* requirePrompt(input.id);
				yield* requireWrite(row);
				if (input.template !== undefined && input.template.trim() === "")
					return yield* Effect.fail(
						new PromptError({ reason: "invalid", detail: "template is empty" }),
					);
				const patch: Parameters<typeof updatePrompt>[2] = {
					...(input.template !== undefined ? { template: input.template } : {}),
					...(input.variables !== undefined ? { variables: JSON.stringify(input.variables) } : {}),
					...(input.modelHint !== undefined ? { modelHint: input.modelHint } : {}),
					...(input.isSystem !== undefined ? { isSystem: input.isSystem } : {}),
					...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
					...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
				};
				const updated = yield* Effect.promise(() => updatePrompt(db, row.id, patch));
				yield* recordAudit("ai-prompt.update", updated);
				return toCard(updated);
			}),

			remove: Effect.fn("AiPrompts.remove")(function* (id) {
				const row = yield* requirePrompt(id);
				yield* requireWrite(row);
				yield* Effect.promise(() => deletePrompt(db, row.id));
				yield* recordAudit("ai-prompt.remove", row);
			}),

			resolve: Effect.fn("AiPrompts.resolve")(function* (input) {
				const { scope } = scopeFor({
					scope: input.scope ?? "platform",
					tenantId: input.tenantId ?? null,
				});
				const name = input.name.trim();
				if (name === "") return null;
				const rows = yield* Effect.promise(() => listPromptVersions(db, scope, name));
				const picked = pickResolved(rows, input);
				if (picked === null) return null;
				yield* recordAudit("ai-prompt.resolve", picked, {
					version: picked.version,
					locale: picked.locale,
				});
				return toCard(picked);
			}),
		});
	}),
);
