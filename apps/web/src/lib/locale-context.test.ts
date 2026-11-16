import { afterEach, describe, expect, it, vi } from "vitest";

// localeStorage caches its import("node:async_hooks") promise as a
// singleton — a rejected initialization must reset the cache so the
// next request retries instead of reusing the rejection forever.
describe("localeStorage", () => {
	afterEach(() => {
		vi.doUnmock("node:async_hooks");
		vi.resetModules();
	});

	it("retries initialization after a rejection instead of caching it", async () => {
		vi.resetModules();
		let constructions = 0;
		vi.doMock("node:async_hooks", () => ({
			AsyncLocalStorage: class {
				constructor() {
					constructions += 1;
					if (constructions === 1) throw new Error("als unavailable");
				}
				getStore() {
					return undefined;
				}
			},
		}));
		const mod = await import("./locale-context.ts");
		await expect(mod.localeStorage()).rejects.toThrow("als unavailable");
		// Second call must re-run initialization (constructions === 2),
		// not hand back the cached rejection.
		await expect(mod.localeStorage()).resolves.toBeDefined();
		expect(constructions).toBe(2);
		expect(mod.currentLocale()).toBe("en");
	});
});
