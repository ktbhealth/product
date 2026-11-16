import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditVerifyResult } from "@ktb/audit";
import type { DbClient } from "@ktb/db";

import {
	AUDIT_CHAIN_TAMPERED_ACTION,
	recordAuditChainTamper,
	runScheduledAuditVerification,
} from "./audit-chain.ts";

const db = {} as DbClient;

const result = (over: Partial<AuditVerifyResult>): AuditVerifyResult => ({
	status: "verified",
	entries: 0,
	brokenAt: null,
	...over,
});

const silence = () => {
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runScheduledAuditVerification", () => {
	it("logs verified runs at info level and returns the result", async () => {
		silence();
		const verify = vi.fn<(db: DbClient) => Promise<AuditVerifyResult>>(async () =>
			result({ status: "verified", entries: 7 }),
		);
		const recordTamper = vi.fn<() => Promise<unknown>>();
		const out = await runScheduledAuditVerification({ db, verify, recordTamper });
		expect(out).toEqual(result({ status: "verified", entries: 7 }));
		expect(verify).toHaveBeenCalledWith(db);
		expect(recordTamper).not.toHaveBeenCalled();
		expect(console.info).toHaveBeenCalledWith(
			expect.stringContaining('"message":"audit.chain.verified"'),
		);
	});

	it("logs empty runs without writing a tamper marker", async () => {
		silence();
		const recordTamper = vi.fn<() => Promise<unknown>>();
		const out = await runScheduledAuditVerification({
			db,
			verify: async () => result({ status: "empty" }),
			recordTamper,
		});
		expect(out?.status).toBe("empty");
		expect(recordTamper).not.toHaveBeenCalled();
		expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"status":"empty"'));
	});

	it("logs tampered runs at error level and records the marker row", async () => {
		silence();
		const tampered = result({ status: "tampered", entries: 12, brokenAt: 42 });
		const recordTamper = vi.fn<() => Promise<unknown>>(async () => ({}));
		const out = await runScheduledAuditVerification({
			db,
			verify: async () => tampered,
			recordTamper,
		});
		expect(out).toBe(tampered);
		expect(recordTamper).toHaveBeenCalledWith(db, tampered);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('"message":"audit.chain.tampered"'),
		);
	});

	it("still reports the tamper when the marker write fails", async () => {
		silence();
		const tampered = result({ status: "tampered", entries: 3, brokenAt: 9 });
		const out = await runScheduledAuditVerification({
			db,
			verify: async () => tampered,
			recordTamper: async () => {
				throw new Error("db down");
			},
		});
		expect(out).toBe(tampered);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('"message":"audit.chain.tamper-marker.failed"'),
		);
	});

	it("logs and returns null when the verification itself throws", async () => {
		silence();
		const recordTamper = vi.fn<() => Promise<unknown>>();
		const out = await runScheduledAuditVerification({
			db,
			verify: async () => {
				throw new Error("walk exploded");
			},
			recordTamper,
		});
		expect(out).toBeNull();
		expect(recordTamper).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('"message":"audit.chain.verify.failed"'),
		);
	});
});

describe("recordAuditChainTamper", () => {
	it("writes a system audit row naming the broken link", async () => {
		const inserted: unknown[] = [];
		const fakeDb = {
			select: () => ({
				from: () => ({
					orderBy: () => ({ limit: async () => [] }),
				}),
			}),
			insert: () => ({
				values: (v: unknown) => ({
					returning: async () => {
						inserted.push(v);
						return [v];
					},
				}),
			}),
		} as unknown as DbClient;
		await recordAuditChainTamper(fakeDb, result({ status: "tampered", entries: 5, brokenAt: 77 }));
		const row = inserted[0] as Record<string, unknown>;
		expect(row.action).toBe(AUDIT_CHAIN_TAMPERED_ACTION);
		expect(row.targetType).toBe("audit");
		expect(row.targetId).toBe("77");
		expect(row.actorUserId).toBeNull();
		expect(row.actorEmail).toBeNull();
		expect(JSON.parse(row.detail as string)).toEqual({ brokenAt: 77, entries: 5 });
	});
});
