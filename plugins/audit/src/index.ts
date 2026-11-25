import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	like,
	lte,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import { ScrollTextIcon } from "lucide-react";
import * as Option from "effect/Option";

import { DoctorProfiles, type DoctorProfile } from "@ktb/auth";
import { Forbidden, Principal } from "@ktb/authz";
import { contentHash } from "@ktb/crypto/digest";
import { Db, type DbClient } from "@ktb/db";
// `consultations` comes from the composed schema, NOT
// `@ktb/consultations/schema`: consultations depends on @ktb/audit, so
// a package-specifier import of the plugin would create a workspace
// cycle. @ktb/db sits below the plugin system and re-exports the same
// table object via the generated schema.gen.ts.
import { consultations } from "@ktb/db/schema";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";

import { AuditPlatformPage } from "./platform-page.tsx";
import { auditConfig, auditConfigSchema } from "./config.tsx";
import { adminAudit, type AdminAudit } from "./schema.ts";

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
	/** Newest-first page of entries (capped by `limit`, offset window). */
	readonly entries: readonly AdminAuditRow[];
	/** Total rows matching the query — the page renders "N of total". */
	readonly total: number;
	readonly limit: number;
	/** Resolved offset the page was read at (clamped >= 0). */
	readonly offset: number;
}

/**
 * Server-side listing filters shared by the admin console, the tenant
 * activity feed and the patient access log. Every field is optional —
 * absent means "no filter". `actor`/`targetType` accept an explicit
 * `null` to select the NULL-column bucket (system actor / no target);
 * a string matches exactly. `actionGroup` matches the action's first
 * dot segment ("users" covers "users.suspend"). `q` is a case-insensitive
 * substring probe across actor, action, target and detail. `since` /
 * `until` are epoch-millisecond bounds on `created_at` (inclusive).
 */
export interface AuditListQuery {
	readonly limit?: number;
	readonly offset?: number;
	readonly actionGroup?: string | null;
	readonly actor?: string | null;
	readonly targetType?: string | null;
	readonly q?: string | null;
	readonly since?: number | null;
	readonly until?: number | null;
}

/** Distinct filter values for the audit UI's dropdowns, scoped by the
 * same WHERE the listing applies. `actors`/`targetTypes` carry `null`
 * for the NULL-column bucket (system actor / no target) — the same
 * semantics {@link AuditListQuery.actor}/{@link AuditListQuery.targetType}
 * accept. */
export interface AuditFacets {
	readonly actionGroups: readonly string[];
	readonly actors: readonly (string | null)[];
	readonly targetTypes: readonly (string | null)[];
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

/** Shared offset clamp — negative/NaN offsets collapse to the first page. */
const pageOffset = (offset: number | undefined): number => {
	if (offset === undefined || !Number.isFinite(offset)) return 0;
	return Math.max(0, Math.trunc(offset));
};

/** LIKE metacharacters are stripped from caller-supplied filter text —
 * audit search is substring probing, not pattern matching, and an
 * unescaped `%`/`_` would silently widen the match. */
const likeTerm = (value: string): string => value.replace(/[%_\\]/g, "");

/**
 * WHERE clause shared by the three audit listings. `undefined` fields
 * add no condition; explicit `null` on `actor`/`targetType` selects the
 * NULL bucket. Actor matching mirrors the view's `actorKey` fallback:
 * the display actor is `actor_email ?? actor_user_id ?? system`, so a
 * string actor matches the email column OR (email NULL AND user id
 * equal) — never both-null rows, which only `actor: null` selects.
 */
const auditListWhere = (query: AuditListQuery) => {
	const conditions = [];
	if (query.actionGroup != null && query.actionGroup !== "") {
		const group = likeTerm(query.actionGroup);
		if (group !== "") {
			conditions.push(or(eq(adminAudit.action, group), like(adminAudit.action, `${group}.%`)));
		}
	}
	if (query.actor !== undefined) {
		conditions.push(
			query.actor === null
				? and(isNull(adminAudit.actorEmail), isNull(adminAudit.actorUserId))
				: or(
						eq(adminAudit.actorEmail, query.actor),
						and(isNull(adminAudit.actorEmail), eq(adminAudit.actorUserId, query.actor)),
					),
		);
	}
	if (query.targetType !== undefined) {
		conditions.push(
			query.targetType === null
				? isNull(adminAudit.targetType)
				: eq(adminAudit.targetType, query.targetType),
		);
	}
	if (query.q != null && query.q.trim() !== "") {
		const term = `%${likeTerm(query.q.trim())}%`;
		conditions.push(
			or(
				like(adminAudit.actorEmail, term),
				like(adminAudit.actorUserId, term),
				like(adminAudit.action, term),
				like(adminAudit.targetId, term),
				like(adminAudit.detail, term),
			),
		);
	}
	if (query.since != null && Number.isFinite(query.since)) {
		conditions.push(gte(adminAudit.createdAt, new Date(query.since)));
	}
	if (query.until != null && Number.isFinite(query.until)) {
		conditions.push(lte(adminAudit.createdAt, new Date(query.until)));
	}
	return conditions.length === 0 ? undefined : and(...conditions);
};

/** First dot segment of an action — the filter group's key. */
const actionGroupOf = (action: string): string => {
	const dot = action.indexOf(".");
	return dot === -1 ? action : action.slice(0, dot);
};

/**
 * Distinct filter values under an optional WHERE — feeds the audit
 * UI's dropdowns so they offer every value in scope, not just the
 * values on the current page. Actor keys mirror the view's display
 * fallback (`coalesce(actor_email, actor_user_id)` — email wins when
 * both are set, NULL when neither is). `selectDistinct` keeps the
 * scans bounded by the column's own cardinality; action groups are
 * derived in JS because the first-segment split is not expressible
 * portably in SQL.
 */
export async function auditListFacets(db: DbClient, where?: SQL): Promise<AuditFacets> {
	const [actions, actors, targets] = await Promise.all([
		db.selectDistinct({ action: adminAudit.action }).from(adminAudit).where(where),
		db
			.selectDistinct({
				actor: sql<string | null>`coalesce(${adminAudit.actorEmail}, ${adminAudit.actorUserId})`,
			})
			.from(adminAudit)
			.where(where),
		db.selectDistinct({ targetType: adminAudit.targetType }).from(adminAudit).where(where),
	]);
	return {
		actionGroups: [...new Set(actions.map((r) => actionGroupOf(r.action)))].sort(),
		actors: actors.map((r) => r.actor).sort((a, b) => String(a).localeCompare(String(b))),
		targetTypes: targets
			.map((r) => r.targetType)
			.sort((a, b) => String(a).localeCompare(String(b))),
	};
}

/**
 * Newest-first audit listing for the /platform/audit console. Callers
 * MUST have passed the `PlatformAdmin` gate first — the repo function
 * itself is unauthenticated, like the other `*Admin` helpers.
 */
export async function listAuditEntries(
	db: DbClient,
	options: AuditListQuery = {},
): Promise<AuditListResult> {
	const limit = pageLimit(options.limit);
	const offset = pageOffset(options.offset);
	const where = auditListWhere(options);
	const [entries, totals] = await Promise.all([
		db
			.select()
			.from(adminAudit)
			.where(where)
			.orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
			.limit(limit)
			.offset(offset),
		db.select({ n: count() }).from(adminAudit).where(where),
	]);
	return { entries, total: totals[0]?.n ?? 0, limit, offset };
}

/**
 * Newest-first audit listing scoped to ONE tenant — fenced by
 * `tenant_id = tenantId`; platform-global rows (`tenant_id` NULL) are
 * excluded — they stay admin-only. Same ordering and limit clamp as
 * {@link listAuditEntries}. The staff activity feed is actor-scoped
 * ({@link listActorAuditEntries}); this tenant-wide variant remains
 * for callers that resolve a tenant scope themselves. The repo
 * function itself is unauthenticated, like the other `*Admin` helpers.
 */
export async function listTenantAuditEntries(
	db: DbClient,
	tenantId: number,
	options: AuditListQuery = {},
): Promise<AuditListResult> {
	const limit = pageLimit(options.limit);
	const offset = pageOffset(options.offset);
	const where = and(eq(adminAudit.tenantId, tenantId), auditListWhere(options));
	const [entries, totals] = await Promise.all([
		db
			.select()
			.from(adminAudit)
			.where(where)
			.orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
			.limit(limit)
			.offset(offset),
		db.select({ n: count() }).from(adminAudit).where(where),
	]);
	return { entries, total: totals[0]?.n ?? 0, limit, offset };
}

/** An actor identity the staff activity feed may show: the account
 * user id plus its session email (either column identifies the actor —
 * `record` stamps both from the same principal). */
export interface ActivityActor {
	readonly userId: string;
	readonly email: string | null;
}

/** WHERE fence for the staff feed: rows whose actor is one of the
 * viewer's visible actors. Both identity columns are matched — a row
 * stays visible even when only one of them was stamped (older rows,
 * email-less sessions). System rows (both NULL) never match. */
const actorAuditScope = (actors: readonly ActivityActor[]): SQL | undefined => {
	const conditions: SQL[] = [
		inArray(
			adminAudit.actorUserId,
			actors.map((a) => a.userId),
		),
	];
	const emails = [
		...new Set(actors.map((a) => a.email).filter((e): e is string => e !== null && e !== "")),
	];
	if (emails.length > 0) conditions.push(inArray(adminAudit.actorEmail, emails));
	return or(...conditions);
};

/**
 * Newest-first audit listing scoped to a SET of actors — the staff
 * activity feed the clinician plugin mounts at
 * /portal/<instance>/activity. NOT tenant-scoped: a clinician's
 * practice may span clinics, so the fence is the actor identities the
 * viewer may see (self plus delegated doctor profiles — resolved by
 * the service, not the caller). Same ordering and limit clamp as
 * {@link listTenantAuditEntries}. Callers MUST have resolved the actor
 * set first — the repo function itself is unauthenticated, like the
 * other `*Admin` helpers.
 */
export async function listActorAuditEntries(
	db: DbClient,
	actors: readonly ActivityActor[],
	options: AuditListQuery = {},
): Promise<AuditListResult> {
	const limit = pageLimit(options.limit);
	const offset = pageOffset(options.offset);
	if (actors.length === 0) return { entries: [], total: 0, limit, offset };
	const scope = actorAuditScope(actors);
	const where = scope === undefined ? auditListWhere(options) : and(scope, auditListWhere(options));
	const [entries, totals] = await Promise.all([
		db
			.select()
			.from(adminAudit)
			.where(where)
			.orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
			.limit(limit)
			.offset(offset),
		db.select({ n: count() }).from(adminAudit).where(where),
	]);
	return { entries, total: totals[0]?.n ?? 0, limit, offset };
}

/** Patient-record scope shared by the listing and the facet query
 * (P-086): `target_id` is TEXT while `consultations.id`/
 * `detail.patientId` are integers — CAST keeps the comparison
 * type-exact, and the json_valid CASE guards json_extract against
 * malformed detail JSON (NULL detail → json_valid NULL → no match). */
const patientAuditScope = (db: DbClient, patientId: number) =>
	or(
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
			sql`CASE WHEN json_valid(${adminAudit.detail}) THEN json_extract(${adminAudit.detail}, '$.patientId') END = ${patientId}`,
		),
	);

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
	options: AuditListQuery = {},
): Promise<AuditListResult> {
	const limit = pageLimit(options.limit);
	const offset = pageOffset(options.offset);
	const where = and(patientAuditScope(db, patientId), auditListWhere(options));
	const [entries, totals] = await Promise.all([
		db
			.select()
			.from(adminAudit)
			.where(where)
			.orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
			.limit(limit)
			.offset(offset),
		db.select({ n: count() }).from(adminAudit).where(where),
	]);
	return { entries, total: totals[0]?.n ?? 0, limit, offset };
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
 * `activityAccess`/`activityList`/`activityFacets` are the staff
 * activity feed the clinician plugin mounts at
 * /portal/<instance>/activity: ACTOR-scoped, not tenant-scoped and
 * not `audit.read`-gated. The visible actor set is the bound
 * principal's own account (`actorId ?? userId` — the signed-in person,
 * so a secretary's delegated actions stay attributed to them) plus
 * every doctor profile the optional `DoctorProfiles` port reports for
 * that account — a secretary sees each doctor's own activity, a
 * doctor sees their own. Self is always visible for a signed-in
 * principal; an absent principal or an empty actor set fails closed.
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
		readonly adminList: (options?: AuditListQuery) => Effect.Effect<AuditListResult, Forbidden>;
		/** Tamper-evident chain walk over the whole log — platform admins only. */
		readonly adminVerify: () => Effect.Effect<AuditVerifyResult, Forbidden>;
		/** Distinct filter values for the admin console's dropdowns. */
		readonly adminFacets: () => Effect.Effect<AuditFacets, Forbidden>;
		/** Whether the bound principal may read the staff activity feed —
		 * false (fail closed) without a signed-in principal. */
		readonly activityAccess: () => Effect.Effect<boolean>;
		/** Actor-scoped newest-first feed; `Forbidden` when
		 * {@link activityAccess} would be false. */
		readonly activityList: (options?: AuditListQuery) => Effect.Effect<AuditListResult, Forbidden>;
		/** Distinct filter values within the actor-scoped feed — the
		 * permitted actor keys are unioned in so every visible actor is
		 * filterable even before it has entries. */
		readonly activityFacets: () => Effect.Effect<AuditFacets, Forbidden>;
		/** Patient-scoped newest-first feed (P-086): entries naming the
		 * patient's own record across every tenant. `Forbidden` when the
		 * optional {@link PatientAuditAccess} port is absent or denies —
		 * fail closed, never tenant-scoped. */
		readonly patientList: (
			options: {
				readonly patientId: number;
			} & AuditListQuery,
		) => Effect.Effect<AuditListResult, Forbidden>;
		/** Distinct filter values within one patient's feed — same
		 * `PatientAuditAccess` gate as {@link patientList}. */
		readonly patientFacets: (options: {
			readonly patientId: number;
		}) => Effect.Effect<AuditFacets, Forbidden>;
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
		/** Actor scope for the staff feed, resolved PER CALL: the
		 * signed-in account (`actorId ?? userId` — under delegation the
		 * actor is the secretary, matching what `record` stamps) plus
		 * every doctor profile the OPTIONAL `DoctorProfiles` port lists
		 * for it. `serviceOption` keeps AuditLive's requirements
		 * unchanged: a deployment without the doctors plugin degrades
		 * to the self-only feed, and a directory failure does the same
		 * rather than failing the page. */
		const activityActors = Effect.gen(function* () {
			const principal = yield* Principal;
			if (principal === null) return [] as readonly ActivityActor[];
			const accountId = principal.actorId ?? principal.userId;
			const actors: ActivityActor[] = [{ userId: accountId, email: principal.email ?? null }];
			const directory = yield* Effect.serviceOption(DoctorProfiles);
			if (Option.isNone(directory)) return actors;
			const profiles = yield* directory.value
				.listFor(accountId)
				.pipe(Effect.catchCause(() => Effect.succeed([] as readonly DoctorProfile[])));
			const seen = new Set(actors.map((a) => a.userId));
			for (const profile of profiles) {
				if (seen.has(profile.userId)) continue;
				seen.add(profile.userId);
				actors.push({
					userId: profile.userId,
					email: profile.email === "" ? null : profile.email,
				});
			}
			return actors;
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
			adminList: Effect.fn("Audit.adminList")(function* (options?: AuditListQuery) {
				yield* platformAdmin.requireAdmin();
				return yield* Effect.promise(() => listAuditEntries(db, options));
			}),
			adminVerify: Effect.fn("Audit.adminVerify")(function* () {
				yield* platformAdmin.requireAdmin();
				return yield* Effect.promise(() => verifyAuditChain(db));
			}),
			adminFacets: Effect.fn("Audit.adminFacets")(function* () {
				yield* platformAdmin.requireAdmin();
				return yield* Effect.promise(() => auditListFacets(db));
			}),
			activityAccess: Effect.fn("Audit.activityAccess")(function* () {
				return (yield* activityActors).length > 0;
			}),
			activityList: Effect.fn("Audit.activityList")(function* (options?: AuditListQuery) {
				const actors = yield* activityActors;
				if (actors.length === 0) {
					return yield* Effect.fail(new Forbidden({ path: "audit.activity" }));
				}
				return yield* Effect.promise(() => listActorAuditEntries(db, actors, options));
			}),
			activityFacets: Effect.fn("Audit.activityFacets")(function* () {
				const actors = yield* activityActors;
				if (actors.length === 0) {
					return yield* Effect.fail(new Forbidden({ path: "audit.activity" }));
				}
				const facets = yield* Effect.promise(() => auditListFacets(db, actorAuditScope(actors)));
				// Union the permitted actor keys into the dropdown: a
				// delegated doctor with no entries yet is still an
				// explicit filter choice ("their doctors").
				const allowed = actors.map((a) => a.email ?? a.userId);
				return {
					...facets,
					actors: [...new Set([...facets.actors, ...allowed])].sort((a, b) =>
						String(a).localeCompare(String(b)),
					),
				};
			}),
			patientList: Effect.fn("Audit.patientList")(function* (
				options: {
					patientId: number;
				} & AuditListQuery,
			) {
				const access = yield* Effect.serviceOption(PatientAuditAccess);
				if (Option.isNone(access)) {
					return yield* Effect.fail(new Forbidden({ path: "audit.patient" }));
				}
				const allowed = yield* access.value.canView(options.patientId);
				if (!allowed) {
					return yield* Effect.fail(new Forbidden({ path: "audit.patient" }));
				}
				const { patientId, ...query } = options;
				return yield* Effect.promise(() => listPatientAuditEntries(db, patientId, query));
			}),
			patientFacets: Effect.fn("Audit.patientFacets")(function* (options: { patientId: number }) {
				const access = yield* Effect.serviceOption(PatientAuditAccess);
				if (Option.isNone(access)) {
					return yield* Effect.fail(new Forbidden({ path: "audit.patient" }));
				}
				const allowed = yield* access.value.canView(options.patientId);
				if (!allowed) {
					return yield* Effect.fail(new Forbidden({ path: "audit.patient" }));
				}
				// Same patient scope as listPatientAuditEntries — the facet
				// dropdowns must never offer values outside the feed.
				const scope = patientAuditScope(db, options.patientId);
				return yield* Effect.promise(() => auditListFacets(db, scope));
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
	meta: { keywords: ["audit", "tables"] },
	tables: { adminAudit },
});

export const auditServicesPlugin = definePlugin({
	id: "audit.services",
	// adminList consumes the PlatformAdmin gate — the dep edge keeps the
	// platform module ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	meta: {
		keywords: ["audit", "services"],
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
	meta: { keywords: ["audit", "ui"] },
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
					group: "Assurance",
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
	meta: { keywords: ["audit", "ui"] },
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
						const empty: AuditListResult = { entries: [], total: 0, limit: 200, offset: 0 };
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
