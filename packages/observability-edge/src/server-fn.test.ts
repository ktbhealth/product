import { describe, expect, it } from "vitest";

import { serverFnIdFromPathname } from "./server-fn.ts";

describe("serverFnIdFromPathname", () => {
	it("extracts the fn id from a server-fn path", () => {
		expect(serverFnIdFromPathname("/_serverFn/fn-abc123")).toBe("fn-abc123");
	});

	it("takes only the first segment after the base as the id", () => {
		expect(serverFnIdFromPathname("/_serverFn/fn-abc123/payload")).toBe("fn-abc123");
	});

	it("finds the base behind a router basepath prefix", () => {
		expect(serverFnIdFromPathname("/base/_serverFn/fn-abc123")).toBe("fn-abc123");
	});

	it("returns undefined for non-server-fn paths", () => {
		expect(serverFnIdFromPathname("/consultations")).toBeUndefined();
		expect(serverFnIdFromPathname("/")).toBeUndefined();
	});

	it("returns undefined for a bare or empty base", () => {
		expect(serverFnIdFromPathname("/_serverFn")).toBeUndefined();
		expect(serverFnIdFromPathname("/_serverFn/")).toBeUndefined();
		expect(serverFnIdFromPathname("/base/_serverFn/")).toBeUndefined();
	});
});
