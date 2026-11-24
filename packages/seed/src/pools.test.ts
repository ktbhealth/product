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

	it("returns the pt-BR pools for pt-BR and pt", () => {
		expect(poolsFor("pt-BR")).toMatchSnapshot();
		expect(poolsFor("pt")).toBe(poolsFor("pt-BR"));
	});

	it("returns the en pools for en and en-* variants", () => {
		expect(poolsFor("en")).toMatchSnapshot();
		expect(poolsFor("en-US")).toBe(poolsFor("en"));
		expect(poolsFor("en-GB")).toBe(poolsFor("en"));
		expect(poolsFor("en-AU")).toBe(poolsFor("en"));
	});

	it("falls back to en for unknown locales and missing input", () => {
		expect(poolsFor("fr")).toBe(poolsFor("en"));
		expect(poolsFor("es-MX")).toBe(poolsFor("en"));
		expect(poolsFor(undefined)).toBe(poolsFor("en"));
		expect(poolsFor("")).toBe(poolsFor("en"));
	});
});

/**
 * Exact-content assertions for the English pools. The locale tests in
 * generate.test.ts only check formats, so every string literal here is
 * pinned down verbatim.
 */
const EN_POOLS = {
	firstNames: [
		"James",
		"Mary",
		"Robert",
		"Patricia",
		"John",
		"Jennifer",
		"Michael",
		"Linda",
		"David",
		"Elizabeth",
		"William",
		"Barbara",
		"Richard",
		"Susan",
		"Joseph",
		"Jessica",
		"Thomas",
		"Sarah",
		"Charles",
		"Karen",
		"Christopher",
		"Nancy",
		"Daniel",
		"Lisa",
		"Matthew",
		"Betty",
		"Anthony",
		"Margaret",
		"Mark",
		"Sandra",
		"Donald",
		"Ashley",
		"Steven",
		"Emily",
		"Paul",
		"Michelle",
		"Andrew",
		"Dorothy",
		"Joshua",
		"Carol",
		"Kevin",
		"Amanda",
		"Brian",
		"Melissa",
	],
	lastNames: [
		"Smith",
		"Johnson",
		"Williams",
		"Brown",
		"Jones",
		"Garcia",
		"Miller",
		"Davis",
		"Rodriguez",
		"Martinez",
		"Hernandez",
		"Lopez",
		"Gonzalez",
		"Wilson",
		"Anderson",
		"Thomas",
		"Taylor",
		"Moore",
		"Jackson",
		"Martin",
		"Lee",
		"Perez",
		"Thompson",
		"White",
		"Harris",
		"Sanchez",
		"Clark",
		"Ramirez",
		"Lewis",
		"Robinson",
	],
	streets: [
		"Main",
		"Oak",
		"Maple",
		"Cedar",
		"Elm",
		"Washington",
		"Lake",
		"Hill",
		"Park",
		"Sunset",
		"River",
		"Highland",
		"Meadow",
		"Forest",
		"Church",
		"Franklin",
		"Lincoln",
		"Madison",
		"Jefferson",
		"Adams",
	],
	neighborhoods: [
		"Downtown",
		"Riverside",
		"Oakwood",
		"Maplewood",
		"Hillcrest",
		"Lakeview",
		"Westfield",
		"Fairview",
		"Brookside",
		"Cedar Park",
		"Elm Grove",
		"Stonebridge",
		"Woodland",
		"Northgate",
		"Southport",
	],
	cities: [
		"Springfield",
		"Rivertown",
		"Lakewood",
		"Fairview",
		"Georgetown",
		"Ashland",
		"Milton",
		"Salem",
		"Clinton",
		"Franklin",
		"Greenville",
		"Madison",
		"Arlington",
		"Bristol",
		"Clinton",
		"Dover",
	],
	states: [
		"AL",
		"AK",
		"AZ",
		"AR",
		"CA",
		"CO",
		"CT",
		"DE",
		"FL",
		"GA",
		"HI",
		"ID",
		"IL",
		"IN",
		"IA",
		"KS",
		"KY",
		"LA",
		"ME",
		"MD",
		"MA",
		"MI",
		"MN",
		"MS",
		"MO",
		"MT",
		"NE",
		"NV",
		"NH",
		"NJ",
		"NM",
		"NY",
		"NC",
		"ND",
		"OH",
		"OK",
		"OR",
		"PA",
		"RI",
		"SC",
		"SD",
		"TN",
		"TX",
		"UT",
		"VT",
		"VA",
		"WA",
		"WV",
		"WI",
		"WY",
	],
	countryCode: "US",
	countryName: "United States",
	emailDomains: ["gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "example.com"],
	words: [
		"appointment",
		"patient",
		"record",
		"clinic",
		"consultation",
		"prescription",
		"laboratory",
		"follow-up",
		"referral",
		"report",
		"history",
		"exam",
		"treatment",
		"vaccine",
		"blood",
		"pressure",
		"glucose",
		"weight",
	],
	localeTag: "en-US",
	phoneStyle: "us",
};

describe("poolsFor — exact pool contents", () => {
	it("en resolves to the exact English pools", () => {
		expect(poolsFor("en")).toEqual(EN_POOLS);
	});

	it("every en-* regional tag resolves to the same English pools", () => {
		for (const tag of ["en-US", "en-GB", "en-AU"]) {
			expect(poolsFor(tag)).toEqual(EN_POOLS);
		}
	});

	it("es falls back to the English pools", () => {
		expect(poolsFor("es")).toEqual(EN_POOLS);
	});

	it("unknown and missing locales fall back to the English pools", () => {
		expect(poolsFor("xx-YY")).toEqual(EN_POOLS);
		expect(poolsFor()).toEqual(EN_POOLS);
	});
});
