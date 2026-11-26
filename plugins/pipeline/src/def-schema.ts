import { Schema } from "effect";

import type { OrchestrationDef, OrchestrationNode } from "@ktb/orchestrator";

/**
 * def-schema.ts — wire validation for orchestration defs (P-120 phase
 * 4). The admin editor submits a whole `OrchestrationDef` as JSON;
 * this module is the effect/Schema contract the upsert server fn
 * decodes against before the durable store sees it. Field names and
 * optionality mirror `OrchestrationNode`/`OrchestrationDef` in
 * @ktb/orchestrator — the schema is the WIRE shape (mutable arrays,
 * `Schema.JsonObject` payloads), the store owns persistence.
 *
 * `handler` is declared `Schema.Never`: persisted defs are data-only
 * (functions cannot round-trip through JSON), so a wire def carrying
 * one fails decode instead of silently dropping it — the same rule
 * `upsertOrchestrationDef` enforces store-side.
 */

const JsonObject = Schema.JsonObject;

const EventSchemaDef = Schema.Struct({
	type: Schema.NonEmptyString,
	fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	schema: Schema.optionalKey(JsonObject),
});

const FanInSpecDef = Schema.Union([
	Schema.Struct({ count: Schema.Int }),
	Schema.Struct({ until: Schema.Array(Schema.NonEmptyString) }),
]);

const NodeDef = Schema.Struct({
	id: Schema.NonEmptyString,
	kind: Schema.NonEmptyString,
	// Data-only defs never carry an inline handler — see module doc.
	handler: Schema.optionalKey(Schema.Never),
	on: Schema.Array(Schema.NonEmptyString),
	emits: Schema.Array(Schema.NonEmptyString),
	mode: Schema.optionalKey(Schema.Literals(["any", "all"])),
	params: Schema.optionalKey(JsonObject),
	maxFires: Schema.optionalKey(Schema.Union([Schema.Int, Schema.Literal("unlimited")])),
	until: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
	retireOn: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
	retry: Schema.optionalKey(
		Schema.Struct({
			maxAttempts: Schema.optionalKey(Schema.Int),
			backoffMs: Schema.optionalKey(Schema.Int),
		}),
	),
	circuitBreaker: Schema.optionalKey(
		Schema.Struct({
			failureThreshold: Schema.optionalKey(Schema.Int),
			cooldownMs: Schema.optionalKey(Schema.Int),
		}),
	),
	fanIn: Schema.optionalKey(FanInSpecDef),
	state: Schema.optionalKey(JsonObject),
	input: Schema.optionalKey(EventSchemaDef),
	output: Schema.optionalKey(Schema.Array(EventSchemaDef)),
});

const DefDef = Schema.Struct({
	id: Schema.NonEmptyString,
	version: Schema.optionalKey(Schema.NonEmptyString),
	description: Schema.optionalKey(Schema.String),
	config: Schema.optionalKey(JsonObject),
	onNodeError: Schema.optionalKey(Schema.Literals(["halt", "continue"])),
	nodes: Schema.Array(NodeDef),
	eventSchemas: Schema.optionalKey(Schema.Array(EventSchemaDef)),
});

const decodeDef = Schema.decodeUnknownSync(DefDef);

/**
 * Semantic checks the schema cannot express: node ids are the def's
 * identity surface (state keys, run records, derived edges) — duplicates
 * are rejected here rather than mid-run. Empty kinds/blank event types
 * are rejected for the same reason.
 */
export const defIssues = (def: OrchestrationDef): readonly string[] => {
	const issues: string[] = [];
	const seen = new Set<string>();
	for (const node of def.nodes) {
		if (seen.has(node.id)) issues.push(`duplicate node id "${node.id}"`);
		seen.add(node.id);
		if (node.kind.trim() === "") issues.push(`node "${node.id}" has an empty kind`);
		for (const type of [...node.on, ...node.emits]) {
			if (type.trim() === "") issues.push(`node "${node.id}" has a blank event type`);
		}
	}
	return issues;
};

/**
 * The data-only def shape — `handler` stripped. Persisted defs can
 * never carry one (functions don't serialize), so wire/server-fn
 * surfaces use this type: it is what `OrchestrationDef` looks like
 * after a JSON round-trip and it satisfies TanStack's serializable
 * return check that the raw `OrchestrationKind`-typed field would fail.
 */
type DataOnlyOrchestrationNode = Omit<OrchestrationNode, "handler">;
export type DataOnlyOrchestrationDef = Omit<OrchestrationDef, "nodes"> & {
	readonly nodes: readonly DataOnlyOrchestrationNode[];
};

/**
 * Decode an untrusted wire payload into a {@link DataOnlyOrchestrationDef}.
 * Throws the Schema `ParseError` on malformed input — the server fn's
 * `.validator` surfaces that as a request error before the handler
 * runs — and a plain `Error` listing {@link defIssues} on decoded-but-
 * invalid defs.
 */
export const decodeOrchestrationDef = (input: unknown): DataOnlyOrchestrationDef => {
	const def = decodeDef(input) as DataOnlyOrchestrationDef;
	const issues = defIssues(def);
	if (issues.length > 0) {
		throw new Error(`invalid orchestration def ${def.id}: ${issues.join("; ")}`);
	}
	return def;
};
