import type { Plugin } from "@ktb/kernel";
import { describe, expect, it } from "vitest";
import {
	collectEventTopicDeclarations,
	collectJobKindDeclarations,
	collectSchedulableDeclarations,
	eventTopicContribution,
	JOB_KIND,
	jobKindContribution,
	SCHEDULABLE_KIND,
	schedulableContribution,
} from "./capabilities.ts";

const plugin = (id: string, contributions: Plugin["contributions"]): Plugin =>
	({ id, contributions }) as Plugin;

describe("contribution builders", () => {
	it("builds jobs.kind entries keyed by kind", () => {
		const entry = jobKindContribution("eval.run", { description: "runs evals" });
		expect(entry).toEqual({
			kind: JOB_KIND,
			id: "eval.run",
			meta: { description: "runs evals" },
		});
	});

	it("builds jobs.schedulable entries with kind in meta", () => {
		const entry = schedulableContribution("nightly", {
			kind: "jobs.ping",
			suggestedCronExpr: "0 3 * * *",
		});
		expect(entry.kind).toBe(SCHEDULABLE_KIND);
		expect(entry.id).toBe("nightly");
		expect(entry.meta?.kind).toBe("jobs.ping");
	});

	it("builds events.topic entries keyed by topic", () => {
		const entry = eventTopicContribution("cron.fires", { description: "cron fired" });
		expect(entry.id).toBe("cron.fires");
		expect(entry.meta?.description).toBe("cron fired");
	});
});

describe("collectJobKindDeclarations", () => {
	it("collects declarations across plugins in order", () => {
		const plugins = [
			plugin("a", [jobKindContribution("jobs.ping", { description: "ping" })]),
			plugin("b", [
				jobKindContribution("eval.run", {
					concurrency: 2,
					maxAttempts: 3,
					idempotent: true,
				}),
			]),
		];
		const decls = collectJobKindDeclarations(plugins);
		expect(decls).toEqual([
			{ kind: "jobs.ping", pluginId: "a", description: "ping" },
			{
				kind: "eval.run",
				pluginId: "b",
				concurrency: 2,
				maxAttempts: 3,
				idempotent: true,
			},
		]);
	});

	it("ignores other contribution kinds", () => {
		const plugins = [
			plugin("a", [
				{ kind: "route", id: "x", meta: { path: "/x" } },
				schedulableContribution("s", { kind: "jobs.ping" }),
			]),
		];
		expect(collectJobKindDeclarations(plugins)).toEqual([]);
	});

	it("throws on duplicate kind ids", () => {
		const plugins = [
			plugin("a", [jobKindContribution("jobs.ping")]),
			plugin("b", [jobKindContribution("jobs.ping")]),
		];
		expect(() => collectJobKindDeclarations(plugins)).toThrow(/duplicate/);
	});

	it("throws on invalid meta", () => {
		const plugins = [plugin("a", [{ kind: JOB_KIND, id: "x", meta: { concurrency: "lots" } }])];
		expect(() => collectJobKindDeclarations(plugins)).toThrow(/invalid/);
	});
});

describe("collectSchedulableDeclarations", () => {
	it("collects entries and keeps meta.kind distinct from entry id", () => {
		const plugins = [
			plugin("a", [
				schedulableContribution("ping.hourly", {
					kind: "jobs.ping",
					description: "hourly ping",
					paramsSchema: { type: "object" },
					suggestedCronExpr: "0 * * * *",
					suggestedParams: {},
				}),
			]),
		];
		const decls = collectSchedulableDeclarations(plugins);
		expect(decls).toHaveLength(1);
		expect(decls[0]).toMatchObject({
			id: "ping.hourly",
			pluginId: "a",
			kind: "jobs.ping",
			description: "hourly ping",
			suggestedCronExpr: "0 * * * *",
		});
		expect(decls[0]?.paramsSchema).toEqual({ type: "object" });
	});

	it("allows multiple entries targeting the same kind", () => {
		const plugins = [
			plugin("a", [
				schedulableContribution("s1", { kind: "jobs.ping" }),
				schedulableContribution("s2", { kind: "jobs.ping" }),
			]),
		];
		expect(collectSchedulableDeclarations(plugins)).toHaveLength(2);
	});

	it("throws when meta.kind is missing", () => {
		const plugins = [plugin("a", [{ kind: SCHEDULABLE_KIND, id: "bad", meta: {} }])];
		expect(() => collectSchedulableDeclarations(plugins)).toThrow(/invalid/);
	});
});

describe("collectEventTopicDeclarations", () => {
	it("collects topic declarations", () => {
		const plugins = [
			plugin("a", [
				eventTopicContribution("cron.fires", {
					description: "a cron job fired",
					payloadSchema: { type: "object" },
				}),
			]),
		];
		expect(collectEventTopicDeclarations(plugins)).toEqual([
			{
				topic: "cron.fires",
				pluginId: "a",
				description: "a cron job fired",
				payloadSchema: { type: "object" },
			},
		]);
	});

	it("throws on duplicate topics", () => {
		const plugins = [
			plugin("a", [eventTopicContribution("t")]),
			plugin("b", [eventTopicContribution("t")]),
		];
		expect(() => collectEventTopicDeclarations(plugins)).toThrow(/duplicate/);
	});
});
