import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Principal } from "@ktb/authz";
import { contentHash, sha256Hex } from "@ktb/crypto/digest";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import {
	appendRecordVersion,
	Integrity,
	IntegrityLive,
	latestRecordVersion,
	listRecordVersions,
	RECORD_VERSIONS_TEST_DDL,
	recordVersion,
	plugins,
	integrityTablesPlugin,
	integrityServicesPlugin,
} from "./index.ts";
import { recordVersions } from "./schema.ts";

const DDL = RECORD_VERSIONS_TEST_DDL;

const makeRuntime = (db: ReturnType<typeof makeDb>) => {
	const infra = Layer.succeed(Db, db);
	return ManagedRuntime.make(
		Layer.mergeAll(infra, IntegrityLive.pipe(Layer.provide(infra))),
	) as ManagedRuntime.ManagedRuntime<Integrity, never>;
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<Integrity, never>,
	effect: Effect.Effect<A, E, Integrity>,
	principal: { userId: string; email?: string } | null = null,
) => runtime.runPromise(Effect.provideService(effect, Principal, principal));

describe("record_versions repo", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(DDL));
	});

	it("appends version 1 with a null chain head", async () => {
		const payload = JSON.stringify({ b: 2, a: 1 });
		const row = await appendRecordVersion(db, {
			entityType: "consultation.anamnesis",
			entityId: 1,
			payload,
			actorUserId: "u1",
		});
		expect(row.version).toBe(1);
		expect(row.prevHash).toBeNull();
		expect(row.contentHash).toBe(await contentHash({ b: 2, a: 1 }));
		expect(row.blobHash).toBe(await sha256Hex(payload));
		expect(row.signature).toBeNull();
		expect(row.engine).toBeNull();
		expect(row.actorUserId).toBe("u1");
		expect(row.createdAt).toBeInstanceOf(Date);
	});

	it("chains subsequent versions through prev_hash", async () => {
		const first = await appendRecordVersion(db, {
			entityType: "consultation.anamnesis",
			entityId: 2,
			payload: JSON.stringify({ v: 1 }),
			actorUserId: "u1",
		});
		const second = await appendRecordVersion(db, {
			entityType: "consultation.anamnesis",
			entityId: 2,
			payload: JSON.stringify({ v: 2 }),
			actorUserId: "u1",
		});
		expect(second.version).toBe(2);
		expect(second.prevHash).toBe(first.contentHash);
	});

	it("keeps client-supplied contentHash and signature verbatim", async () => {
		const row = await appendRecordVersion(db, {
			entityType: "consultation.anamnesis",
			entityId: 3,
			payload: "v1.AAAA.BBBB",
			contentHash: "ab".repeat(32),
			signature: "c2ln",
			engine: "zk-client",
			actorUserId: "u1",
		});
		// The client hash wins over any server-side derivation — the
		// server cannot see plaintext for ZK rows.
		expect(row.contentHash).toBe("ab".repeat(32));
		expect(row.signature).toBe("c2ln");
		expect(row.engine).toBe("zk-client");
		expect(row.blobHash).toBe(await sha256Hex("v1.AAAA.BBBB"));
	});

	it("falls back to a byte-level hash for opaque payloads", async () => {
		const payload = "v1.not-json.ciphertext";
		const row = await appendRecordVersion(db, {
			entityType: "consultation.anamnesis",
			entityId: 4,
			payload,
			actorUserId: null,
		});
		expect(row.contentHash).toBe(await sha256Hex(payload));
		expect(row.blobHash).toBe(row.contentHash);
	});

	it("honors a createdAt override (backfills)", async () => {
		const when = new Date("2024-01-02T03:04:05Z");
		const row = await appendRecordVersion(db, {
			entityType: "patient.record",
			entityId: "p-1",
			payload: "{}",
			actorUserId: null,
			createdAt: when,
		});
		expect(row.createdAt.getTime()).toBe(when.getTime());
	});

	it("latestRecordVersion returns null for unversioned entities", async () => {
		expect(await latestRecordVersion(db, "consultation.anamnesis", 9999)).toBeNull();
	});

	it("listRecordVersions walks the chain oldest-first", async () => {
		const rows = await listRecordVersions(db, "consultation.anamnesis", 2);
		expect(rows.map((r) => r.version)).toEqual([1, 2]);
		expect(rows[1]!.prevHash).toBe(rows[0]!.contentHash);
	});
});

describe("Integrity service", () => {
	let db: ReturnType<typeof makeDb>;
	let runtime: ManagedRuntime.ManagedRuntime<Integrity, never>;

	beforeAll(() => {
		db = makeDb(makeD1(DDL));
		runtime = makeRuntime(db);
	});

	it("records with the bound Principal as actor", async () => {
		const row = await run(
			runtime,
			Integrity.pipe(
				Effect.flatMap((i) =>
					i.record({
						entityType: "consultation.anamnesis",
						entityId: 10,
						payload: JSON.stringify({ q: "dor" }),
						engine: "stub",
					}),
				),
			),
			{ userId: "u-doc" },
		);
		expect(row.version).toBe(1);
		expect(row.actorUserId).toBe("u-doc");
		expect(row.engine).toBe("stub");
	});

	it("lets an explicit actorUserId override the Principal (backfill)", async () => {
		const row = await run(
			runtime,
			Integrity.pipe(
				Effect.flatMap((i) =>
					i.record({
						entityType: "consultation.anamnesis",
						entityId: 11,
						payload: "{}",
						actorUserId: "u-owner",
					}),
				),
			),
			{ userId: "u-admin" },
		);
		expect(row.actorUserId).toBe("u-owner");
	});

	it("records with a null actor in system contexts", async () => {
		const row = await run(
			runtime,
			Integrity.pipe(
				Effect.flatMap((i) =>
					i.record({ entityType: "consultation.anamnesis", entityId: 12, payload: "{}" }),
				),
			),
		);
		expect(row.actorUserId).toBeNull();
	});

	it("lists versions for an entity", async () => {
		const rows = await run(
			runtime,
			Integrity.pipe(Effect.flatMap((i) => i.versions("consultation.anamnesis", 10))),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.version).toBe(1);
	});
});

describe("recordVersion helper", () => {
	it("returns the row when the service is present", async () => {
		const db = makeDb(makeD1(DDL));
		const runtime = makeRuntime(db);
		const row = await run(
			runtime,
			recordVersion({
				entityType: "consultation.anamnesis",
				entityId: 20,
				payload: "{}",
			}),
		);
		expect(row?.version).toBe(1);
	});

	it("returns null when the integrity plugin is absent", async () => {
		const runtime = ManagedRuntime.make(Layer.empty);
		const row = await runtime.runPromise(
			Effect.provideService(
				recordVersion({ entityType: "x", entityId: 1, payload: "{}" }),
				Principal,
				null,
			),
		);
		expect(row).toBeNull();
	});

	it("returns null (and never fails) when the write itself fails", async () => {
		const failing = Layer.succeed(
			Integrity,
			Integrity.of({
				record: () => Effect.die("db gone"),
				versions: () => Effect.succeed([]),
			}),
		);
		const runtime = ManagedRuntime.make(failing);
		const row = await runtime.runPromise(
			Effect.provideService(
				recordVersion({ entityType: "x", entityId: 1, payload: "{}" }),
				Principal,
				null,
			),
		);
		expect(row).toBeNull();
	});
});

describe("plugin shape", () => {
	it("contributes the tables and services plugins", () => {
		expect(plugins).toEqual([integrityTablesPlugin, integrityServicesPlugin]);
		expect(integrityTablesPlugin.id).toBe("integrity.tables");
		expect(integrityServicesPlugin.id).toBe("integrity.services");
	});

	it("exposes the drizzle table for schema aggregation", () => {
		expect(recordVersions).toBeDefined();
	});
});
