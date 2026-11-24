import { describe, expect, it } from "vitest";

import { SeedError } from "./errors.ts";

describe("SeedError", () => {
	it("formats message, name and path", () => {
		const plain = new SeedError("boom");
		expect(plain.message).toBe("boom");
		expect(plain.name).toBe("SeedError");
		expect(plain.path).toBeUndefined();

		const located = new SeedError("boom", "/a/b");
		expect(located.message).toBe("boom (at /a/b)");
		expect(located.path).toBe("/a/b");
	});
});
