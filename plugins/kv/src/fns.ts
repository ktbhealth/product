import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { ensureSessionUser, requirePluginEnabled, runAs } from "@ktb/server-fns";
import { PlatformAdmin } from "@ktb/platform";

import {
	KvAdmin,
	type KvAdminEntry,
	type KvAdminFilter,
	type KvAdminNamespaceCount,
	type KvAdminSetInput,
	type KvAdminTarget,
} from "./admin.ts";

// KV admin server functions (P-090 console): every call runs through
// `runAs` so the bound Principal feeds audit, and the KvAdmin service
// re-checks PlatformAdmin inside the effect (defense in depth — same
// pattern as the pages/i18n admin fns). Handled domain failures
// (Forbidden / KvValidationError / KvNotFoundError / KvConflictError)
// collapse to the documented wire results — `null` for reads,
// `{ ok: false, reason }` for writes so CAS conflicts surface
// distinctly; anything else propagates.

/** JSON-shaped value as it crosses the wire — server fns reject `unknown`
 * return fields (not provably serializable), and stored values always
 * come from `JSON.parse`, so this recursive shape is exact. */
export type KvJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly KvJsonValue[]
	| { readonly [key: string]: KvJsonValue };

/** Serializable entry — value is already JSON-decoded (came from
 * JSON.parse server-side, so it round-trips cleanly). */
export interface KvEntryWire {
	readonly namespace: string;
	readonly key: string;
	readonly tenantId: number | null;
	readonly ownerId: string | null;
	readonly value: KvJsonValue;
	readonly version: number;
	readonly expiresAt: number | null;
	readonly expired: boolean;
}

export interface KvListWire {
	readonly items: readonly KvEntryWire[];
	readonly total: number;
}

export interface KvNamespaceWire {
	readonly namespace: string;
	readonly count: number;
}

export type KvSetResult =
	| { readonly ok: true; readonly entry: KvEntryWire }
	| {
			readonly ok: false;
			readonly reason: "forbidden" | "invalid" | "notfound" | "conflict";
			readonly actualVersion?: number;
	  };

const toWire = (entry: KvAdminEntry): KvEntryWire => ({
	namespace: entry.namespace,
	key: entry.key,
	tenantId: entry.tenantId,
	ownerId: entry.ownerId,
	// Stored values are JSON.parse output — always KvJsonValue-shaped.
	value: entry.value as KvJsonValue,
	version: entry.version,
	expiresAt: entry.expiresAt,
	expired: entry.expired,
});

/** Run `eff` as the session user after the PlatformAdmin gate. */
const asAdmin = <A, E>(
	user: { readonly id: string; readonly email?: string },
	eff: Effect.Effect<A, E, unknown>,
): Promise<A> =>
	runAs(
		user,
		Effect.gen(function* () {
			const platformAdmin = yield* PlatformAdmin;
			yield* platformAdmin.requireAdmin();
			return yield* eff;
		}),
	);

const isHandled = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	["Forbidden", "KvValidationError", "KvNotFoundError", "KvConflictError"].includes(
		String((error as { _tag?: unknown })._tag),
	);

// ---------- wire schemas ----------

/** Scope fields tolerate null/undefined and string-coerced tenant ids
 * (the service normalizes numerics) — same tolerance rule as the other
 * plugin fns. */
const ScopeFields = {
	tenantId: Schema.optionalKey(Schema.NullishOr(Schema.Union([Schema.Number, Schema.String]))),
	ownerId: Schema.optionalKey(Schema.NullishOr(Schema.String)),
};

const ListInput = Schema.Struct({
	namespace: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	prefix: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	limit: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	offset: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
});
const decodeList = Schema.decodeUnknownSync(ListInput);

const EntryTargetInput = Schema.Struct({
	namespace: Schema.String,
	key: Schema.String,
	...ScopeFields,
});
const decodeTarget = Schema.decodeUnknownSync(EntryTargetInput);

/** Edit payload: the value travels as raw JSON text so the textarea's
 * contents are validated server-side (parse failure → `invalid`).
 * Capped like the i18n message values — bounds the wire + parse cost. */
const VALUE_JSON_MAX = 100_000;
const SetInput = Schema.Struct({
	namespace: Schema.String,
	key: Schema.String,
	...ScopeFields,
	valueJson: Schema.String.check(Schema.isMaxLength(VALUE_JSON_MAX)),
	ttlMs: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	expectedVersion: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
});
const decodeSet = Schema.decodeUnknownSync(SetInput);

const toTarget = (d: Schema.Schema.Type<typeof EntryTargetInput>): KvAdminTarget => ({
	namespace: d.namespace,
	key: d.key,
	tenantId: d.tenantId ?? null,
	ownerId: d.ownerId ?? null,
});

const toFilter = (d: Schema.Schema.Type<typeof ListInput>): KvAdminFilter => ({
	namespace: d.namespace ?? undefined,
	prefix: d.prefix ?? undefined,
	limit: d.limit ?? undefined,
	offset: d.offset ?? undefined,
});

const toSetInput = (d: Schema.Schema.Type<typeof SetInput>, value: unknown): KvAdminSetInput => ({
	namespace: d.namespace,
	key: d.key,
	tenantId: d.tenantId ?? null,
	ownerId: d.ownerId ?? null,
	value,
	// ttlMs passes through verbatim: undefined preserves, null clears,
	// a number sets — `??` would collapse null into preserve.
	ttlMs: d.ttlMs,
	expectedVersion: d.expectedVersion ?? undefined,
});

// ---------- fns ----------

/** Filtered/paginated entry listing for the console; `null` for
 * non-admins and handled validation failures. */
export const kvListFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeList(input ?? {}))
	.handler(async ({ data }): Promise<KvListWire | null> => {
		await requirePluginEnabled("kv.admin.services");
		const user = await ensureSessionUser();
		const list = await asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* KvAdmin;
				return yield* admin.list(toFilter(data));
			}),
		).catch((error: unknown) => {
			if (isHandled(error)) return null;
			throw error;
		});
		return list === null ? null : { items: list.items.map(toWire), total: list.total };
	});

/** Per-namespace counts for the console overview; `null` when denied
 * or the input is invalid (there is no input — defensive). */
export const kvNamespacesFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly KvNamespaceWire[] | null> => {
		await requirePluginEnabled("kv.admin.services");
		const user = await ensureSessionUser();
		const rows = await asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* KvAdmin;
				return yield* admin.namespaces();
			}),
		).catch((error: unknown) => {
			if (isHandled(error)) return null;
			throw error;
		});
		return rows === null ? null : rows.map((r: KvAdminNamespaceCount) => ({ ...r }));
	},
);

/** Fresh single-entry read (edit dialog revalidation); `null` for
 * non-admins, missing rows and handled failures. */
export const kvGetFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeTarget(input))
	.handler(async ({ data }): Promise<KvEntryWire | null> => {
		await requirePluginEnabled("kv.admin.services");
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* KvAdmin;
				const entry = yield* admin.get(toTarget(data));
				return entry === null ? null : toWire(entry);
			}),
		).catch((error: unknown) => {
			if (isHandled(error)) return null;
			throw error;
		});
	});

/** Create/update an entry. `valueJson` must parse as JSON;
 * `expectedVersion` enables the CAS guard — conflicts come back as
 * `{ ok: false, reason: "conflict", actualVersion }` so the console can
 * tell the user to reload. */
export const kvSetFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeSet(input))
	.handler(async ({ data }): Promise<KvSetResult> => {
		let value: unknown;
		try {
			value = JSON.parse(data.valueJson);
		} catch {
			return { ok: false, reason: "invalid" };
		}
		await requirePluginEnabled("kv.admin.services");
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* KvAdmin;
				const entry = yield* admin.set(toSetInput(data, value));
				return { ok: true as const, entry: toWire(entry) };
			}),
		).catch((error: unknown): KvSetResult => {
			if (typeof error === "object" && error !== null && "_tag" in error) {
				const tag = String((error as { _tag?: unknown })._tag);
				if (tag === "Forbidden") return { ok: false, reason: "forbidden" };
				if (tag === "KvValidationError") return { ok: false, reason: "invalid" };
				if (tag === "KvNotFoundError") return { ok: false, reason: "notfound" };
				if (tag === "KvConflictError") {
					return {
						ok: false,
						reason: "conflict",
						actualVersion: (error as { actualVersion?: number }).actualVersion,
					};
				}
			}
			throw error;
		});
	});

/** Delete an entry; `false` for non-admins, missing rows and handled
 * failures (same contract as the pages delete fn). */
export const kvDeleteFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeTarget(input))
	.handler(async ({ data }): Promise<boolean> => {
		await requirePluginEnabled("kv.admin.services");
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* KvAdmin;
				return yield* admin.remove(toTarget(data));
			}),
		).catch((error: unknown) => {
			if (isHandled(error)) return false;
			throw error;
		});
	});
