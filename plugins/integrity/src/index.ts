import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, asc, desc, eq } from "drizzle-orm";

import { Principal } from "@ktb/authz";
import { contentHash, sha256Hex } from "@ktb/crypto/digest";
import { Db, type DbClient } from "@ktb/db";
import { definePlugin, type Plugin } from "@ktb/kernel";

import { recordVersions, type RecordVersion } from "./schema.ts";

export type { RecordVersion };
export { recordVersions } from "./schema.ts";

/**
 * One material change to a versioned document (T-138, PL-007 F1).
 * `payload` is the stored snapshot — canonical JSON for non-ZK tenants
 * today, an opaque AEAD envelope for ZK tenants later. `contentHash`
 * and `signature` are optional because ZK rows carry CLIENT-computed
 * values: when `contentHash` is absent the server derives it from the
 * payload (canonical JSON hash when parseable, byte-level SHA-256 of
 * the raw payload otherwise), which is exactly the interim behavior —
 * tamper detection works today, the same column is signed client-side
 * once the clinic keyring exists.
 */
export interface RecordVersionInput {
	readonly entityType: string;
	readonly entityId: string | number;
	readonly payload: string;
	readonly contentHash?: string;
	readonly signature?: string | null;
	readonly engine?: string | null;
	/** Overrides the bound Principal as `actor_user_id` (backfills). */
	readonly actorUserId?: string | null;
	/** Overrides the write timestamp (backfills preserve the source row's date). */
	readonly createdAt?: Date;
}

/** Content hash for a stored payload: canonical JSON hash when the
 * payload is a serialized document, byte-level SHA-256 when it is
 * opaque (ciphertext) — never fails on unparseable input. */
const deriveContentHash = async (payload: string): Promise<string> => {
	try {
		return await contentHash(JSON.parse(payload));
	} catch {
		return sha256Hex(payload);
	}
};

/** Latest version row for an entity, or null for an unversioned one. */
export async function latestRecordVersion(
	db: DbClient,
	entityType: string,
	entityId: string | number,
): Promise<RecordVersion | null> {
	const rows = await db
		.select()
		.from(recordVersions)
		.where(
			and(eq(recordVersions.entityType, entityType), eq(recordVersions.entityId, String(entityId))),
		)
		.orderBy(desc(recordVersions.version))
		.limit(1);
	return rows[0] ?? null;
}

/** All version rows for an entity, oldest first — the chain walk. */
export async function listRecordVersions(
	db: DbClient,
	entityType: string,
	entityId: string | number,
): Promise<RecordVersion[]> {
	return db
		.select()
		.from(recordVersions)
		.where(
			and(eq(recordVersions.entityType, entityType), eq(recordVersions.entityId, String(entityId))),
		)
		.orderBy(asc(recordVersions.version));
}

/**
 * Append the next version for an entity. `version`/`prev_hash` chain
 * off the latest row — the unique (entity_type, entity_id, version)
 * index is the last word on races.
 */
export async function appendRecordVersion(
	db: DbClient,
	input: RecordVersionInput & { readonly actorUserId: string | null },
): Promise<RecordVersion> {
	const [hash, blobHash, prev] = await Promise.all([
		input.contentHash !== undefined
			? Promise.resolve(input.contentHash)
			: deriveContentHash(input.payload),
		sha256Hex(input.payload),
		latestRecordVersion(db, input.entityType, input.entityId),
	]);
	const rows = await db
		.insert(recordVersions)
		.values({
			entityType: input.entityType,
			entityId: String(input.entityId),
			version: (prev?.version ?? 0) + 1,
			contentHash: hash,
			signature: input.signature ?? null,
			prevHash: prev?.contentHash ?? null,
			payload: input.payload,
			blobHash,
			actorUserId: input.actorUserId,
			engine: input.engine ?? null,
			...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
		})
		.returning();
	return rows[0]!;
}

/**
 * Record-versioning domain port — the generic tamper-evident history
 * every entity plugin writes through (PL-007 F1). Authz lives in the
 * CALLER (the mutation's own service already authorized the change);
 * this service only appends facts.
 *
 * Consumers SHOULD go through `recordVersion()` below — the integrity
 * plugin may be absent and mutations must still succeed. `verify` for
 * readers lands with T-139.
 */
export class Integrity extends Context.Service<
	Integrity,
	{
		readonly record: (input: RecordVersionInput) => Effect.Effect<RecordVersion>;
		readonly versions: (
			entityType: string,
			entityId: string | number,
		) => Effect.Effect<readonly RecordVersion[]>;
	}
>()("@ktb/integrity/Integrity") {}

export const IntegrityLive = Layer.effect(
	Integrity,
	Effect.gen(function* () {
		const db = yield* Db;
		return Integrity.of({
			record: Effect.fn("Integrity.record")(function* (input: RecordVersionInput) {
				const principal = yield* Principal;
				return yield* Effect.promise(() =>
					appendRecordVersion(db, {
						...input,
						actorUserId: input.actorUserId ?? principal?.userId ?? null,
					}),
				);
			}),
			versions: (entityType, entityId) =>
				Effect.promise(() => listRecordVersions(db, entityType, entityId)),
		});
	}),
);

/**
 * One-line write helper for versioned mutations:
 * `const recorded = yield* recordVersion({ entityType, entityId, payload })`.
 *
 * Resolves the Integrity service via `serviceOption` — null when the
 * integrity plugin is absent — and swallows write failures into a
 * logged warning: a version write must never take down the mutation it
 * describes (same contract as `audit()`). Gaps are visible to readers
 * via verifyIntegrity's "unversioned"/"unverified" states (T-139).
 */
export const recordVersion = (input: RecordVersionInput): Effect.Effect<RecordVersion | null> =>
	Effect.flatMap(Effect.serviceOption(Integrity), (option) =>
		Option.isSome(option)
			? option.value.record(input).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("record version write failed", {
							entityType: input.entityType,
							entityId: String(input.entityId),
							cause: String(cause),
						}).pipe(Effect.as(null)),
					),
				)
			: Effect.succeed(null),
	);

// Re-exported for tests: a DDL snippet that creates record_versions in
// the in-memory better-sqlite3 test databases of instrumented plugins.
export const RECORD_VERSIONS_TEST_DDL = `
CREATE TABLE record_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL, signature TEXT, prev_hash TEXT, payload TEXT NOT NULL, blob_hash TEXT NOT NULL, actor_user_id TEXT, engine TEXT, created_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX record_versions_entity_idx ON record_versions (entity_type, entity_id);
CREATE UNIQUE INDEX record_versions_entity_version_idx ON record_versions (entity_type, entity_id, version);
`;

export const integrityTablesPlugin = definePlugin({
	id: "integrity.tables",
	tables: { recordVersions },
});

export const integrityServicesPlugin = definePlugin({
	id: "integrity.services",
	services: IntegrityLive,
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [integrityTablesPlugin, integrityServicesPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"integrity.tables": true;
		"integrity.services": true;
	}
}
