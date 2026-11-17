import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { WizardHooks, WizardHooksLive } from "./hooks.ts";
import type { WizardRunHandle } from "./hooks.ts";

const run: WizardRunHandle = {
	id: 1,
	key: "w",
	ownerId: "u1",
	definition: { id: "w", steps: [{ kind: "info", id: "s" }] },
	answers: { s: { a: 1 } },
	payload: { done: true },
};

/** Run an effect requiring WizardHooks against a fresh live registry. */
const withHooks = <A, E>(eff: Effect.Effect<A, E, WizardHooks>) =>
	Effect.runPromise(eff.pipe(Effect.provide(WizardHooksLive)));

describe("WizardHooks", () => {
	it("registers, gets and invokes handlers", async () => {
		await withHooks(
			Effect.gen(function* () {
				const hooks = yield* WizardHooks;
				let seen: WizardRunHandle | null = null;
				hooks.register("h1", (r) =>
					Effect.sync(() => {
						seen = r;
						return "ok";
					}),
				);
				expect(hooks.get("h1")).toBeDefined();
				expect(hooks.get("missing")).toBeUndefined();
				const result = yield* hooks.invoke("h1", run);
				expect(result).toBe("ok");
				expect(seen).toBe(run);
			}),
		);
	});

	it("replaces a handler on re-register (last wins)", async () => {
		await withHooks(
			Effect.gen(function* () {
				const hooks = yield* WizardHooks;
				hooks.register("dup", () => Effect.succeed("first"));
				hooks.register("dup", () => Effect.succeed("second"));
				expect(yield* hooks.invoke("dup", run)).toBe("second");
			}),
		);
	});

	it("fails UnknownWizardHook for unregistered ids", async () => {
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const hooks = yield* WizardHooks;
				return yield* Effect.exit(hooks.invoke("nope", run));
			}).pipe(Effect.provide(WizardHooksLive)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause)).toContain("UnknownWizardHook");
		}
	});
});
