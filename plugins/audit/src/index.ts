import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { and, asc, count, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { ScrollTextIcon } from "lucide-react";
import * as Option from "effect/Option";

import { Forbidden, Principal } from "@ktb/authz";
import { contentHash } from "@ktb/crypto/digest";
import { Db, type DbClient } from "@ktb/db";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";
import { Permissions } from "@ktb/rbac";
import { Tenant, tenantScopeId } from "@ktb/tenant";

import { AuditPlatformPage } from "./platform-page.tsx";
import { auditConfig, auditConfigSchema } from "./config.tsx";
import { adminAudit, type AdminAudit } from "./schema.ts";
// Relative import on purpose: `@ktb/consultations` depends on
// `@ktb/audit` (the Audit service its mutations record through), so a
// package-specifier import here would create a workspace cycle — same
// rule as the groups import in ./schema.ts. The schema module is
// dependency-free, so the cycle stays broken.
import { consultations } from "../../consultations/src/schema.ts";

export type { AdminAudit };
export { adminAudit } from "./schema.ts";

/** Console row: the stored audit entry (detail stays raw JSON text —
 * the view parses it for display). */
export type AdminAuditRow = AdminAudit;

/** What a mutation reports to the audit log. `action` is a
 * dot-namespaced verb ("users.suspend"); `detail` must contain ids and
 * non-sensitive params only — never secrets, tokens, transcripts or
 * PHI. */
export interface AuditEntryInput {
	readonly action: string;
	readonly targetType?: string | null;
	readonly targetId?: string | number | null;
	readonly detail?: Readonly<Record<string, unknown>> | null;
	/** Tenant (`groups.id`) scope of the action — string|number accepted
	 * like the other tenant-id carriers; non-numeric values normalize to
	 * NULL rather than failing the write. */
	readonly tenantId?: string | number | null;
}

export interface AuditListResult {
	/** Newest-first page of entries (capped by `limit`). */
	readonly entries: readonly AdminAuditRow[];
	/** Total rows in the log — the page renders "latest N of total". */
	readonly total: number;
	readonly limit: number;
}

/** Outcome of walking the tamper-evident audit chain (T-139). */
export interface AuditVerifyResult {
	/** "verified" = every link holds; "tampered" = a rewrite was detected;
	 * "empty" = the log has no rows. */
	readonly status: "verified" | "tampered" | "empty";
	readonly entries: number;
	/** Id of the first row whose chain link broke, when tampered. */
	readonly brokenAt: number | null;
}

/** Detail payloads are ids/flags — cap the JSON so a caller cannot
 * smuggle an unbounded blob into the log. */
const DETAIL_MAX = 4000;

// ---------- detail safety (P-087 D1) ----------

/** Plugin id whose `plugin_state` row carries this service's runtime
 * config (D5) — kept in sync with `auditServicesPlugin.id` below. */
const AUDIT_SERVICES_PLUGIN_ID = "audit.services";

const DEFAULT_READ_COALESCE_MS = 60000;

/** Resolved runtime config for the write path — see config.tsx for the
 * contract. `readCoalesceMs` 0 disables read coalescing. */
interface AuditRuntimeConfig {
	readonly enabled: boolean;
	readonly readsEnabled: boolean;
	readonly readCoalesceMs: number;
}

const DEFAULT_AUDIT_CONFIG: AuditRuntimeConfig = {
	enabled: true,
	readsEnabled: true,
	readCoalesceMs: DEFAULT_READ_COALESCE_MS,
};

/**
 * PHI/secret key blocklist for audit `detail` payloads (P-087 D1).
 * SUBSTRING match (deliberately not `\b`) so camelCase keys like
 * `patientName`/`fileName` are caught — over-redaction is acceptable,
 * under-redaction is not. Call-site audit (2026-11): legit keys that
 * must survive — `patientId`, `ownerId`, `hadAudio`, `engine`, `via`,
 * `status`, `source`, `reason`, `slug`, `kind`, `role`, `memberKind`,
 * `memberId`, `subjectKind`, `subjectId`, `roleId`, `userId`,
 * `resource`, `action`, `effect`, `description`, `meta`, `size`,
 * `backfilled`, `remaining` — none contain a blocked substring.
 * Known accepted losses (still recorded as ids/flags elsewhere):
 * rbac role `name`/`roleName`/`description.meta` keys containing
 * "name" are dropped (role names are admin-authored but the sanitizer
 * cannot distinguish them from patient names), and
 * `consultations.audio.attach`'s `contentType` is dropped ("content"
 * substring) — `size` survives only when nested under a non-blocked
 * key. Both are over-redaction by design.
 */
const DETAIL_KEY_BLOCKLIST = [
	"name",
	"email",
	"phone",
	"cpf",
	"cnpj",
	"birth",
	"dob",
	"address",
	"transcript",
	"anamnesis",
	"diagnos",
	"prescri",
	"exam",
	"note",
	"content",
	"text",
	"body",
	"message",
	"token",
	"secret",
	"password",
	"key",
	"dek",
	"payload",
	"filename",
] as const;

const DETAIL_MAX_DEPTH = 4;
const DETAIL_MAX_ARRAY = 20;
const DETAIL_MAX_STRING = 200;

/** Sentinel for "drop this value" inside the recursive sanitizer —
 * distinct from `undefined` so array holes stay representable. */
const DETAIL_DROP = Symbol("audit.detail.drop");

const detailKeyBlocked = (key: string): boolean => {
	const lower = key.toLowerCase();
	return DETAIL_KEY_BLOCKLIST.some((blocked) => lower.includes(blocked));
};

const sanitizeAuditValue = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
	if (value === null) return null;
	switch (typeof value) {
		case "string":
			return value.length > DETAIL_MAX_STRING ? value.slice(0, DETAIL_MAX_STRING) : value;
		case "number":
			// NaN/±Infinity are not JSON-safe — JSON.stringify would emit
			// null anyway; normalize eagerly so the stored text is honest.
			return Number.isFinite(value) ? value : null;
		case "boolean":
			return value;
		case "bigint":
			// JSON.stringify throws on bigint — coerce to string.
			return value.toString();
		case "undefined":
		case "function":
		case "symbol":
			return DETAIL_DROP;
		case "object":
			break;
	}
	const obj = value as Record<string, unknown>;
	if (seen.has(obj)) return DETAIL_DROP; // circular reference
	if (depth >= DETAIL_MAX_DEPTH) return DETAIL_DROP;
	seen.add(obj);
	try {
		// Honor toJSON (Date → ISO string, etc.) before structural
		// recursion — same depth: it is a serialization, not nesting.
		const toJson = (obj as { toJSON?: unknown }).toJSON;
		if (typeof toJson === "function") {
			return sanitizeAuditValue((toJson as () => unknown).call(obj), depth, seen);
		}
		if (Array.isArray(obj)) {
			const out: unknown[] = [];
			for (const item of obj.slice(0, DETAIL_MAX_ARRAY)) {
				const clean = sanitizeAuditValue(item, depth + 1, seen);
				if (clean !== DETAIL_DROP) out.push(clean);
			}
			return out;
		}
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(obj)) {
			if (detailKeyBlocked(key)) continue;
			const clean = sanitizeAuditValue(entry, depth + 1, seen);
			if (clean !== DETAIL_DROP) out[key] = clean;
		}
		return out;
	} finally {
		seen.delete(obj);
	}
};

/**
 * Recursively sanitize an audit `detail` payload before serialization
 * (P-087 D1): drops blocklisted keys at ANY depth, caps nesting
 * ({@link DETAIL_MAX_DEPTH}), array length ({@link DETAIL_MAX_ARRAY})
 * and string length ({@link DETAIL_MAX_STRING}), coerces/drops
 * non-JSON-safe values (bigint→string, NaN/Infinity→null,
 * undefined/function/symbol/circular→dropped). Returns `null` when
 * nothing survives — an emptied detail records as SQL NULL, not "{}".
 */
export const sanitizeAuditDetail = (
	detail: AuditEntryInput["detail"],
): Record<string, unknown> | null => {
	if (detail === null || detail === undefined) return null;
	const clean = sanitizeAuditValue(detail, 0, new WeakSet());
	if (
		clean === DETAIL_DROP ||
		clean === null ||
		typeof clean !== "object" ||
		Array.isArray(clean)
	) {
		return null;
	}
	return Object.keys(clean).length === 0 ? null : (clean as Record<string, unknown>);
};

/** `tenant_id` columns hold `groups.id` integers; rbac subject rows
 * carry the same id as text — normalize both shapes, drop the rest. */
const normalizeTenantId = (value: string | number | null | undefined): number | null => {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return Number.isInteger(value) ? value : null;
	const n = Number(value);
	return value.trim() !== "" && Number.isInteger(n) ? n : null;
};

const serializeDetail = (detail: AuditEntryInput["detail"]): string | null => {
	// D1: recursive PHI/secret-key sanitizer runs BEFORE the size cap —
	// an oversized-but-sensitive payload is redacted first, then the
	// surviving ids/flags are length-capped.
	const clean = sanitizeAuditDetail(detail);
	if (clean === null) return null;
	const json = JSON.stringify(clean);
	return json.length > DETAIL_MAX ? json.slice(0, DETAIL_MAX) : json;
};

/**
 * Chain hash over a stored audit row (T-139): canonical SHA-256 of the
 * row's content fields INCLUDING its own `prevHash`, so each hash
 * commits to the whole history behind it. Timestamps hash as epoch ms
 * (ISO strings would re-format differently across drivers).
 */
export const auditEntryHash = (row: AdminAudit): Promise<string> =>
	contentHash({
		actorUserId: row.actorUserId,
		actorEmail: row.actorEmail,
		action: row.action,
		targetType: row.targetType,
		targetId: row.targetId,
		detail: row.detail,
		tenantId: row.tenantId,
		prevHash: row.prevHash,
		createdAt: row.createdAt.getTime(),
	});

/**
 * Append one audit row. Actor identity comes from the bound `Principal`
 * (null in system contexts — the columns are nullable for that case):
 * `actorUserId` records the signed-in actor (`actorId ?? userId`), so a
 * secretary acting on a doctor's behalf is attributed to themselves;
 * `actorEmail` is the session email, which `runAs` binds to the actor.
 * `prevHash` chains the new row to the latest entry (`auditEntryHash`
 * over it); concurrent inserts may interleave links — same accepted
 * trade-off as record_versions. Returns the inserted row, or null when
 * the driver yields no RETURNING row.
 */
export async function insertAuditEntry(
	db: DbClient,
	entry: AuditEntryInput & {
		readonly actorUserId: string | null;
		readonly actorEmail: string | null;
	},
): Promise<AdminAudit | null> {
	const prev = await db.select().from(adminAudit).orderBy(desc(adminAudit.id)).limit(1);
	const rows = await db
		.insert(adminAudit)
		.values({
			actorUserId: entry.actorUserId,
			actorEmail: entry.actorEmail,
			action: entry.action,
			targetType: entry.targetType ?? null,
			targetId: entry.targetId == null ? null : String(entry.targetId),
			detail: serializeDetail(entry.detail),
			tenantId: normalizeTenantId(entry.tenantId),
			prevHash: prev[0] ? await auditEntryHash(prev[0]) : null,
			createdAt: new Date(),
		})
		.returning();
	return rows[0] ?? null;
}

/**
 * Read-event coalescing probe (P-087 D3): true when an identical
 * `(actorUserId, action, targetType, targetId)` row already exists with
 * `created_at` inside the trailing `windowMs`. NULL columns compare
 * with `IS NULL` (drizzle `isNull`) — a null-actor system read
 * coalesces against other null-actor reads, never against user reads.
 * `targetId` is compared as TEXT, the same normalization
 * {@link insertAuditEntry} applies (`String(...)` or NULL). Served by
 * the `admin_audit_dedupe_idx` composite index.
 */
export async function hasRecentAuditRead(
	db: DbClient,
	key: {
		readonly actorUserId: string | null;
		readonly action: string;
		readonly targetType: string | null;
		readonly targetId: string | null;
	},
	windowMs: number,
): Promise<boolean> {
	const since = new Date(Date.now() - windowMs);
	const rows = await db
		.select({ id: adminAudit.id })
		.from(adminAudit)
		.where(
			and(
				key.actorUserId === null
					? isNull(adminAudit.actorUserId)
					: eq(adminAudit.actorUserId, key.actorUserId),
				eq(adminAudit.action, key.action),
				key.targetType === null
					? isNull(adminAudit.targetType)
					: eq(adminAudit.targetType, key.targetType),
				key.targetId === null ? isNull(adminAudit.targetId) : eq(adminAudit.targetId, key.targetId),
				gte(adminAudit.createdAt, since),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/**
 * Walk the whole log oldest→newest and re-derive every chain link:
 * row n's `prev_hash` must equal `auditEntryHash(row n−1)`. Rows
 * predating the column form an unchained legacy PREFIX — a NULL
 * `prev_hash` is legitimate until the first chained row, after which
 * every row must link. The first bad link short-circuits the walk and
 * reports the tampered row's id.
 */
export async function verifyAuditChain(db: DbClient): Promise<AuditVerifyResult> {
	const rows = await db.select().from(adminAudit).orderBy(asc(adminAudit.id));
	if (rows.length === 0) return { status: "empty", entries: 0, brokenAt: null };
	let previous: AdminAudit | null = null;
	let chained = false;
	for (const row of rows) {
		if (row.prevHash === null) {
			if (chained) return { status: "tampered", entries: rows.length, brokenAt: row.id };
		} else {
			const expected = previous === null ? null : await auditEntryHash(previous);
			if (row.prevHash !== expected) {
				return { status: "tampered", entries: rows.length, brokenAt: row.id };
			}
			chained = true;
		}
		previous = row;
	}
	return { status: "verified", entries: rows.length, brokenAt: null };
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

/** Shared page-size clamp for the admin and tenant listings. */
const pageLimit = (limit: number | undefined): number =>
	Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

/**
 * Newest-first audit listing for the /platform/audit console. Callers
 * MUST have passed the `PlatformAdmin` gate first — the repo function
 * itself is unauthenticated, like the other `*Admin` helpers.
 */
export async function listAuditEntries(
	db: DbClient,
	options: { readonly limit?: number } = {},
): Promise<AuditListResult> {
	const limit = pageLimit(options.limit);
	const [entries, totals] = await Promise.all([
		db
			.select()
			.from(adminAudit)
			.orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
			.limit(limit),
		db.select({ n: count() }).from(adminAudit),
	]);
	return { entries, total: totals[0]?.n ?? 0, limit };
}

/**
 * Newest-first audit listing scoped to ONE tenant (P-080) — the staff
 * activity feed the clinician plugin mounts at
 * /portal/clinician/activity. Same ordering and
 * limit clamp as {@link listAuditEntries} but fenced by
 * `tenant_id = tenantId`; platform-global rows (`tenant_id` NULL) are
 * excluded — they stay admin-only. Callers MUST have resolved tenant
 * scope and the `audit.read` grant first — the repo function itself is
 * unauthenticated, like the other `*Admin` helpers.
 */
export async function listTenantAuditEntries(
	db: DbClient,
	tenantId: number,
	options: { readonly limit?: number } = {},
): Promise<AuditListResult> {
	const limit = pageLimit(options.limit);
	const [entries, totals] = await Promise.all([
		db
			.select()
			.from(adminAudit)
			.where(eq(adminAudit.tenantId, tenantId))
			.orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
			.limit(limit),
		db.select({ n: count() }).from(adminAudit).where(eq(adminAudit.tenantId, tenantId)),
	]);
	return { entries, total: totals[0]?.n ?? 0, limit };
}

/**
 * Newest-first audit listing scoped to ONE patient record (P-086) —
 * the patient portal's access log. NOT tenant-scoped: a patient may
 * have records in several clinics, so the fence is the record itself.
 * A row matches when it names the patient directly
 * (`target_type='patient'` + `target_id=<id>`), or names one of the
 * patient's consultations — live ones join through
 * `consultations.patient_id`, deleted ones through the `patientId`
 * stamped into `detail` at delete time (`json_extract` on the TEXT
 * column behind a `json_valid` guard — raw `json_extract` errors on
 * malformed JSON; NULL detail simply never matches). Same
 * ordering and limit clamp as {@link listTenantAuditEntries}. Callers
 * MUST have passed the `PatientAuditAccess` check first — the repo
 * function itself is unauthenticated, like the other `*Admin` helpers.
 */
export async function listPatientAuditEntries(
	db: DbClient,
	patientId: number,
	options: { readonly limit?: number } = {},
): Promise<AuditListResult> {
	const limit = pageLimit(options.limit);
	// `target_id` is TEXT while `consultations.id`/`detail.patientId`
	// are integers — CAST keeps the comparison type-exact.
	const scope = or(
		and(eq(adminAudit.targetType, "patient"), eq(adminAudit.targetId, String(patientId))),
		and(
			eq(adminAudit.targetType, "consultation"),
			inArray(
				adminAudit.targetId,
				db
					.select({ id: sql<string>`CAST(${consultations.id} AS TEXT)` })
					.from(consultations)
					.where(eq(consultations.patientId, patientId)),
			),
		),
		and(
			eq(adminAudit.targetType, "consultation"),
			// json_extract ERRORS on malformed JSON (unlike a NULL
			// yield) — the CASE guards it; NULL detail → json_valid
			// NULL → ELSE branch → no match.
			sql`CASE WHEN json_valid(${adminAudit.detail}) THEN json_extract(${adminAudit.detail}, '$.patientId') END = ${patientId}`,
		),
	);
	const [entries, totals] = await Promise.all([
		db
			.select()
			.from(adminAudit)
			.where(scope)
			.orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
			.limit(limit),
		db.select({ n: count() }).from(adminAudit).where(scope),
	]);
	return { entries, total: totals[0]?.n ?? 0, limit };
}

/**
 * OPTIONAL patient-side authorization for {@link Audit.patientList}
 * (P-086) — consumer-defined like `Permissions`: the patient-access
 * plugin provides the live layer, and implementations read the bound
 * `Principal` themselves per call (the service is request-scoped).
 * Absent ⇒ `patientList` fails closed.
 */
export class PatientAuditAccess extends Context.Service<
	PatientAuditAccess,
	{
		/** Whether the bound principal may view `patientId`'s audit feed. */
		readonly canView: (patientId: number) => Effect.Effect<boolean>;
	}
>()("@ktb/audit/PatientAuditAccess") {}

/**
 * Audit domain port — the write side every admin mutation calls plus
 * the admin-gated read behind /platform/audit.
 *
 * `record` NEVER fails: an audit write must not take down the mutation
 * it describes, so insert errors and defects are logged and swallowed
 * (`Effect.catchCause`). Consumers resolve it via
 * `Effect.serviceOption(Audit)` — the audit plugin may be absent and
 * mutations must still work (same contract as `PermissionInvalidator`).
 * `adminList`/`adminVerify` re-check the `PlatformAdmin` gate.
 *
 * `activityAccess`/`activityList` are the tenant-scoped staff feed
 * (P-080): they resolve the bound `Tenant` to its `groups.id` scope and
 * ask the OPTIONAL `Permissions` port for `audit.read` on that tenant —
 * resolved via `serviceOption` per call (no dep edge: rbac already
 * depends on audit transitively through groups, so a declared edge
 * would cycle). Absent tenant scope or absent Permissions both fail
 * closed, matching `can`'s null-principal behaviour.
 *
 * `patientList` is the patient-facing feed (P-086): NOT tenant-scoped
 * — a patient may have records across clinics — so authorization is
 * the OPTIONAL `PatientAuditAccess` port's per-record `canView`,
 * resolved via `serviceOption` per call (same no-dep-edge rule: the
 * patient-access plugin provides it). Absent port or a denied check
 * fails closed with `Forbidden({ path: "audit.patient" })`.
 */
export class Audit extends Context.Service<
	Audit,
	{
		readonly record: (entry: AuditEntryInput) => Effect.Effect<void>;
		readonly adminList: (options?: {
			readonly limit?: number;
		}) => Effect.Effect<AuditListResult, Forbidden>;
		/** Tamper-evident chain walk over the whole log — platform admins only. */
		readonly adminVerify: () => Effect.Effect<AuditVerifyResult, Forbidden>;
		/** Whether the bound tenant may read its own activity feed —
		 * false (fail closed) without tenant scope or Permissions. */
		readonly activityAccess: () => Effect.Effect<boolean>;
		/** Tenant-scoped newest-first feed; `Forbidden` when
		 * {@link activityAccess} would be false. */
		readonly activityList: (options?: {
			readonly limit?: number;
		}) => Effect.Effect<AuditListResult, Forbidden>;
		/** Patient-scoped newest-first feed (P-086): entries naming the
		 * patient's own record across every tenant. `Forbidden` when the
		 * optional {@link PatientAuditAccess} port is absent or denies —
		 * fail closed, never tenant-scoped. */
		readonly patientList: (options: {
			readonly patientId: number;
			readonly limit?: number;
		}) => Effect.Effect<AuditListResult, Forbidden>;
	}
>()("@ktb/audit/Audit") {}

export const AuditLive = Layer.effect(
	Audit,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		/** Runtime config (P-087 D5), resolved PER CALL through
		 * `PluginStates.config("audit.services")` so /platform/plugins
		 * edits apply without a restart (one `plugin_state` row read per
		 * record — record is not a hot path). PluginStates merges stored
		 * JSON over the manifest defaults; the Schema decode below is a
		 * tolerant re-validation — reads never reject, so a corrupt row
		 * or absent service falls back to DEFAULT_AUDIT_CONFIG.
		 * `serviceOption` keeps AuditLive's requirements unchanged:
		 * tests/non-app contexts simply get the defaults. */
		const configNow = Effect.gen(function* () {
			const states = yield* Effect.serviceOption(PluginStates);
			if (Option.isNone(states)) return DEFAULT_AUDIT_CONFIG;
			const raw = yield* states.value
				.config(AUDIT_SERVICES_PLUGIN_ID)
				.pipe(Effect.catch(() => Effect.succeed(null)));
			const decoded = Schema.decodeUnknownResult(auditConfigSchema)(raw ?? {});
			if (Result.isFailure(decoded)) return DEFAULT_AUDIT_CONFIG;
			return {
				enabled: decoded.success.enabled ?? true,
				readsEnabled: decoded.success.readsEnabled ?? true,
				readCoalesceMs: decoded.success.readCoalesceMs ?? DEFAULT_READ_COALESCE_MS,
			};
		});
		/** Shared scope resolution for the staff feed: the bound tenant's
		 * `groups.id` when `audit.read` is granted on it, else null. Read
		 * per call — `Tenant` is request-scoped and `Permissions` may be
		 * absent entirely (rbac plugin disabled). */
		const activityScope = Effect.gen(function* () {
			const scopeId = tenantScopeId(yield* Tenant);
			if (scopeId === null) return null;
			const permissions = yield* Effect.serviceOption(Permissions);
			if (Option.isNone(permissions)) return null;
			const allowed = yield* permissions.value.can("audit", "read", { tenantId: scopeId });
			return allowed ? scopeId : null;
		});
		return Audit.of({
			/** `*.read` convention (P-087 D2/D3): read events coalesce —
			 * skip the insert when an identical (actor, action, target)
			 * row landed inside `readCoalesceMs`. Mutations never
			 * coalesce. Probe and insert share one caught promise: a
			 * lookup failure skips THIS write into the same warning log
			 * as an insert failure — record still never fails. */
			record: Effect.fn("Audit.record")(function* (entry: AuditEntryInput) {
				const config = yield* configNow;
				if (!config.enabled) return;
				const isRead = entry.action.endsWith(".read");
				if (isRead && !config.readsEnabled) return;
				const principal = yield* Principal;
				const actorUserId = principal === null ? null : (principal.actorId ?? principal.userId);
				const coalesce =
					isRead && config.readCoalesceMs > 0
						? {
								actorUserId,
								action: entry.action,
								targetType: entry.targetType ?? null,
								targetId: entry.targetId == null ? null : String(entry.targetId),
								windowMs: config.readCoalesceMs,
							}
						: null;
				yield* Effect.promise(async () => {
					if (coalesce !== null && (await hasRecentAuditRead(db, coalesce, coalesce.windowMs))) {
						return;
					}
					await insertAuditEntry(db, {
						...entry,
						actorUserId,
						actorEmail: principal?.email ?? null,
					});
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("admin audit write failed", {
							action: entry.action,
							cause: String(cause),
						}),
					),
				);
			}),
			adminList: Effect.fn("Audit.adminList")(function* (options?: { limit?: number }) {
				yield* platformAdmin.requireAdmin();
				return yield* Effect.promise(() => listAuditEntries(db, options));
			}),
			adminVerify: Effect.fn("Audit.adminVerify")(function* () {
				yield* platformAdmin.requireAdmin();
				return yield* Effect.promise(() => verifyAuditChain(db));
			}),
			activityAccess: Effect.fn("Audit.activityAccess")(function* () {
				return (yield* activityScope) !== null;
			}),
			activityList: Effect.fn("Audit.activityList")(function* (options?: { limit?: number }) {
				const scopeId = yield* activityScope;
				if (scopeId === null) {
					return yield* Effect.fail(new Forbidden({ path: "rbac.audit.read" }));
				}
				return yield* Effect.promise(() => listTenantAuditEntries(db, scopeId, options));
			}),
			patientList: Effect.fn("Audit.patientList")(function* (options: {
				patientId: number;
				limit?: number;
			}) {
				const access = yield* Effect.serviceOption(PatientAuditAccess);
				if (Option.isNone(access)) {
					return yield* Effect.fail(new Forbidden({ path: "audit.patient" }));
				}
				const allowed = yield* access.value.canView(options.patientId);
				if (!allowed) {
					return yield* Effect.fail(new Forbidden({ path: "audit.patient" }));
				}
				return yield* Effect.promise(() =>
					listPatientAuditEntries(db, options.patientId, { limit: options.limit }),
				);
			}),
		});
	}),
);

/**
 * One-line write helper for instrumented admin mutations:
 * `yield* audit({ action: "users.suspend", ... })`. Resolves the Audit
 * service via `serviceOption` per call — a no-op when the audit plugin
 * is absent, and `Audit.record` itself swallows write failures, so an
 * audit problem can never fail the mutation it describes.
 */
export const audit = (entry: AuditEntryInput): Effect.Effect<void> =>
	Effect.flatMap(Effect.serviceOption(Audit), (option) =>
		Option.isSome(option) ? option.value.record(entry) : Effect.void,
	);

// Re-exported for tests: a DDL snippet that creates admin_audit in the
// in-memory better-sqlite3 test databases of instrumented plugins.
export const AUDIT_TEST_DDL = `
CREATE TABLE admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT, actor_email TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, tenant_id INTEGER, prev_hash TEXT, created_at INTEGER NOT NULL);
CREATE INDEX admin_audit_created_at_idx ON admin_audit (created_at);
CREATE INDEX admin_audit_action_idx ON admin_audit (action);
CREATE INDEX admin_audit_actor_idx ON admin_audit (actor_user_id);
CREATE INDEX admin_audit_tenant_created_idx ON admin_audit (tenant_id, created_at);
CREATE INDEX admin_audit_dedupe_idx ON admin_audit (actor_user_id, action, target_type, target_id, created_at);
`;

export const auditTablesPlugin = definePlugin({
	id: "audit.tables",
	tables: { adminAudit },
});

export const auditServicesPlugin = definePlugin({
	id: "audit.services",
	// adminList consumes the PlatformAdmin gate — the dep edge keeps the
	// platform module ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	meta: {
		name: "Audit",
		description: "Append-only admin audit log with hash-chained entries",
		icon: ScrollTextIcon,
		config: auditConfig,
	},
	// Server-only validation schema — the JSON doc on meta.config is its
	// projection; PluginStates decodes config JSON against this, and
	// AuditLive re-decodes stored config per record() call (D5).
	configSchema: auditConfigSchema,
	services: AuditLive,
});

// Chrome contribution (P-060): the console sidebar entry lives in the
// `portal.sidebar` chrome region; the dep edge orders it after the
// shell like the retired panel entry.
export const auditChromePlugin = definePlugin({
	id: "audit.chrome",
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "audit.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/audit",
					label: "Audit log",
					icon: ScrollTextIcon,
					group: "Governance",
				},
			},
		},
	],
});

// Panel (system console) contribution: /platform/audit is mounted by
// the platform plugin's physical route subtree; this plugin declares
// the page descriptor. The dep edge orders it after the shell and the
// audit services its loader consumes.
export const auditPanelPlugin = definePlugin({
	id: "audit.panel",
	requiredDeps: [platformPanelPlugin.id, auditServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "audit.admin",
				path: "/platform/audit",
				component: AuditPlatformPage,
				// Hard 404 for non-admins — same contract as the /platform
				// layout guard; the service re-checks anyway.
				guard: () =>
					Effect.gen(function* () {
						const platformAdmin = yield* PlatformAdmin;
						return yield* platformAdmin.requireAdmin().pipe(
							Effect.as(true),
							Effect.catchTag("Forbidden", () => Effect.succeed(false)),
						);
					}),
				loader: () =>
					Effect.gen(function* () {
						const audit = yield* Audit;
						const empty: AuditListResult = { entries: [], total: 0, limit: 200 };
						return yield* audit
							.adminList()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(empty)));
					}),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	auditTablesPlugin,
	auditServicesPlugin,
	auditChromePlugin,
	auditPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"audit.tables": true;
		"audit.services": true;
		"audit.chrome": true;
		"audit.panel": true;
	}
}
