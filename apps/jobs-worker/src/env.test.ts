import { describe, expect, it } from "vitest";

import { batchSizeFromEnv } from "./env.ts";

describe("batchSizeFromEnv", () => {
	it("defaults to 10 when unset", () => {
		expect(batchSizeFromEnv(undefined)).toBe(10);
	});

	it("parses a positive integer", () => {
		expect(batchSizeFromEnv("25")).toBe(25);
	});

	it.each(["abc", "0", "-3", "1.5", "", "  ", "10x"])(
		"falls back to 10 for invalid value %j",
		(value) => {
			expect(batchSizeFromEnv(value)).toBe(10);
		},
	);
});
