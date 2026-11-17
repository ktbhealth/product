// @vitest-environment node
import { describe, expect, it } from "vitest";

import { currentSearch, replaceFilterSearch } from "./view-utils.ts";

// No `@vitest-environment jsdom` pragma: this file runs in node where
// `window` is undefined, covering the SSR-safe branches.
describe("view-utils SSR fallbacks", () => {
	it("currentSearch returns empty without window", () => {
		expect(currentSearch()).toBe("");
	});

	it("replaceFilterSearch is a no-op without window", () => {
		expect(() => replaceFilterSearch("a=1")).not.toThrow();
	});
});
