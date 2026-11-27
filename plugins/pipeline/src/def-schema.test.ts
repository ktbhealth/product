import { describe, expect, it } from "vitest";

import type { OrchestrationDef } from "@ktb/orchestrator";

import { decodeOrchestrationDef, defIssues } from "./def-schema.ts";

const validDef: OrchestrationDef = {
	id: "demo",
	version: "2",
	description: "demo orchestration",
	onNodeError: "continue",
	config: { retries: 3 },
	nodes: [
		{
			id: "start-node",
			kind: "emit",
			on: ["start"],
			emits: ["kickoff"],
			params: { events: [{ type: "kickoff", payload: { n: 1 } }] },
		},
		{
			id: "gate-node",
			kind: "gate",
			on: ["kickoff"],
			emits: ["gate.pass"],
			params: { when: { path: "payload.n", equals: 1 }, passEvent: "gate.pass" },
			maxFires: 5,
			retry: { maxAttempts: 2, backoffMs: 50 },
			fanIn: { count: 2 },
		},
		{
			id: "ai-node",
			kind: "ai",
			on: ["gate.pass"],
			emits: [],
			state: { seen: 0 },
		},
	],
	eventSchemas: [{ type: "kickoff", fields: { n: "number" } }],
};

describe("decodeOrchestrationDef", () => {
	it("accepts a full data-only def", () => {
		const decoded = decodeOrchestrationDef(JSON.parse(JSON.stringify(validDef)));
		expect(decoded.id).toBe("demo");
		expect(decoded.nodes).toHaveLength(3);
		expect(decoded.nodes[1]?.fanIn).toEqual({ count: 2 });
	});

	it("accepts a minimal def (id + nodes only)", () => {
		const decoded = decodeOrchestrationDef({
			id: "minimal",
			nodes: [{ id: "n", kind: "emit", on: [], emits: [] }],
		});
		expect(decoded.version).toBeUndefined();
		expect(decoded.nodes[0]?.params).toBeUndefined();
	});

	it("rejects malformed payloads", () => {
		const bad = [
			{ nodes: [] }, // missing id
			{ id: "", nodes: [] }, // empty id
			{ id: "x", nodes: [{ id: "n", kind: "emit" }] }, // missing on/emits
			{ id: "x", nodes: [{ id: "n", kind: "emit", on: "start", emits: [] }] }, // on not array
			{ id: "x", nodes: [{ id: "n", kind: "emit", on: [], emits: [], mode: "some" }] },
			{ id: "x", nodes: [{ id: "n", kind: "emit", on: [], emits: [], maxFires: "lots" }] },
			"not-an-object",
			null,
		];
		for (const input of bad) {
			expect(() => decodeOrchestrationDef(input)).toThrow(/\S/);
		}
	});

	it("rejects inline handlers — persisted defs are data-only", () => {
		const withHandler = {
			id: "x",
			nodes: [
				{
					id: "n",
					kind: "custom",
					on: [],
					emits: [],
					handler: { id: "custom", run: "() => {}" },
				},
			],
		};
		expect(() => decodeOrchestrationDef(withHandler)).toThrow(/handler/);
	});
});

describe("defIssues", () => {
	it("flags duplicate node ids, empty kinds and blank event types", () => {
		const issues = defIssues({
			id: "x",
			nodes: [
				{ id: "a", kind: "", on: [" "], emits: [] },
				{ id: "a", kind: "emit", on: [], emits: [] },
			],
		});
		expect(issues).toEqual([
			'node "a" has an empty kind',
			'node "a" has a blank event type',
			'duplicate node id "a"',
		]);
	});

	it("decodeOrchestrationDef rejects issue-carrying defs", () => {
		expect(() =>
			decodeOrchestrationDef({
				id: "x",
				nodes: [
					{ id: "a", kind: "emit", on: [], emits: [] },
					{ id: "a", kind: "emit", on: [], emits: [] },
				],
			}),
		).toThrow(/duplicate node id/);
	});

	it("returns no issues for a clean def", () => {
		expect(defIssues(validDef)).toEqual([]);
	});
});
