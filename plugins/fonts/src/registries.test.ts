import { describe, expect, it } from "vitest";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { FontHooks, FontHooksLive, UnknownFontHook, type FontHookHandle } from "./hooks.ts";
import { FontProviders, FontProvidersLive, type FontProviderAdapter } from "./registry.ts";

const makeRuntime = <R>(layer: Layer.Layer<R>) =>
	ManagedRuntime.make(layer as Layer.Layer<unknown>);

describe("FontProviders registry", () => {
	it("register/get/kinds with last-wins replacement", async () => {
		const runtime = makeRuntime(FontProvidersLive);
		await runtime.runPromise(
			Effect.gen(function* () {
				const providers = yield* FontProviders;
				expect(providers.kinds()).toEqual([]);
				const a: FontProviderAdapter = { kind: "alpha", list: () => Effect.succeed([]) };
				const b: FontProviderAdapter = { kind: "beta", list: () => Effect.succeed([]) };
				providers.register(a);
				providers.register(b);
				expect(providers.get("alpha")).toBe(a);
				expect(providers.kinds()).toEqual(["alpha", "beta"]);
				// Re-registering replaces (last wins).
				const a2: FontProviderAdapter = { kind: "alpha", list: () => Effect.succeed([]) };
				providers.register(a2);
				expect(providers.get("alpha")).toBe(a2);
				expect(providers.get("missing")).toBeUndefined();
			}),
		);
		await runtime.dispose();
	});
});

describe("FontHooks registry", () => {
	it("register/get/ids/invoke round-trip", async () => {
		const runtime = makeRuntime(FontHooksLive);
		const seen: FontHookHandle[] = [];
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* FontHooks;
				expect(hooks.ids()).toEqual([]);
				hooks.register("theme.sync", (handle) =>
					Effect.sync(() => {
						seen.push(handle);
					}),
				);
				expect(hooks.ids()).toEqual(["theme.sync"]);
				expect(hooks.get("theme.sync")).toBeTypeOf("function");
				yield* hooks.invoke("theme.sync", {
					event: "provider.changed",
					providerId: 7,
					kind: "local",
				});
				expect(seen).toEqual([{ event: "provider.changed", providerId: 7, kind: "local" }]);
			}),
		);
		await runtime.dispose();
	});

	it("invoke fails UnknownFontHook for absent ids; handler errors propagate", async () => {
		const runtime = makeRuntime(FontHooksLive);
		const exit = await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* FontHooks;
				hooks.register("bad", () => Effect.fail("nope"));
				return {
					missing: yield* Effect.exit(
						hooks.invoke("absent", {
							event: "family.synced",
							providerId: 1,
							kind: "k",
						}),
					),
					failing: yield* Effect.exit(
						hooks.invoke("bad", {
							event: "family.synced",
							providerId: 1,
							kind: "k",
						}),
					),
				};
			}),
		);
		expect(exit.missing._tag).toBe("Failure");
		const missingErrors = Exit.isFailure(exit.missing)
			? exit.missing.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)
			: [];
		expect(missingErrors.some((e) => e instanceof UnknownFontHook)).toBe(true);
		expect(exit.failing._tag).toBe("Failure");
		await runtime.dispose();
	});
});
