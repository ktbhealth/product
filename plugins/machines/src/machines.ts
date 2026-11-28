import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, eq } from "drizzle-orm";

import { Forbidden } from "@ktb/authz";
import { Audit } from "@ktb/audit";
import { Db, type DbClient } from "@ktb/db";
import { PlatformAdmin, type PlatformAdminShape } from "@ktb/platform";
import { makeFixedWindowRateLimiter } from "@ktb/observability";
import { requireTenantRole, Tenant, TenantForbidden } from "@ktb/tenant";

import { machine, type Machine, type MachineKind, type MachineStatus } from "./schema.ts";

/**
 * Machines — the platform machine registry (P-098 D1/D2).
 *
 * Owns machine records (shells, VMs, GPU nodes, remote endpoints) and
 * passive health signals. This is a REGISTRY, not a connection:
 * consumers resolve a `MachineCard` and dial out through their own
 * adapters (ssh/ws/child). ACP execution, shell spawn and VM control
 * deliberately live elsewhere — `secretRef` is only a `vault:<id>`
 * pointer consumers resolve server-side.
 *
 * Health semantics:
 * - `beat(id)` — agent heartbeat: stamps `lastSeenAt`, marks online.
 * - `check(id)` — probes `healthUrl` (HTTP GET, 5s timeout) when set;
 *   otherwise derives staleness from `lastSeenAt` (online within
 *   `MACHINE_STALE_MS`, else offline). Persists status/checkError.
 * - Reads derive status the same way, so a machine with no healthUrl
 *   and no heartbeat reads `unknown`, never falsely `online`.
 *
 * Authz mirrors `Secrets`: platform scope → `PlatformAdmin`; tenant
 * scope → bound tenant (members read, admins write). Mutations audit.
 */

export const MACHINE_STALE_MS = 120_000;

const PLATFORM_SCOPE = "platform";

export class MachineError extends Data.TaggedError("MachineError")<{
	readonly reason: "not-found" | "tenant-mismatch" | "invalid" | "duplicate" | "rate-limited";
	readonly detail?: string;
}> {}

/** Wire-facing machine DTO — `secretRef` stays a `vault:` pointer. */
export interface MachineCard {
	readonly id: number;
	readonly scope: string;
	readonly tenantId: number | null;
	readonly name: string;
	readonly kind: MachineKind;
	readonly host: string;
	readonly port: number | null;
	readonly capabilities: ReadonlyArray<string>;
	readonly secretRef: string | null;
	readonly healthUrl: string | null;
	readonly status: MachineStatus;
	readonly lastSeenAt: Date | null;
	readonly lastCheckAt: Date | null;
	readonly checkError: string | null;
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

const toCard = (row: Machine): MachineCard => ({
	id: row.id,
	scope: row.scope,
	tenantId: row.tenantId,
	name: row.name,
	kind: row.kind as MachineKind,
	host: row.host,
	port: row.port,
	capabilities: parseCapabilities(row.capabilities),
	secretRef: row.secretRef,
	healthUrl: row.healthUrl,
	status: row.status as MachineStatus,
	lastSeenAt: row.lastSeenAt,
	lastCheckAt: row.lastCheckAt,
	checkError: row.checkError,
	enabled: row.enabled === 1,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

/** Status shown to readers: last persisted status, refined by
 * heartbeat staleness when the machine has no healthUrl to probe. */
const derivedStatus = (row: Machine, now: number): MachineStatus => {
	const status = row.status as MachineStatus;
	if (row.healthUrl !== null || status === "draining") return status;
	if (row.lastSeenAt === null) return "unknown";
	return now - row.lastSeenAt.getTime() <= MACHINE_STALE_MS ? "online" : "offline";
};

const toCardLive = (row: Machine, now: number): MachineCard => ({
	...toCard(row),
	status: derivedStatus(row, now),
});

async function listMachines(db: DbClient, scope: string): Promise<Machine[]> {
	return db.select().from(machine).where(eq(machine.scope, scope)).orderBy(machine.name);
}

async function getMachineById(db: DbClient, id: number): Promise<Machine | null> {
	const rows = await db.select().from(machine).where(eq(machine.id, id)).limit(1);
	return rows[0] ?? null;
}

async function getMachineByName(
	db: DbClient,
	scope: string,
	name: string,
): Promise<Machine | null> {
	const rows = await db
		.select()
		.from(machine)
		.where(and(eq(machine.scope, scope), eq(machine.name, name)))
		.limit(1);
	return rows[0] ?? null;
}

export async function insertMachine(
	db: DbClient,
	row: {
		readonly scope: string;
		readonly tenantId: number | null;
		readonly name: string;
		readonly kind: MachineKind;
		readonly host: string;
		readonly port: number | null;
		readonly capabilities: string | null;
		readonly secretRef: string | null;
		readonly healthUrl: string | null;
		readonly status: MachineStatus;
	},
): Promise<Machine> {
	const rows = await db
		.insert(machine)
		.values({ ...row, enabled: 1, createdAt: new Date() })
		.returning();
	return rows[0]!;
}

export async function updateMachine(
	db: DbClient,
	id: number,
	patch: Partial<{
		name: string;
		kind: MachineKind;
		host: string;
		port: number | null;
		capabilities: string | null;
		secretRef: string | null;
		healthUrl: string | null;
		status: MachineStatus;
		enabled: number;
		lastSeenAt: Date | null;
		lastCheckAt: Date | null;
		checkError: string | null;
	}>,
): Promise<Machine> {
	const rows = await db
		.update(machine)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(machine.id, id))
		.returning();
	return rows[0]!;
}

async function deleteMachine(db: DbClient, id: number): Promise<void> {
	await db.delete(machine).where(eq(machine.id, id));
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
			return yield* Effect.fail(new MachineError({ reason: "tenant-mismatch" }));
		yield* requireTenantRole(min === "admin" ? "admin" : "member", `machines.${min}`);
	});
};

/** `secretRef` hygiene (P-098 C4): `vault:` refs must be well-formed
 * (`vault:<positive int>` — same spelling `Secrets.parseSecretRef`
 * accepts). Other schemes (`env:`, future brokers) pass through
 * untouched — the registry stores pointers, consumers resolve them. */
const SECRET_REF_OK = /^vault:\d+$/;
const requireValidSecretRef = (ref: string | null | undefined): Effect.Effect<void, MachineError> =>
	ref !== undefined &&
	ref !== null &&
	ref !== "" &&
	ref.startsWith("vault:") &&
	!SECRET_REF_OK.test(ref)
		? Effect.fail(
				new MachineError({
					reason: "invalid",
					detail: `malformed vault ref — expected vault:<id>`,
				}),
			)
		: Effect.void;

const scopeFor = (input: {
	readonly scope: "platform" | "tenant";
	readonly tenantId?: number | null;
}): { readonly scope: string; readonly tenantId: number | null } =>
	input.scope === "tenant" && input.tenantId != null
		? { scope: String(input.tenantId), tenantId: input.tenantId }
		: { scope: PLATFORM_SCOPE, tenantId: null };

// ── Service ──────────────────────────────────────────────────────

export class Machines extends Context.Service<
	Machines,
	{
		/** Machines visible to the caller's scope request. `scope` omitted
		 * lists platform machines only when admin — callers pick a scope. */
		readonly list: (input?: {
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
		}) => Effect.Effect<ReadonlyArray<MachineCard>, MachineError | TenantForbidden | Forbidden>;
		readonly get: (
			id: number,
		) => Effect.Effect<MachineCard | null, MachineError | TenantForbidden | Forbidden>;
		readonly create: (input: {
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
			readonly name: string;
			readonly kind?: MachineKind;
			readonly host: string;
			readonly port?: number | null;
			readonly capabilities?: ReadonlyArray<string>;
			readonly secretRef?: string | null;
			readonly healthUrl?: string | null;
		}) => Effect.Effect<MachineCard, MachineError | TenantForbidden | Forbidden>;
		readonly update: (input: {
			readonly id: number;
			readonly name?: string;
			readonly kind?: MachineKind;
			readonly host?: string;
			readonly port?: number | null;
			readonly capabilities?: ReadonlyArray<string>;
			readonly secretRef?: string | null;
			readonly healthUrl?: string | null;
			readonly enabled?: boolean;
		}) => Effect.Effect<MachineCard, MachineError | TenantForbidden | Forbidden>;
		readonly remove: (
			id: number,
		) => Effect.Effect<void, MachineError | TenantForbidden | Forbidden>;
		/** Agent heartbeat — stamps lastSeenAt, marks online. Ungated by
		 * design like `Secrets.resolve`: the machine row id is the
		 * capability; agents run in system context. Audit-logged. */
		readonly beat: (id: number) => Effect.Effect<void, MachineError>;
		/** Server-side capability read for system consumers (ACP/ssh
		 * adapters resolving an endpoint's `machineId`) — ungated like
		 * `Secrets.resolve`: the machine id is the capability, user-facing
		 * surfaces use the gated `get`/`list`. Audit-logged. */
		readonly resolve: (id: number) => Effect.Effect<MachineCard | null, MachineError>;
		/** Probe healthUrl (HTTP GET, 5s) or derive heartbeat staleness;
		 * persists status/lastCheckAt/checkError. */
		readonly check: (
			id: number,
		) => Effect.Effect<MachineCard | null, MachineError | TenantForbidden | Forbidden>;
		readonly checkAll: (input?: {
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
		}) => Effect.Effect<ReadonlyArray<MachineCard>, MachineError | TenantForbidden | Forbidden>;
	}
>()("@ktb/machines/Machines") {}

const HEALTH_TIMEOUT_MS = 5_000;
const CHECK_ERROR_MAX = 200;
/** Beats per machine per minute — heartbeats run every 10-60s, so 30
 * leaves headroom while damping a runaway agent into false "online". */
const BEAT_LIMIT_PER_MIN = 30;

/** HTTP probe for `check` — injectable in tests via globalThis.fetch. */
const probeHealth = (healthUrl: string): Effect.Effect<{ ok: boolean; error: string | null }> =>
	Effect.tryPromise({
		try: async () => {
			const res = await fetch(healthUrl, {
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			return { ok: res.ok, error: res.ok ? null : `HTTP ${res.status}` };
		},
		catch: (e) => (e instanceof Error ? e.message : String(e)).slice(0, CHECK_ERROR_MAX),
	}).pipe(Effect.catch((msg) => Effect.succeed({ ok: false, error: msg })));

/** Audit write — best-effort (Audit.record never fails by contract);
 * detail carries ids only, never secrets. */
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
			targetType: "machine",
			targetId: row.id,
			detail: { name: row.name, scope: row.scope, ...detail },
			tenantId: Number.isFinite(tenantId) ? tenantId : null,
		});
	});

export const MachinesLive = Layer.effect(
	Machines,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		// Per-isolate fixed-window limiter (best-effort, same semantics
		// as the telemetry edge limiter) — bounds beat spam per machine.
		const beatLimiter = makeFixedWindowRateLimiter({ windowMs: 60_000 });

		const now = () => Date.now();

		const visibleScope = Effect.fn("Machines.visibleScope")(function* (input?: {
			readonly scope?: "platform" | "tenant";
			readonly tenantId?: number | null;
		}) {
			const resolved = scopeFor({
				scope: input?.scope ?? "platform",
				tenantId: input?.tenantId ?? null,
			});
			yield* requireScopeAccess(platformAdmin, resolved.scope, "member");
			return resolved;
		});

		const requireMachine = Effect.fn("Machines.requireMachine")(function* (id: number) {
			const row = yield* Effect.promise(() => getMachineById(db, id));
			if (row === null) return yield* Effect.fail(new MachineError({ reason: "not-found" }));
			return row;
		});

		const requireWrite = Effect.fn("Machines.requireWrite")(function* (row: Machine) {
			yield* requireScopeAccess(platformAdmin, row.scope, "admin");
		});

		/** Probe/persist health for one row — caller handles authz. */
		const runCheck = Effect.fn("Machines.runCheck")(function* (row: Machine) {
			const t = now();
			let status: MachineStatus;
			let checkError: string | null = null;
			if (row.healthUrl !== null) {
				const probe = yield* probeHealth(row.healthUrl);
				status = probe.ok ? "online" : "offline";
				checkError = probe.error;
			} else if (row.lastSeenAt === null) {
				status = "unknown";
				checkError = "no healthUrl and no heartbeat recorded";
			} else {
				status = t - row.lastSeenAt.getTime() <= MACHINE_STALE_MS ? "online" : "offline";
				checkError = status === "offline" ? "heartbeat stale" : null;
			}
			const updated = yield* Effect.promise(() =>
				updateMachine(db, row.id, {
					status,
					lastCheckAt: new Date(t),
					checkError,
				}),
			);
			yield* recordAudit("machines.check", updated, { status });
			return toCardLive(updated, t);
		});

		return Machines.of({
			list: Effect.fn("Machines.list")(function* (input) {
				const { scope } = yield* visibleScope(input);
				const rows = yield* Effect.promise(() => listMachines(db, scope));
				const t = now();
				return rows.map((r) => toCardLive(r, t));
			}),

			get: Effect.fn("Machines.get")(function* (id) {
				const row = yield* Effect.promise(() => getMachineById(db, id));
				if (row === null) return null;
				yield* requireScopeAccess(platformAdmin, row.scope, "member");
				return toCardLive(row, now());
			}),

			create: Effect.fn("Machines.create")(function* (input) {
				const { scope, tenantId } = scopeFor({
					scope: input.scope ?? "platform",
					tenantId: input.tenantId ?? null,
				});
				yield* requireScopeAccess(platformAdmin, scope, "admin");
				yield* requireValidSecretRef(input.secretRef);
				const name = input.name.trim();
				const host = input.host.trim();
				if (name === "" || host === "")
					return yield* Effect.fail(
						new MachineError({ reason: "invalid", detail: "name and host are required" }),
					);
				const existing = yield* Effect.promise(() => getMachineByName(db, scope, name));
				if (existing !== null)
					return yield* Effect.fail(
						new MachineError({ reason: "duplicate", detail: `machine "${name}" exists` }),
					);
				const row = yield* Effect.promise(() =>
					insertMachine(db, {
						scope,
						tenantId,
						name,
						kind: input.kind ?? "other",
						host,
						port: input.port ?? null,
						capabilities:
							input.capabilities === undefined ? null : JSON.stringify(input.capabilities),
						secretRef: input.secretRef ?? null,
						healthUrl: input.healthUrl ?? null,
						status: "unknown",
					}),
				);
				yield* recordAudit("machines.create", row);
				return toCardLive(row, now());
			}),

			update: Effect.fn("Machines.update")(function* (input) {
				const row = yield* requireMachine(input.id);
				yield* requireWrite(row);
				yield* requireValidSecretRef(input.secretRef);
				if (input.name !== undefined && input.name.trim() === "")
					return yield* Effect.fail(
						new MachineError({ reason: "invalid", detail: "name is empty" }),
					);
				if (input.host !== undefined && input.host.trim() === "")
					return yield* Effect.fail(
						new MachineError({ reason: "invalid", detail: "host is empty" }),
					);
				const patch: Parameters<typeof updateMachine>[2] = {
					...(input.name !== undefined ? { name: input.name.trim() } : {}),
					...(input.kind !== undefined ? { kind: input.kind } : {}),
					...(input.host !== undefined ? { host: input.host.trim() } : {}),
					...(input.port !== undefined ? { port: input.port } : {}),
					...(input.capabilities !== undefined
						? { capabilities: JSON.stringify(input.capabilities) }
						: {}),
					...(input.secretRef !== undefined ? { secretRef: input.secretRef } : {}),
					...(input.healthUrl !== undefined ? { healthUrl: input.healthUrl } : {}),
					...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
				};
				const updated = yield* Effect.promise(() => updateMachine(db, row.id, patch));
				yield* recordAudit("machines.update", updated);
				return toCardLive(updated, now());
			}),

			remove: Effect.fn("Machines.remove")(function* (id) {
				const row = yield* requireMachine(id);
				yield* requireWrite(row);
				yield* Effect.promise(() => deleteMachine(db, row.id));
				yield* recordAudit("machines.remove", row);
			}),

			beat: Effect.fn("Machines.beat")(function* (id) {
				const row = yield* Effect.promise(() => getMachineById(db, id));
				if (row === null) return yield* Effect.fail(new MachineError({ reason: "not-found" }));
				// Disabled and draining machines ignore beats — a beat
				// must not resurrect a machine consumers already skip.
				if (row.enabled !== 1 || row.status === "draining") return;
				if (!beatLimiter.hit(`beat:${row.id}`, BEAT_LIMIT_PER_MIN).allowed)
					return yield* Effect.fail(
						new MachineError({ reason: "rate-limited", detail: "beat too frequent" }),
					);
				const updated = yield* Effect.promise(() =>
					updateMachine(db, row.id, {
						lastSeenAt: new Date(),
						status: "online",
					}),
				);
				yield* recordAudit("machines.beat", updated);
			}),

			resolve: Effect.fn("Machines.resolve")(function* (id) {
				const row = yield* Effect.promise(() => getMachineById(db, id));
				if (row === null || row.enabled !== 1) return null;
				yield* recordAudit("machines.resolve", row);
				return toCardLive(row, now());
			}),

			check: Effect.fn("Machines.check")(function* (id) {
				const row = yield* requireMachine(id);
				yield* requireScopeAccess(platformAdmin, row.scope, "member");
				return yield* runCheck(row);
			}),

			checkAll: Effect.fn("Machines.checkAll")(function* (input) {
				const { scope } = yield* visibleScope(input);
				const rows = yield* Effect.promise(() => listMachines(db, scope));
				const results: MachineCard[] = [];
				for (const row of rows) {
					results.push(
						yield* runCheck(row).pipe(Effect.catch(() => Effect.succeed(toCardLive(row, now())))),
					);
				}
				return results;
			}),
		});
	}),
);
