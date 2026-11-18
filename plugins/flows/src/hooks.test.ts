import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import type { DocumentRecord } from "@ktb/document-store";

import type { FlowDef } from "./definition.ts";
import { FlowsHooks, FlowsHooksLive, UnknownFlowHook } from "./hooks.ts";

const def: FlowDef = {
	id: "doc-review",
	collection: "documents",
	stateField: "status",
	initial: "draft",
	states: { draft: {}, review: {} },
};

const record = {
	id: 7,
	collectionId: 1,
	collection: "documents",
	data: { status: "review" },
	ownerId: "user-1",
	tenantId: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
} as unknown as DocumentRecord;

const handle = {
	flow: def,
	record,
	event: { name: "submit", payload: { by: "u1" } },
	from: "draft",
	to: "review",
};

describe("FlowsHooks", () => {
	it("register/get/invoke round-trip", async () => {
		const runtime = ManagedRuntime.make(FlowsHooksLive);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const hooks = yield* FlowsHooks;
					hooks.register("docs.submitted", (h) =>
						Effect.succeed(`fired:${h.flow.id}:${h.record.id}:${h.from}->${h.to}`),
					);
					expect(hooks.get("docs.submitted")).toBeTypeOf("function");
					expect(hooks.get("missing")).toBeUndefined();
					return yield* hooks.invoke("docs.submitted", handle);
				}),
			);
			expect(result).toBe("fired:doc-review:7:draft->review");
		} finally {
			await runtime.dispose();
		}
	});

	it("re-registering an id replaces the handler (last wins)", async () => {
		const runtime = ManagedRuntime.make(FlowsHooksLive);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const hooks = yield* FlowsHooks;
					hooks.register("dup", () => Effect.succeed("first"));
					hooks.register("dup", () => Effect.succeed("second"));
					return yield* hooks.invoke("dup", handle);
				}),
			);
			expect(result).toBe("second");
		} finally {
			await runtime.dispose();
		}
	});

	it("invoke fails UnknownFlowHook for absent ids", async () => {
		const runtime = ManagedRuntime.make(FlowsHooksLive);
		try {
			const error = await runtime.runPromise(
				Effect.gen(function* () {
					const hooks = yield* FlowsHooks;
					return yield* hooks.invoke("nope", handle).pipe(Effect.flip);
				}),
			);
			expect(error).toBeInstanceOf(UnknownFlowHook);
			expect((error as UnknownFlowHook).hook).toBe("nope");
		} finally {
			await runtime.dispose();
		}
	});
});
