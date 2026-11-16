import { describe, expect, it } from "vitest";

import { validateMessageId } from "./contract.ts";

const base = {
	namespace: "app",
	key: "title",
	locale: "en",
	scope: "global",
	scopeId: "",
};

describe("validateMessageId", () => {
	it("accepts a well-formed global id", () => {
		expect(validateMessageId(base)).toBeNull();
	});

	it("rejects an unknown scope", () => {
		expect(validateMessageId({ ...base, scope: "region" })).toBe("unknown scope 'region'");
	});

	it("rejects empty/whitespace fields", () => {
		expect(validateMessageId({ ...base, namespace: "" })).toContain("namespace");
		expect(validateMessageId({ ...base, key: "a b" })).toContain("key");
		expect(validateMessageId({ ...base, locale: "en\t" })).toContain("locale");
	});

	it("requires scopeId for tenant/portal scopes", () => {
		expect(validateMessageId({ ...base, scope: "tenant", scopeId: "" })).toBe(
			"scopeId is required for tenant/portal scope",
		);
		expect(validateMessageId({ ...base, scope: "portal", scopeId: "" })).toBe(
			"scopeId is required for tenant/portal scope",
		);
	});

	it("forbids scopeId on global scope", () => {
		expect(validateMessageId({ ...base, scopeId: "x" })).toBe(
			"scopeId must be empty for global scope",
		);
	});

	it("rejects whitespace inside a scoped scopeId", () => {
		expect(validateMessageId({ ...base, scope: "tenant", scopeId: "tenant 1" })).toBe(
			"scopeId must be free of whitespace/control characters",
		);
	});

	it("accepts a well-formed tenant id", () => {
		expect(validateMessageId({ ...base, scope: "tenant", scopeId: "t1" })).toBeNull();
	});
});
