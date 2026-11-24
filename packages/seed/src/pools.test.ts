import { describe, expect, it } from "vitest";

import { poolsFor } from "./index.ts";

const ARRAY_FIELDS = [
	"firstNames",
	"lastNames",
	"streets",
	"neighborhoods",
	"cities",
	"states",
	"emailDomains",
	"words",
] as const;

describe("poolsFor", () => {
	it("resolves exact tags, base languages and the en fallback", () => {
		const pt = poolsFor("pt-BR");
		expect(poolsFor("pt")).toBe(pt);
		expect(poolsFor("pt-PT")).toBe(pt);

		const en = poolsFor("en");
		expect(poolsFor("en-US")).toBe(en);
		expect(poolsFor("en-GB")).toBe(en);
		expect(poolsFor("en-AU")).toBe(en);
		expect(poolsFor("es")).toBe(en);
		expect(poolsFor("xx-YY")).toBe(en);
		expect(poolsFor()).toBe(en);
		expect(poolsFor("")).toBe(en);
	});

	it("pt-BR pools carry Brazilian locale data", () => {
		const p = poolsFor("pt-BR");
		expect(p.countryCode).toBe("BR");
		expect(p.countryName).toBe("Brasil");
		expect(p.localeTag).toBe("pt-BR");
		expect(p.phoneStyle).toBe("br");
	});

	it("en pools carry US locale data", () => {
		const p = poolsFor("en");
		expect(p.countryCode).toBe("US");
		expect(p.countryName).toBe("United States");
		expect(p.localeTag).toBe("en-US");
		expect(p.phoneStyle).toBe("us");
	});

	it.each(["pt-BR", "en"] as const)("%s pools have non-empty string entries", (locale) => {
		const p = poolsFor(locale);
		for (const field of ARRAY_FIELDS) {
			const pool = p[field];
			expect(pool.length, `${locale}.${field} is empty`).toBeGreaterThan(0);
			for (const entry of pool) {
				expect(typeof entry).toBe("string");
				expect(entry.length, `${locale}.${field} has an empty entry`).toBeGreaterThan(0);
			}
		}
	});
});
