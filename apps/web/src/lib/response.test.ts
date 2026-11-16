import { describe, expect, it } from "vitest";

import { unwrapResponse } from "./response.ts";

describe("unwrapResponse", () => {
	it("returns the Response when the result is one directly", () => {
		const response = new Response("ok", { status: 200 });
		expect(unwrapResponse(response)).toBe(response);
	});

	it("returns result.response when it is a Response", () => {
		const response = new Response("ok", { status: 201 });
		expect(unwrapResponse({ response })).toBe(response);
	});

	it("unwraps an SSR wrapper carrying the Response one level deep", () => {
		const inner = new Response("ssr", { status: 202 });
		expect(unwrapResponse({ response: { response: inner } })).toBe(inner);
	});

	it("returns undefined when result.response is not a Response", () => {
		expect(unwrapResponse({ response: "not-a-response" })).toBeUndefined();
		expect(unwrapResponse({ response: 42 })).toBeUndefined();
		expect(unwrapResponse({ response: null })).toBeUndefined();
	});

	it("returns undefined when the nested response is not a Response", () => {
		expect(unwrapResponse({ response: { response: "nope" } })).toBeUndefined();
		expect(unwrapResponse({ response: { response: undefined } })).toBeUndefined();
	});

	it("returns undefined for null, undefined and primitives", () => {
		expect(unwrapResponse(null)).toBeUndefined();
		expect(unwrapResponse(undefined)).toBeUndefined();
		expect(unwrapResponse("result")).toBeUndefined();
		expect(unwrapResponse(0)).toBeUndefined();
		expect(unwrapResponse({})).toBeUndefined();
	});
});
