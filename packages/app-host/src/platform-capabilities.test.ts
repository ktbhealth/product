import type { JobHandlers, JobRegistration } from "@ktb/jobs-port";
import type {
	EventTopicDeclaration,
	JobKindDeclaration,
	SchedulableDeclaration,
} from "@ktb/platform/capabilities";
import { describe, expect, it } from "vitest";

import {
	compileSchedulableValidators,
	eventTopicInfos,
	jobKindInfos,
	scheduleKindDispatchable,
	scheduleParamsError,
	schedulableKindInfos,
} from "./platform-capabilities.ts";

const handle = async () => {};
const reg = (extra: Partial<JobRegistration> = {}): JobRegistration => ({ handle, ...extra });

const schedDecl = (extra: Partial<SchedulableDeclaration> = {}): SchedulableDeclaration => ({
	id: "s1",
	pluginId: "p",
	kind: "jobs.ping",
	...extra,
});

describe("compileSchedulableValidators", () => {
	it("returns an empty map for no declarations", () => {
		expect(compileSchedulableValidators([]).size).toBe(0);
	});

	it("skips declarations without paramsSchema", () => {
		const validators = compileSchedulableValidators([schedDecl()]);
		expect(validators.size).toBe(0);
	});

	it("compiles object schemas and groups validators by kind", () => {
		const validators = compileSchedulableValidators([
			schedDecl({ id: "a", paramsSchema: { type: "object" } }),
			schedDecl({ id: "b", kind: "other.kind", paramsSchema: { type: "object" } }),
			schedDecl({ id: "c", paramsSchema: { type: "object", required: ["x"] } }),
		]);
		expect(validators.get("jobs.ping")).toHaveLength(2);
		expect(validators.get("other.kind")).toHaveLength(1);
	});

	it.each([[42], ["schema"], [["type"]], [null]])(
		"throws on non-object paramsSchema %j",
		(paramsSchema) => {
			expect(() => compileSchedulableValidators([schedDecl({ paramsSchema })])).toThrow(
				/must be a JSON Schema object/,
			);
		},
	);
});

describe("scheduleKindDispatchable", () => {
	const handlers: JobHandlers = { "reg.kind": reg() };
	const decls = [schedDecl({ kind: "decl.kind" })];

	it("accepts registered kinds", () => {
		expect(scheduleKindDispatchable("reg.kind", handlers, decls)).toBe(true);
	});

	it("accepts kinds declared schedulable", () => {
		expect(scheduleKindDispatchable("decl.kind", handlers, decls)).toBe(true);
	});

	it("rejects kinds that are neither", () => {
		expect(scheduleKindDispatchable("ghost", handlers, decls)).toBe(false);
	});
});

describe("scheduleParamsError", () => {
	const validators = compileSchedulableValidators([
		schedDecl({ paramsSchema: { type: "object", required: ["x"] } }),
	]);

	it("accepts kinds without declared validators", () => {
		expect(scheduleParamsError("other", {}, validators)).toBeNull();
	});

	it("accepts params satisfying the schema", () => {
		expect(scheduleParamsError("jobs.ping", { x: 1 }, validators)).toBeNull();
	});

	it("defaults missing params to an empty object", () => {
		const anyObject = compileSchedulableValidators([
			schedDecl({ paramsSchema: { type: "object" } }),
		]);
		expect(scheduleParamsError("jobs.ping", undefined, anyObject)).toBeNull();
	});

	it("rejects params violating every declared schema", () => {
		const error = scheduleParamsError("jobs.ping", { y: 1 }, validators);
		expect(error).toContain("jobs.ping");
		expect(error).toContain("must have required property");
	});
});

describe("jobKindInfos", () => {
	const handlers: JobHandlers = {
		"reg.only": reg(),
		"reg.full": reg({ concurrency: 2, maxAttempts: 3, idempotent: true }),
		"both.kind": reg({ concurrency: 5, idempotent: true }),
		"decl.full": reg(),
	};
	const kindDecls: JobKindDeclaration[] = [
		{
			kind: "both.kind",
			pluginId: "p1",
			description: "both",
			concurrency: 9,
			maxAttempts: 4,
			idempotent: false,
		},
		{ kind: "decl.full", pluginId: "p3", concurrency: 1, maxAttempts: 2, idempotent: false },
		{ kind: "decl.only", pluginId: "p2" },
	];
	const schedulableDecls = [schedDecl({ kind: "sched.kind" })];

	it("merges registrations and declarations sorted by kind", () => {
		const infos = jobKindInfos(handlers, kindDecls, schedulableDecls);
		expect(infos.map((info) => info.kind)).toEqual([
			"both.kind",
			"decl.full",
			"decl.only",
			"reg.full",
			"reg.only",
			"sched.kind",
		]);
	});

	it("marks registered and schedulable flags", () => {
		const byKind = new Map(
			jobKindInfos(handlers, kindDecls, schedulableDecls).map((i) => [i.kind, i]),
		);
		expect(byKind.get("reg.only")).toMatchObject({ registered: true, schedulable: false });
		expect(byKind.get("decl.only")).toMatchObject({ registered: false, schedulable: false });
		expect(byKind.get("sched.kind")).toMatchObject({ registered: false, schedulable: true });
	});

	it("prefers registration hints over declared ones", () => {
		const both = jobKindInfos(handlers, kindDecls, schedulableDecls).find(
			(i) => i.kind === "both.kind",
		);
		expect(both).toMatchObject({
			pluginId: "p1",
			description: "both",
			concurrency: 5,
			maxAttempts: 4,
			idempotent: true,
		});
	});

	it("falls back to declared hints when registration leaves them unset", () => {
		const declFull = jobKindInfos(handlers, kindDecls, schedulableDecls).find(
			(i) => i.kind === "decl.full",
		);
		expect(declFull).toMatchObject({
			pluginId: "p3",
			concurrency: 1,
			maxAttempts: 2,
			idempotent: false,
		});
		expect(declFull).not.toHaveProperty("description");
	});

	it("reports registration hints and defaults idempotent to false", () => {
		const byKind = new Map(
			jobKindInfos(handlers, kindDecls, schedulableDecls).map((i) => [i.kind, i]),
		);
		expect(byKind.get("reg.full")).toMatchObject({
			concurrency: 2,
			maxAttempts: 3,
			idempotent: true,
		});
		expect(byKind.get("reg.only")).toMatchObject({ idempotent: false });
		expect(byKind.get("reg.only")).not.toHaveProperty("concurrency");
		expect(byKind.get("reg.only")).not.toHaveProperty("pluginId");
		expect(byKind.get("sched.kind")).not.toHaveProperty("pluginId");
	});
});

describe("schedulableKindInfos", () => {
	it("maps full and minimal declarations", () => {
		const infos = schedulableKindInfos([
			schedDecl({
				description: "hourly",
				paramsSchema: { type: "object" },
				suggestedCronExpr: "0 * * * *",
				suggestedParams: { v: 1 },
			}),
			schedDecl({ id: "s2", kind: "other.kind" }),
		]);
		expect(infos[0]).toEqual({
			id: "s1",
			kind: "jobs.ping",
			pluginId: "p",
			description: "hourly",
			paramsSchema: { type: "object" },
			suggestedCronExpr: "0 * * * *",
			suggestedParams: { v: 1 },
		});
		expect(infos[1]).toEqual({ id: "s2", kind: "other.kind", pluginId: "p" });
	});
});

describe("eventTopicInfos", () => {
	it("maps full and minimal declarations", () => {
		const decls: EventTopicDeclaration[] = [
			{
				topic: "cron.fires",
				pluginId: "p1",
				description: "fired",
				payloadSchema: { type: "object" },
			},
			{ topic: "bare", pluginId: "p2" },
		];
		expect(eventTopicInfos(decls)).toEqual([
			{
				topic: "cron.fires",
				pluginId: "p1",
				description: "fired",
				payloadSchema: { type: "object" },
			},
			{ topic: "bare", pluginId: "p2" },
		]);
	});
});
