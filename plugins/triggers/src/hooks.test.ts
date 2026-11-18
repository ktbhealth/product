import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import type { DocumentRecordWrittenEvent } from "@ktb/document-store";

import type { TriggerDef } from "./definition.ts";
import { TriggersHooks, TriggersHooksLive, UnknownTriggerHook } from "./hooks.ts";

const def: TriggerDef = {
	id: "t-1",
	collection: "patients",
	action: { kind: "hook", hook: "my.hook" },
};

const event = {
	_tag: "document-store.record-written",
	collection: "patients",
	id: 7,
	op: "insert",
	data: { name: "Ana" },
	ownerId: "user-1",
	tenantId: null,
	depth: 0,
} as unknown as DocumentRecordWrittenEvent;

describe("TriggersHooks", () => {
	it("register/get/invoke round-trip", async () => {
		const runtime = ManagedRuntime.make(TriggersHooksLive);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const hooks = yield* TriggersHooks;
					hooks.register("my.hook", (handle) =>
						Effect.succeed(`fired:${handle.trigger.id}:${handle.event.id}`),
					);
					expect(hooks.get("my.hook")).toBeTypeOf("function");
					expect(hooks.get("missing")).toBeUndefined();
					return yield* hooks.invoke("my.hook", { trigger: def, event });
				}),
			);
			expect(result).toBe("fired:t-1:7");
		} finally {
			await runtime.dispose();
		}
	});

	it("re-registering an id replaces the handler (last wins)", async () => {
		const runtime = ManagedRuntime.make(TriggersHooksLive);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const hooks = yield* TriggersHooks;
					hooks.register("dup", () => Effect.succeed("first"));
					hooks.register("dup", () => Effect.succeed("second"));
					return yield* hooks.invoke("dup", { trigger: def, event });
				}),
			);
			expect(result).toBe("second");
		} finally {
			await runtime.dispose();
		}
	});

	it("invoke fails UnknownTriggerHook for absent ids", async () => {
		const runtime = ManagedRuntime.make(TriggersHooksLive);
		try {
			const exit = await runtime.runPromiseExit(
				Effect.gen(function* () {
					const hooks = yield* TriggersHooks;
					return yield* hooks.invoke("nope", { trigger: def, event });
				}),
			);
			expect(exit._tag).toBe("Failure");
		} finally {
			await runtime.dispose();
		}
		// typed error reachable through the failure channel
		const runtime2 = ManagedRuntime.make(TriggersHooksLive);
		try {
			const error = await runtime2.runPromise(
				Effect.gen(function* () {
					const hooks = yield* TriggersHooks;
					return yield* hooks.invoke("nope", { trigger: def, event }).pipe(Effect.flip);
				}),
			);
			expect(error).toBeInstanceOf(UnknownTriggerHook);
			expect((error as UnknownTriggerHook).hook).toBe("nope");
		} finally {
			await runtime2.dispose();
		}
	});
});
