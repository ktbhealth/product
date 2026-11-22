/* eslint-disable vitest/no-standalone-expect */
// describe/it below come from vi.importActual, which the plugin cannot
// resolve back to vitest — the expects are inside real test blocks.
import { integer, text } from "drizzle-orm/sqlite-core";
import * as Effect from "effect/Effect";
import { expect, vi } from "vitest";

import type { SqlDatabase } from "@ktb/db";

import { Tenant } from "./index.ts";
import { tenantIdColumn, tenantTable } from "./schema.ts";
import {
	tenantIsolationSuite,
	type TenantIsolationConfig,
	type TenantIsolationEngine,
	type TenantIsolationFixture,
} from "./testing.ts";

/**
 * Self-tests for {@link tenantIsolationSuite}: the harness IS the guard
 * under test, so these specs mock vitest's `describe`/`it` to capture
 * what the suite registers, then drive the captured test body with
 * probes that violate each isolation rule. A probe that leaks, hides
 * in-scope rows, or leaks into personal scope MUST make the captured
 * test fail — if the harness's assertions are mutated away, these
 * specs fail instead.
 */
const collected = vi.hoisted(() => ({
	describes: [] as string[],
	its: [] as Array<{ name: string; run: () => Promise<void> }>,
}));

vi.mock("vitest", async (importOriginal) => {
	const mod = await importOriginal<typeof import("vitest")>();
	return {
		...mod,
		describe: (name: string, fn: () => void) => {
			collected.describes.push(name);
			fn();
		},
		it: (name: string, fn: () => Promise<void>) => {
			collected.its.push({ name, run: fn });
		},
	};
});

// The mocked module's describe/it only record registrations; our own
// specs need the real ones, hence importActual.
const { describe, it } = await vi.importActual<typeof import("vitest")>("vitest");

const docs = tenantTable("harness_probe_docs", {
	id: integer().primaryKey({ autoIncrement: true }),
	tenantId: tenantIdColumn(),
	title: text().notNull(),
});

const TENANT_A: Tenant = { id: 1, kind: "clinic", slug: "a", role: "member" };
const TENANT_B: Tenant = { id: 2, kind: "clinic", slug: "b", role: "member" };

const FIXTURE: TenantIsolationFixture = {
	tenantA: [11],
	tenantB: [22],
	personal: [33],
};

const fakeSql = {
	prepare: () => {
		throw new Error("not used");
	},
	dump: async () => new ArrayBuffer(0),
	batch: async () => [],
	exec: async () => ({ count: 0, duration: 0 }),
} as unknown as SqlDatabase;

const FAKE_ENGINE: TenantIsolationEngine = { name: "fake-engine", open: () => fakeSql };

type Probe = (tenant: Tenant | null) => readonly unknown[];

/** Register a suite whose probe reports `probe(tenant)` ids, and return
 * the captured `it` body. */
const runSuite = (probe: Probe, engines?: readonly TenantIsolationEngine[]) => {
	collected.describes.length = 0;
	collected.its.length = 0;
	const config: TenantIsolationConfig<typeof docs> = {
		name: "probe isolation",
		table: docs,
		tenants: { a: TENANT_A, b: TENANT_B },
		...(engines === undefined ? {} : { engines }),
		setup: () => {},
		seed: async () => FIXTURE,
		ids: () =>
			Effect.gen(function* () {
				const tenant = yield* Tenant;
				return probe(tenant);
			}),
	};
	tenantIsolationSuite(config);
	return collected.its[0]!.run;
};

/** The correct probe: tenant A sees [11, 33], tenant B sees [22, 33],
 * personal scope sees [33]. */
const correctProbe: Probe = (tenant) => {
	if (tenant === null) return [33];
	return tenant.id === 1 ? [11, 33] : [22, 33];
};

describe("tenantIsolationSuite harness", () => {
	it("registers a describe per engine plus the shared leak test", () => {
		runSuite(correctProbe, [FAKE_ENGINE]);
		expect(collected.describes).toEqual(["probe isolation", "fake-engine"]);
		expect(collected.its).toHaveLength(1);
		expect(collected.its[0]!.name).toBe("scopes reads to the active tenant plus personal rows");
	});

	it("defaults to the in-memory sqlite engine", () => {
		runSuite(correctProbe);
		expect(collected.describes).toEqual(["probe isolation", "sqlite"]);
	});

	it("passes when the probe respects the scope", async () => {
		const run = runSuite(correctProbe, [FAKE_ENGINE]);
		await expect(run()).resolves.toBeUndefined();
	});

	it("fails when a probe leaks foreign-tenant rows", async () => {
		const run = runSuite((tenant) => (tenant === null ? [33] : [11, 22, 33]), [FAKE_ENGINE]);
		await expect(run()).rejects.toThrow(/leaked across tenants/);
	});

	it("fails when a probe hides in-scope rows", async () => {
		// Tenant scopes return their own rows but omit the personal row —
		// only the visible-rows assertion can catch this.
		const run = runSuite(
			(tenant) => (tenant === null ? [33] : [tenant.id === 1 ? 11 : 22]),
			[FAKE_ENGINE],
		);
		await expect(run()).rejects.toThrow(/to be visible/);
	});

	it("fails when a probe hides personal rows in personal scope", async () => {
		const run = runSuite((tenant) => (tenant === null ? [] : correctProbe(tenant)), [FAKE_ENGINE]);
		await expect(run()).rejects.toThrow(/to include 33/);
	});

	it("fails when tenant rows leak into personal scope", async () => {
		const run = runSuite(
			(tenant) => (tenant === null ? [11, 22, 33] : correctProbe(tenant)),
			[FAKE_ENGINE],
		);
		await expect(run()).rejects.toThrow(/leaked into personal scope/);
	});
});
