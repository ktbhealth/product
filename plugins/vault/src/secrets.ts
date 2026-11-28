import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, eq, sql } from "drizzle-orm";

import { Forbidden, Principal } from "@ktb/authz";
import { aead } from "@ktb/crypto";
import type { SecretKeyringService } from "@ktb/crypto/secret-keyring";
import { SecretKeyring } from "@ktb/crypto/secret-keyring";
import { Audit } from "@ktb/audit";
import { Db, type DbClient } from "@ktb/db";
import { PlatformAdmin, type PlatformAdminShape } from "@ktb/platform";
import { requireTenantRole, Tenant, TenantForbidden } from "@ktb/tenant";

import { vaultSecret, type VaultSecret, type VaultSecretKind } from "./schema.ts";

/**
 * Server-side secrets domain (P-098 C1) — THE credential store.
 *
 * Trust model:
 * - `vault_secret` rows hold per-secret DEKs wrapped under the
 *   deployment KEK (`SecretKeyring` port, `VAULT_MASTER_KEY` driver)
 *   plus the value as an AES-256-GCM envelope — plaintext never
 *   touches the database.
 * - `resolve(ref)` is the ONLY read-back and is deliberately NOT
 *   permission-gated: it is a server-side port other plugins/drivers
 *   call in system context (no Principal — e.g. the SMTP driver at
 *   send time). The `vault:<id>` ref IS the capability; callers gate
 *   their own user-facing surfaces. Every resolve is audit-logged.
 * - Mutations are gated: platform scope → `PlatformAdmin.requireAdmin`;
 *   tenant scope → bound-tenant `admin` (writes) / `member` (reads).
 *
 * AAD binds both envelopes to (scope, name): a ciphertext or wrapped
 * DEK copied onto another row fails to open.
 */

export const SECRET_REF_PREFIX = "vault:";

/** `vault:<id>` ref spelling consumers put in `secretRef` columns. */
export const secretRefFor = (id: number): string => `${SECRET_REF_PREFIX}${id}`;

/** Parse a `vault:<id>` ref → row id; null for anything else.
 * Canonical spelling only (`vault:` + ASCII digits) — `Number()`
 * coercion would accept `"vault: 1"`/`"vault:1e3"` and resolve a
 * different row than the caller spelled (C5 pen-test finding). */
export const parseSecretRef = (ref: string): number | null => {
	if (!ref.startsWith(SECRET_REF_PREFIX)) return null;
	const raw = ref.slice(SECRET_REF_PREFIX.length);
	if (!/^\d+$/.test(raw)) return null;
	const id = Number(raw);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export class SecretError extends Data.TaggedError("SecretError")<{
	readonly reason:
		| "not-found"
		| "tenant-mismatch"
		| "cipher-unavailable"
		| "decrypt-failed"
		| "invalid";
	readonly detail?: string;
}> {}

const PLATFORM_SCOPE = "platform";
const USER_SCOPE_PREFIX = "user:";
const userScope = (userId: string): string => `${USER_SCOPE_PREFIX}${userId}`;
const scopeOf = (tenantId: number | null, userId?: string | null): string =>
	userId != null && userId !== ""
		? userScope(userId)
		: tenantId === null
			? PLATFORM_SCOPE
			: String(tenantId);

const dekAad = (scope: string, name: string): string => `vault-dek:${scope}:${name}`;
const valueAad = (scope: string, name: string): string => `vault-secret:${scope}:${name}`;

// ── Repo functions (testable, no service context) ────────────────

export async function listSecrets(db: DbClient, scope: string): Promise<VaultSecret[]> {
	return db
		.select()
		.from(vaultSecret)
		.where(eq(vaultSecret.scope, scope))
		.orderBy(vaultSecret.name);
}

async function getSecretByName(
	db: DbClient,
	scope: string,
	name: string,
): Promise<VaultSecret | null> {
	const rows = await db
		.select()
		.from(vaultSecret)
		.where(and(eq(vaultSecret.scope, scope), eq(vaultSecret.name, name)))
		.limit(1);
	return rows[0] ?? null;
}

export async function getSecretById(db: DbClient, id: number): Promise<VaultSecret | null> {
	const rows = await db.select().from(vaultSecret).where(eq(vaultSecret.id, id)).limit(1);
	return rows[0] ?? null;
}

/** Atomic create-or-replace on (scope, name): a single
 * INSERT … ON CONFLICT DO UPDATE, so concurrent same-name puts
 * serialize on the unique index instead of the loser surfacing a
 * raw SQLite constraint defect. The update arm mirrors
 * replaceSecretMaterial: material columns are always replaced,
 * provider/kind/hint keep the stored value unless the caller
 * supplies one, `version` bumps. */
async function upsertSecret(
	db: DbClient,
	row: {
		readonly scope: string;
		readonly tenantId: number | null;
		readonly name: string;
		readonly provider?: string | null;
		readonly kind?: VaultSecretKind;
		readonly hint?: string | null;
		readonly wrappedDek: string;
		readonly ciphertext: string;
		readonly kekVersion: string | null;
		readonly createdBy: string | null;
	},
): Promise<VaultSecret> {
	const rows = await db
		.insert(vaultSecret)
		.values({
			scope: row.scope,
			tenantId: row.tenantId,
			hint: row.hint ?? null,
			name: row.name,
			provider: row.provider ?? null,
			kind: row.kind ?? "generic",
			wrappedDek: row.wrappedDek,
			ciphertext: row.ciphertext,
			kekVersion: row.kekVersion,
			createdBy: row.createdBy,
			status: "active",
			version: 1,
			createdAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [vaultSecret.scope, vaultSecret.name],
			set: {
				wrappedDek: row.wrappedDek,
				ciphertext: row.ciphertext,
				kekVersion: row.kekVersion,
				provider: row.provider ?? sql`${vaultSecret.provider}`,
				kind: row.kind ?? sql`${vaultSecret.kind}`,
				hint: row.hint !== undefined ? row.hint : sql`${vaultSecret.hint}`,
				version: sql`${vaultSecret.version} + 1`,
				updatedAt: new Date(),
			},
		})
		.returning();
	return rows[0]!;
}

/** Replace material columns on an existing row — bumps `version` and
 * stamps `rotated_at`. Metadata columns (provider/kind/hint) are
 * put-path concerns handled by upsertSecret; the sole caller here is
 * rotate, which reseals in place. */
async function replaceSecretMaterial(
	db: DbClient,
	input: {
		readonly id: number;
		readonly wrappedDek: string;
		readonly ciphertext: string;
		readonly kekVersion: string | null;
	},
): Promise<VaultSecret> {
	const rows = await db
		.update(vaultSecret)
		.set({
			wrappedDek: input.wrappedDek,
			ciphertext: input.ciphertext,
			kekVersion: input.kekVersion,
			version: sql`${vaultSecret.version} + 1`,
			updatedAt: new Date(),
			rotatedAt: new Date(),
		})
		.where(eq(vaultSecret.id, input.id))
		.returning();
	return rows[0]!;
}

async function deleteSecret(db: DbClient, id: number): Promise<void> {
	await db.delete(vaultSecret).where(eq(vaultSecret.id, id));
}

// ── Crypto helpers ───────────────────────────────────────────────

const cipherUnavailable = () =>
	new SecretError({ reason: "cipher-unavailable", detail: "no SecretKeyring driver bound" });

const asDecryptFailure = (e: unknown) =>
	new SecretError({
		reason: "decrypt-failed",
		detail: e instanceof Error ? e.message : String(e),
	});

/** Fresh DEK → wrapped envelope + value ciphertext. Returns the two
 * stored columns plus the kek fingerprint. */
const seal = async (
	keyring: SecretKeyringService,
	scope: string,
	name: string,
	value: string,
): Promise<{ wrappedDek: string; ciphertext: string; kekVersion: string }> => {
	const raw = new Uint8Array(await aead.exportDek(await aead.generateDek()));
	const wrappedDek = await keyring.wrapDek(raw, dekAad(scope, name));
	const valueKey = await aead.importDek(raw, ["encrypt"]);
	const ciphertext = await aead.encrypt(valueKey, value, { aad: valueAad(scope, name) });
	return { wrappedDek, ciphertext, kekVersion: keyring.kekVersion };
};

/** Open a stored row → plaintext. Throws SecretError on any failure —
 * tampered envelopes and missing keys are loud, never silent null. */
const open = async (keyring: SecretKeyringService, row: VaultSecret): Promise<string> => {
	try {
		const raw = await keyring.unwrapDek(row.wrappedDek, dekAad(row.scope, row.name));
		const valueKey = await aead.importDek(raw, ["decrypt"]);
		return await aead.decryptText(valueKey, row.ciphertext, {
			aad: valueAad(row.scope, row.name),
		});
	} catch (e) {
		throw e instanceof SecretError ? e : asDecryptFailure(e);
	}
};

// ── Authz ────────────────────────────────────────────────────────

/** Scope-aware gate shared by read/write — `scope` is the stored
 * scope string ("platform" | "user:<id>" | String(tenantId)).
 * platform → PlatformAdmin; user → the owning principal only (self
 * manages own secrets — the caller's plugin keeps its own grant);
 * tenant → bound-tenant admin (write) / member (read). */
const requireScopeAccess = (admin: PlatformAdminShape, scope: string, min: "admin" | "member") => {
	if (scope === PLATFORM_SCOPE) return admin.requireAdmin();
	if (scope.startsWith(USER_SCOPE_PREFIX)) {
		const owner = scope.slice(USER_SCOPE_PREFIX.length);
		return Effect.gen(function* () {
			const principal = yield* Principal;
			if (principal?.userId !== owner)
				return yield* Effect.fail(new Forbidden({ path: "vault.secret.user-scope" }));
		});
	}
	const tenantId = Number(scope);
	return Effect.gen(function* () {
		const tenant = yield* Tenant;
		if (tenant === null || Number(tenant.id) !== tenantId)
			return yield* Effect.fail(new SecretError({ reason: "tenant-mismatch" }));
		yield* requireTenantRole(min === "admin" ? "admin" : "member", `vault.secret.${min}`);
	});
};

// ── Service ──────────────────────────────────────────────────────

/** Wire shape — metadata only; ciphertext/key material never leaves. */
export interface SecretMeta {
	readonly id: number;
	readonly scope: string;
	readonly tenantId: number | null;
	readonly name: string;
	readonly provider: string | null;
	readonly kind: VaultSecretKind;
	readonly hint: string | null;
	readonly version: number;
	readonly status: string;
	readonly kekVersion: string | null;
	readonly createdBy: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date | null;
	readonly rotatedAt: Date | null;
}

const toMeta = (row: VaultSecret): SecretMeta => ({
	id: row.id,
	scope: row.scope,
	tenantId: row.tenantId,
	name: row.name,
	provider: row.provider,
	kind: row.kind as VaultSecretKind,
	hint: row.hint,
	version: row.version,
	status: row.status,
	kekVersion: row.kekVersion,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
	rotatedAt: row.rotatedAt,
});

/** Audit write — best-effort (Audit.record never fails by contract),
 * detail carries ids/metadata only, NEVER secret material. */
const recordAudit = (
	action: string,
	row: { readonly id: number; readonly scope: string; readonly name: string },
	detail?: Record<string, unknown>,
) =>
	Effect.gen(function* () {
		const audit = yield* Effect.serviceOption(Audit);
		if (Option.isNone(audit)) return;
		const tenantId = row.scope === PLATFORM_SCOPE ? null : Number(row.scope);
		yield* audit.value.record({
			action,
			targetType: "vault_secret",
			targetId: row.id,
			detail: { name: row.name, scope: row.scope, ...detail },
			tenantId: Number.isFinite(tenantId) ? tenantId : null,
		});
	});

export class Secrets extends Context.Service<
	Secrets,
	{
		/** Metadata list for a scope — never key material. */
		readonly list: (input: {
			readonly tenantId: number | null;
			/** Personal scope — `user:<id>` rows owned by this user.
			 * Wins over tenantId when both are set. */
			readonly userId?: string | null;
		}) => Effect.Effect<readonly SecretMeta[], SecretError | TenantForbidden | Forbidden>;
		/** Create or replace a secret's value (upsert on scope+name).
		 * Returns the row metadata; `secretRefFor(id)` is the ref. */
		readonly put: (input: {
			readonly tenantId: number | null;
			readonly userId?: string | null;
			readonly name: string;
			readonly value: string;
			readonly provider?: string | null;
			readonly kind?: VaultSecretKind;
			/** Non-secret display hint (e.g. last-4) stored for masked reads. */
			readonly hint?: string | null;
		}) => Effect.Effect<SecretMeta, SecretError | TenantForbidden | Forbidden>;
		/** THE read-back — `vault:<id>` refs only; other spellings and
		 * missing/disabled rows resolve null. Ungated by design (system
		 * callers); every call is audit-logged. Cipher failures are
		 * typed errors, never silent. */
		readonly resolve: (ref: string) => Effect.Effect<string | null, SecretError>;
		/** Re-wrap the DEK and re-encrypt the CURRENT value under a fresh
		 * DEK — value stays stable, version bumps. */
		readonly rotate: (input: {
			readonly id: number;
		}) => Effect.Effect<SecretMeta, SecretError | TenantForbidden | Forbidden>;
		/** Hard-delete a secret row. */
		readonly remove: (input: {
			readonly id: number;
		}) => Effect.Effect<void, SecretError | TenantForbidden | Forbidden>;
	}
>()("@ktb/vault/Secrets") {}

export const SecretsLive = Layer.effect(
	Secrets,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		const keyringOpt = yield* Effect.serviceOption(SecretKeyring);
		const keyring = Option.isSome(keyringOpt) ? keyringOpt.value : null;

		const requireKeyring = Effect.fn("Secrets.requireKeyring")(function* () {
			if (keyring === null) return yield* Effect.fail(cipherUnavailable());
			return keyring;
		});

		return Secrets.of({
			list: Effect.fn("Secrets.list")(function* (input) {
				const scope = scopeOf(input.tenantId, input.userId);
				yield* requireScopeAccess(platformAdmin, scope, "member");
				const rows = yield* Effect.promise(() => listSecrets(db, scope));
				return rows.map(toMeta);
			}),

			put: Effect.fn("Secrets.put")(function* (input) {
				const scope = scopeOf(input.tenantId, input.userId);
				yield* requireScopeAccess(platformAdmin, scope, "admin");
				const kr = yield* requireKeyring();
				const name = input.name.trim();
				if (name === "")
					return yield* Effect.fail(
						new SecretError({ reason: "invalid", detail: "name is empty" }),
					);
				if (input.value === "")
					return yield* Effect.fail(
						new SecretError({ reason: "invalid", detail: "value is empty" }),
					);
				const sealed = yield* Effect.tryPromise({
					try: () => seal(kr, scope, name, input.value),
					catch: asDecryptFailure,
				});
				const principal = yield* Effect.serviceOption(Principal);
				/* v8 ignore next -- Principal is a Context.Reference; serviceOption always yields Some */
				const createdBy = Option.isSome(principal) ? (principal.value?.userId ?? null) : null;
				// Pre-read is only for the audit label — the write itself
				// is a single atomic upsert, so a concurrent same-name put
				// cannot defect on the unique index. Under a true create
				// race the loser may be labelled "create" once; the row
				// outcome (last writer wins, version bumped) is correct.
				const existing = yield* Effect.promise(() => getSecretByName(db, scope, name));
				const row = yield* Effect.promise(() =>
					upsertSecret(db, {
						scope,
						tenantId: scope === String(input.tenantId) ? input.tenantId : null,
						hint: input.hint,
						name,
						provider: input.provider,
						kind: input.kind,
						wrappedDek: sealed.wrappedDek,
						ciphertext: sealed.ciphertext,
						kekVersion: sealed.kekVersion,
						createdBy,
					}),
				);
				yield* recordAudit(existing === null ? "vault.secret.create" : "vault.secret.update", row, {
					provider: row.provider,
					kind: row.kind,
					version: row.version,
				});
				return toMeta(row);
			}),

			resolve: Effect.fn("Secrets.resolve")(function* (ref) {
				const id = parseSecretRef(ref);
				if (id === null) return null;
				const row = yield* Effect.promise(() => getSecretById(db, id));
				if (row === null || row.status !== "active") return null;
				yield* recordAudit("vault.secret.resolve", row);
				const kr = yield* requireKeyring();
				return yield* Effect.tryPromise({ try: () => open(kr, row), catch: asDecryptFailure });
			}),

			rotate: Effect.fn("Secrets.rotate")(function* (input) {
				const row = yield* Effect.promise(() => getSecretById(db, input.id));
				if (row === null) return yield* Effect.fail(new SecretError({ reason: "not-found" }));
				yield* requireScopeAccess(platformAdmin, row.scope, "admin");
				const kr = yield* requireKeyring();
				// Open under the OLD material, reseal under a fresh DEK.
				const value = yield* Effect.tryPromise({
					try: () => open(kr, row),
					catch: asDecryptFailure,
				});
				const sealed = yield* Effect.tryPromise({
					try: () => seal(kr, row.scope, row.name, value),
					catch: asDecryptFailure,
				});
				const updated = yield* Effect.promise(() =>
					replaceSecretMaterial(db, {
						id: row.id,
						wrappedDek: sealed.wrappedDek,
						ciphertext: sealed.ciphertext,
						kekVersion: sealed.kekVersion,
					}),
				);
				yield* recordAudit("vault.secret.rotate", updated, { version: updated.version });
				return toMeta(updated);
			}),

			remove: Effect.fn("Secrets.remove")(function* (input) {
				const row = yield* Effect.promise(() => getSecretById(db, input.id));
				if (row === null) return yield* Effect.fail(new SecretError({ reason: "not-found" }));
				yield* requireScopeAccess(platformAdmin, row.scope, "admin");
				yield* Effect.promise(() => deleteSecret(db, row.id));
				yield* recordAudit("vault.secret.remove", row);
			}),
		});
	}),
);
