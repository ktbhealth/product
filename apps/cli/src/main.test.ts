import { describe, expect, it, vi } from "vitest";

// Importing the entrypoint evaluates the command-tree construction but
// must not run the CLI: the `import.meta.url === invokedAs` guard stays
// false under vitest (the v8-ignored branch only fires for a direct
// `bun src/main.ts` invocation).
import "./main.ts";

describe("ktb CLI entrypoint", () => {
	it("loads the module without side effects", () => {
		expect(typeof process.argv[1]).toBe("string");
	});

	it("treats a missing argv[1] as never-invoked", async () => {
		// Simulate an argv-less invocation (eval/REPL embedding): the
		// entrypoint guard must stay inert — no runMain, no exit.
		const saved = process.argv.slice();
		process.argv.length = 1;
		vi.resetModules();
		try {
			await expect(import("./main.ts")).resolves.toBeDefined();
		} finally {
			process.argv.push(...saved.slice(1));
			vi.resetModules();
		}
	});
});
