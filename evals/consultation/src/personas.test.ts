import { describe, expect, it } from "vitest";

import { DEFAULT_MATRIX, expandPersonaMatrix, sampleMatrix } from "./personas.ts";

describe("expandPersonaMatrix", () => {
	it("cartesian product in stable order", () => {
		const cells = expandPersonaMatrix({
			regions: ["southeast", "northeast"],
			ageBands: ["adult"],
			registers: ["formal", "colloquial"],
			specialties: ["general_practice"],
		});
		expect(cells).toHaveLength(4);
		expect(cells[0]).toMatchObject({ region: "southeast", register: "formal" });
		expect(cells[1]).toMatchObject({ region: "southeast", register: "colloquial" });
		expect(cells[2]?.region).toBe("northeast");
	});

	it("default matrix covers the diversity axes", () => {
		const cells = expandPersonaMatrix(DEFAULT_MATRIX);
		expect(cells).toHaveLength(5 * 3 * 2 * 6);
		expect(new Set(cells.map((c) => c.region)).size).toBe(5);
	});
});

describe("sampleMatrix", () => {
	it("deterministic sub-sample", () => {
		const a = sampleMatrix(DEFAULT_MATRIX, 5);
		const b = sampleMatrix(DEFAULT_MATRIX, 5);
		expect(a).toEqual(b);
		expect(a.length).toBe(Math.ceil(expandPersonaMatrix(DEFAULT_MATRIX).length / 5));
	});

	it("step 0 clamps to 1 (full matrix)", () => {
		expect(sampleMatrix(DEFAULT_MATRIX, 0)).toHaveLength(
			expandPersonaMatrix(DEFAULT_MATRIX).length,
		);
	});
});

import { enrichPersona, voiceFor } from "./personas.ts";
import { rng } from "./scriptgen.ts";

const cell = (over?: Partial<import("./schema.ts").Persona>): import("./schema.ts").Persona => ({
	region: "southeast",
	ageBand: "adult",
	register: "colloquial",
	specialty: "general_practice",
	...over,
});

describe("enrichPersona", () => {
	it("is deterministic — same cell+seed, same enrichment", () => {
		expect(enrichPersona(cell(), rng(7))).toEqual(enrichPersona(cell(), rng(7)));
	});

	it("fills gender/class/education/name/doctor", () => {
		const p = enrichPersona(cell(), rng(3));
		expect(["f", "m"]).toContain(p.gender);
		expect(["c", "d", "e"]).toContain(p.socialClass);
		expect(["elementary", "secondary"]).toContain(p.education);
		expect(p.name).toMatch(/^Paciente /);
		expect(["formal", "colloquial"]).toContain(p.doctor?.register);
		expect(["f", "m"]).toContain(p.doctor?.gender);
	});

	it("formal cells draw from a/b/c class and higher education", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const p = enrichPersona(cell({ register: "formal" }), rng(seed));
			expect(["a", "b", "c"]).toContain(p.socialClass);
			expect(["higher", "postgraduate"]).toContain(p.education);
		}
	});

	it("gynecology patients are always female", () => {
		for (const seed of [1, 2, 3]) {
			expect(enrichPersona(cell({ specialty: "gynecology" }), rng(seed)).gender).toBe("f");
		}
	});

	it("normalizes 'female'/'male' spellings into the compact key", () => {
		const p = enrichPersona(cell({ gender: "female" }), rng(1));
		expect(p.gender).toBe("f");
		expect(enrichPersona(cell({ gender: "male" }), rng(1)).gender).toBe("m");
	});

	it("honours explicit fields instead of overwriting them", () => {
		const p = enrichPersona(
			cell({
				gender: "m",
				socialClass: "a",
				education: "postgraduate",
				name: "Paciente X",
				doctor: { gender: "f", register: "formal" },
			}),
			rng(9),
		);
		expect(p).toMatchObject({
			gender: "m",
			socialClass: "a",
			education: "postgraduate",
			name: "Paciente X",
		});
	});

	it("uses caller-supplied name tags when provided", () => {
		const p = enrichPersona(cell({ gender: "f" }), rng(1), { f: ["Paciente Z"] });
		expect(p.name).toBe("Paciente Z");
	});
});

describe("voiceFor", () => {
	it("f picks from the female pool, m from the male pool", () => {
		for (const seed of [1, 2, 3]) {
			expect(voiceFor("f", rng(seed))).toMatch(/^br_female_/);
			expect(voiceFor("m", rng(seed))).toMatch(/^br_male_/);
		}
	});

	it("is deterministic under the same seed", () => {
		expect(voiceFor("f", rng(5))).toBe(voiceFor("f", rng(5)));
	});

	it("undefined gender falls back to the male pool", () => {
		expect(voiceFor(undefined, rng(1))).toMatch(/^br_male_/);
	});

	it("honours a custom pool", () => {
		expect(voiceFor("f", rng(1), { f: ["custom_f"] })).toBe("custom_f");
	});
});

it("falls back to the male pool when the gender key is absent", () => {
	expect(voiceFor("f", rng(1), { m: ["only_m"] })).toBe("only_m");
});

it("some seeds derive a colloquial doctor (minority branch)", () => {
	const regs = new Set(
		Array.from({ length: 60 }, (_, s) => enrichPersona(cell(), rng(s)).doctor?.register),
	);
	expect(regs).toContain("colloquial");
	expect(regs).toContain("formal");
});
