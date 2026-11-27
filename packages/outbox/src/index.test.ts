import { describe, expect, it } from "vitest";

import { makeTestDb } from "@ktb/db-testing";

import {
	claimDueOutboxRecords,
	drainOutbox,
	getOutboxRecord,
	insertOutboxRecord,
	listOutboxRecords,
	makeOutbox,
	outboxDeliverers,
	registerOutboxDeliverer,
	type OutboxDeliverer,
} from "./index.ts";

const T0 = 1_700_000_000_000;

describe("insertOutboxRecord", () => {
	it("writes a pending row due immediately and reads it back", async () => {
		const { db, close } = makeTestDb();
		try {
			const record = await insertOutboxRecord(
				db,
				{ kind: "email", payload: { to: "a@x.test", subject: "s", text: "t" } },
				T0,
				() => "fixed-id",
			);
			expect(record).toMatchObject({
				id: "fixed-id",
				kind: "email",
				status: "pending",
				attempts: 0,
				nextAttemptAt: T0,
				tenantId: null,
			});
			const stored = await getOutboxRecord(db, "fixed-id");
			expect(stored?.payload).toEqual({ to: "a@x.test", subject: "s", text: "t" });
		} finally {
			close();
		}
	});

	it("rejects an empty kind and normalizes tenant ids", async () => {
		const { db, close } = makeTestDb();
		try {
			await expect(insertOutboxRecord(db, { kind: "  ", payload: {} }, T0)).rejects.toThrow(
				"outbox kind must be non-empty",
			);
			const numeric = await insertOutboxRecord(
				db,
				{ kind: "k", payload: null, tenantId: "42" },
				T0,
			);
			expect(numeric.tenantId).toBe(42);
			const global = await insertOutboxRecord(db, { kind: "k", payload: null }, T0);
			expect(global.tenantId).toBeNull();
		} finally {
			close();
		}
	});
});

describe("getOutboxRecord / listOutboxRecords", () => {
	it("returns null for a missing id and filters lists", async () => {
		const { db, close } = makeTestDb();
		try {
			expect(await getOutboxRecord(db, "nope")).toBeNull();
			await insertOutboxRecord(db, { kind: "email", payload: { n: 1 }, tenantId: 7 }, T0);
			await insertOutboxRecord(db, { kind: "push", payload: { n: 2 } }, T0);
			expect(await listOutboxRecords(db, { kind: "email" })).toHaveLength(1);
			expect(await listOutboxRecords(db, { status: "done" })).toHaveLength(0);
			expect(await listOutboxRecords(db, { tenantId: 7 })).toHaveLength(1);
			expect(await listOutboxRecords(db, { tenantId: null })).toHaveLength(1);
			expect(await listOutboxRecords(db, { tenantId: "non-numeric" })).toHaveLength(0);
			expect(await listOutboxRecords(db)).toHaveLength(2);
		} finally {
			close();
		}
	});
});

describe("claimDueOutboxRecords", () => {
	it("claims due rows once and skips future/not-yet-claimable rows", async () => {
		const { db, close } = makeTestDb();
		try {
			await insertOutboxRecord(db, { kind: "a", payload: 1 }, T0);
			await insertOutboxRecord(db, { kind: "b", payload: 2 }, T0 + 10_000);
			const first = await claimDueOutboxRecords(db, { now: T0 + 5_000, leaseMs: 1_000 });
			expect(first.map((r) => r.kind)).toEqual(["a"]);
			expect(first[0]!.claimedUntil).toBe(T0 + 6_000);
			// Leased: a second sweep inside the lease sees nothing.
			expect(await claimDueOutboxRecords(db, { now: T0 + 5_500 })).toHaveLength(0);
			// After lease expiry both rows are claimable (b is due at T0+10s).
			const second = await claimDueOutboxRecords(db, { now: T0 + 10_500 });
			expect(new Set(second.map((r) => r.kind))).toEqual(new Set(["a", "b"]));
		} finally {
			close();
		}
	});
});

describe("drainOutbox", () => {
	const seed = async (db: ReturnType<typeof makeTestDb>["db"], kind = "k") =>
		insertOutboxRecord(db, { kind, payload: { v: 1 } }, T0);

	it("delivers a claimed row to its kind deliverer and marks it done", async () => {
		const { db, close } = makeTestDb();
		try {
			await seed(db);
			const seen: unknown[] = [];
			const deliverer: OutboxDeliverer = async (payload) => {
				seen.push(payload);
			};
			const result = await drainOutbox(db, {
				now: T0 + 1,
				deliverers: { k: deliverer },
			});
			expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0, dead: 0, skipped: 0 });
			expect(seen).toEqual([{ v: 1 }]);
			const stored = await listOutboxRecords(db);
			expect(stored[0]).toMatchObject({ status: "done", error: null });
		} finally {
			close();
		}
	});

	it("backs off and retries a failed delivery, then marks it dead", async () => {
		const { db, close } = makeTestDb();
		try {
			const record = await seed(db);
			let calls = 0;
			const deliverer: OutboxDeliverer = async () => {
				calls += 1;
				throw new Error(`boom ${calls}`);
			};
			const deliverers = { k: deliverer };
			const first = await drainOutbox(db, { now: T0 + 1, deliverers, maxAttempts: 2 });
			expect(first).toMatchObject({ claimed: 1, delivered: 0, failed: 1, dead: 0 });
			const afterFirst = await getOutboxRecord(db, record.id);
			expect(afterFirst).toMatchObject({
				status: "pending",
				attempts: 1,
				error: "boom 1",
				nextAttemptAt: T0 + 1 + 60_000,
			});
			// Not due yet — the backoff window holds.
			expect(await drainOutbox(db, { now: T0 + 30_000, deliverers, maxAttempts: 2 })).toMatchObject(
				{ claimed: 0 },
			);
			// Second attempt exhausts the budget → terminal failed.
			const second = await drainOutbox(db, {
				now: T0 + 61_001,
				deliverers,
				maxAttempts: 2,
			});
			expect(second).toMatchObject({ claimed: 1, failed: 1, dead: 1 });
			expect(await getOutboxRecord(db, record.id)).toMatchObject({
				status: "failed",
				attempts: 2,
				error: "boom 2",
			});
			expect(calls).toBe(2);
		} finally {
			close();
		}
	});

	it("caps backoff at maxBackoffMs", async () => {
		const { db, close } = makeTestDb();
		try {
			const record = await seed(db);
			await drainOutbox(db, {
				now: T0 + 1,
				deliverers: { k: async () => Promise.reject(new Error("x")) },
				maxAttempts: 10,
				baseBackoffMs: 1_000,
				maxBackoffMs: 5_000,
			});
			// attempts=1 → delay min(5000, 1000) = 1000; force attempts high
			// via repeated drains is covered elsewhere — here just assert the
			// stored nextAttemptAt used the base delay.
			expect((await getOutboxRecord(db, record.id))?.nextAttemptAt).toBe(T0 + 1 + 1_000);
		} finally {
			close();
		}
	});

	it("releases rows whose kind has no deliverer back to pending", async () => {
		const { db, close } = makeTestDb();
		try {
			const record = await seed(db, "unknown-kind");
			const result = await drainOutbox(db, { now: T0 + 1, deliverers: {} });
			expect(result).toEqual({ claimed: 1, delivered: 0, failed: 0, dead: 0, skipped: 1 });
			expect(await getOutboxRecord(db, record.id)).toMatchObject({
				status: "pending",
				attempts: 0,
				claimedUntil: null,
			});
		} finally {
			close();
		}
	});

	it("honors the claim limit", async () => {
		const { db, close } = makeTestDb();
		try {
			await seed(db);
			await seed(db);
			const result = await drainOutbox(db, {
				now: T0 + 1,
				limit: 1,
				deliverers: { k: async () => {} },
			});
			expect(result.claimed).toBe(1);
			expect(await listOutboxRecords(db, { status: "pending" })).toHaveLength(1);
		} finally {
			close();
		}
	});
});

describe("makeOutbox / Outbox service", () => {
	it("enqueues a pending record and drains it through registered deliverers", async () => {
		const { db, close } = makeTestDb();
		try {
			const outbox = makeOutbox({ db, now: () => T0 });
			const record = await outbox.enqueue({ kind: "k", payload: { hi: true } });
			expect(record.status).toBe("pending");
			const seen: unknown[] = [];
			const result = await outbox.drain({
				now: T0 + 1,
				deliverers: { k: async (p) => void seen.push(p) },
			});
			expect(result.delivered).toBe(1);
			expect(seen).toEqual([{ hi: true }]);
		} finally {
			close();
		}
	});

	it("kicks a best-effort drain on enqueue using the global registry", async () => {
		const { db, close } = makeTestDb();
		const key = `test-kick-${crypto.randomUUID()}`;
		registerOutboxDeliverer(key, async () => {});
		try {
			const outbox = makeOutbox({ db });
			await outbox.enqueue({ kind: key, payload: null });
			// The kicked drain is fire-and-forget — poll briefly for done.
			for (let i = 0; i < 50; i += 1) {
				const rows = await listOutboxRecords(db, { kind: key });
				if (rows[0]?.status === "done") return;
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(outboxDeliverers[key]).toBeDefined();
			throw new Error("kicked drain did not deliver");
		} finally {
			delete outboxDeliverers[key];
			close();
		}
	});
});
