import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildScriptContext, renderScript } from "./scriptgen.ts";
import { ptBR } from "./locales/pt-BR.ts";
import type { Persona } from "./schema.ts";

const persona = (over?: Partial<Persona>): Persona => ({
	region: "southeast",
	ageBand: "adult",
	register: "colloquial",
	specialty: "general_practice",
	...over,
});

const TEMPLATE = [
	"<%= it.slots.greeting %>",
	"<%= it.slots.chief_complaint %>",
	"<%= it.slots.allergy_question %>",
	"<%= it.slots.allergy_answer %>",
	"<%= it.slots.prescription %>",
	"<%= it.slots.closing %>",
].join("\n");

describe("buildScriptContext", () => {
	it("is deterministic — same persona+seed, same slots and entities", () => {
		const a = buildScriptContext(persona(), 42);
		const b = buildScriptContext(persona(), 42);
		expect(a.slots).toEqual(b.slots);
		expect(a.entities).toEqual(b.entities);
		expect(a.turns).toEqual(b.turns);
	});

	it("varies with the seed", () => {
		const seen = new Set(
			Array.from({ length: 8 }, (_, s) => buildScriptContext(persona(), s).slots.allergy_answer),
		);
		expect(seen.size).toBeGreaterThan(1);
	});

	it("emits gold entities from the slot selection, not the text", () => {
		const ctx = buildScriptContext(persona(), 1);
		const cats = ctx.entities.map((e) => e.category);
		expect(cats).toContain("medication");
		expect(cats).toContain("dosage");
		expect(cats).toContain("frequency");
	});

	it("emits a negation entity when the patient denies allergy", () => {
		const denial = Array.from({ length: 40 }, (_, s) => buildScriptContext(persona(), s)).find(
			(c) => c.entities.some((e) => e.category === "negation"),
		);
		expect(denial).toBeDefined();
		expect(denial?.slots.allergy_answer).toContain("alergia");
		// The gold entity is the negation MARKER — must be a substring of
		// the utterance or substring alignment can never match it.
		const marker = denial?.entities.find((e) => e.category === "negation")?.value;
		expect(marker).toBeDefined();
		expect(denial?.slots.allergy_answer).toContain(marker);
	});

	it("emits a medication entity for the allergen when affirmed", () => {
		const affirm = Array.from({ length: 40 }, (_, s) => buildScriptContext(persona(), s)).find(
			(c) => !c.entities.some((e) => e.category === "negation"),
		);
		expect(affirm).toBeDefined();
		expect(affirm?.slots.allergy_answer).toContain("alérgico");
	});

	it("drops the regional marker for formal register", () => {
		const ctx = buildScriptContext(persona({ register: "formal" }), 1);
		expect(ctx.slots.chief_complaint.startsWith("uai")).toBe(false);
	});

	it("keeps speaker roles as structured turns, not text prefixes", () => {
		const ctx = buildScriptContext(persona(), 3);
		expect(ctx.turns).toHaveLength(6);
		expect(ctx.turns.every((t) => t.speaker === "doctor" || t.speaker === "patient")).toBe(true);
		expect(ctx.turns.every((t) => !t.text.startsWith("Doctor:"))).toBe(true);
	});

	it("falls back to general_practice for an unknown specialty", () => {
		const ctx = buildScriptContext(persona({ specialty: "oncology" }), 1);
		expect(ctx.entities.length).toBeGreaterThan(0);
		expect(ctx.slots.chief_complaint.length).toBeGreaterThan(0);
	});

	it("falls back to the default marker for an unknown region", () => {
		const ctx = buildScriptContext(persona({ region: "abroad" }), 1);
		expect(ctx.slots.chief_complaint.startsWith("uai")).toBe(true);
	});

	it("covers every matrix specialty and region without throwing", () => {
		const specialties = [
			"general_practice",
			"pediatrics",
			"gynecology",
			"geriatrics",
			"cardiology",
			"psychiatry",
		];
		const regions = ["southeast", "south", "northeast", "north", "central_west"];
		for (const specialty of specialties) {
			for (const region of regions) {
				const ctx = buildScriptContext(persona({ specialty, region }), 7);
				expect(ctx.slots.prescription).toBeTruthy();
			}
		}
	});
});

describe("renderScript", () => {
	it("renders the full consultation and is seed-deterministic", () => {
		const a = renderScript({ template: TEMPLATE, persona: persona(), seed: 9 });
		const b = renderScript({ template: TEMPLATE, persona: persona(), seed: 9 });
		expect(a.script).toBe(b.script);
		expect(a.script.split("\n")).toHaveLength(6);
		expect(a.entities.length).toBeGreaterThanOrEqual(3);
		expect(a.seed).toBe(9);
	});

	it("renders the shipped .eta template file", () => {
		const template = readFileSync(
			new URL("../templates/pt-BR/consultation.eta", import.meta.url),
			"utf8",
		);
		const r = renderScript({ template, persona: persona(), seed: 4 });
		expect(r.script).toContain("alergia");
		expect(r.turns).toHaveLength(6);
	});

	it("renders a different structure from the followup template", () => {
		const template = readFileSync(
			new URL("../templates/pt-BR/followup.eta", import.meta.url),
			"utf8",
		);
		const r = renderScript({ template, persona: persona(), seed: 4 });
		// followup puts prescription before allergy — order differs
		const lines = r.script.split("\n");
		expect(lines.indexOf(r.turns[4]!.text)).toBeLessThan(lines.indexOf(r.turns[3]!.text));
	});
});

describe("anamnesis variant (T-128/T-129)", () => {
	it("renders a multi-turn dialogue with both speakers and entities", () => {
		const r = renderScript({
			template: TEMPLATE,
			persona: persona(),
			seed: 7,
			variant: "anamnesis",
		});
		expect(r.turns.length).toBeGreaterThan(40);
		expect(new Set(r.turns.map((t) => t.speaker))).toEqual(new Set(["doctor", "patient"]));
		expect(r.entities.map((e) => e.category)).toContain("medication");
		expect(r.script).toBe(r.turns.map((t) => t.text).join("\n"));
	});

	it("doctor beats stay formal while a colloquial patient stays lay", () => {
		const r = renderScript({
			template: TEMPLATE,
			persona: persona({ register: "colloquial" }),
			seed: 7,
			variant: "anamnesis",
		});
		const patient = r.turns.find((t) => t.speaker === "patient")!;
		const doctor = r.turns.find((t) => t.speaker === "doctor")!;
		// The lay patient says "dor de cabeça" — never the technical
		// "cefaleia" a formal patient may produce.
		expect(patient.text).toContain("dor de cabeça");
		expect(doctor.text).toMatch(/senhor|Bom dia|vou/i);
	});

	it("uses the persona name as the patient tag when present", () => {
		const r = renderScript({
			template: TEMPLATE,
			persona: persona({ name: "Paciente Zed" }),
			seed: 7,
			variant: "anamnesis",
		});
		expect(r.script).toContain("Paciente Zed");
	});

	it("falls back to the short form when the locale has no anamnesis", () => {
		const profile: typeof ptBR = {
			...ptBR,
			script: { ...ptBR.script, anamnesis: undefined },
		};
		const r = renderScript({
			template: TEMPLATE,
			persona: persona(),
			seed: 7,
			profile,
			variant: "anamnesis",
		});
		expect(r.turns).toHaveLength(6);
	});
});

it("unknown specialty falls back to general_practice content", () => {
	const r = renderScript({
		template: TEMPLATE,
		persona: persona({ specialty: "not_a_specialty" }),
		seed: 7,
		variant: "anamnesis",
	});
	expect(r.turns.length).toBeGreaterThan(40);
});

it("specialty with a complaint but no anamnesis tables falls back per-table", () => {
	const profile: typeof ptBR = {
		...ptBR,
		script: {
			...ptBR.script,
			chiefComplaint: {
				...ptBR.script.chiefComplaint,
				weird_spec: { formal: ["Q formal"], colloquial: ["q colloquial"] },
			},
		},
	};
	const r = renderScript({
		template: TEMPLATE,
		persona: persona({ specialty: "weird_spec" }),
		seed: 7,
		profile,
		variant: "anamnesis",
	});
	expect(r.turns.length).toBeGreaterThan(40);
});

it("exercises every beat variant in both registers across seeds", () => {
	for (const register of ["formal", "colloquial"] as const) {
		for (let seed = 0; seed < 40; seed++) {
			const r = renderScript({
				template: TEMPLATE,
				persona: persona({ register }),
				seed,
				variant: "anamnesis",
			});
			expect(r.turns.length).toBeGreaterThan(40);
		}
	}
});

it("a colloquial doctor renders colloquial doctor beats", () => {
	const seen = new Set<string>();
	for (let seed = 0; seed < 40; seed++) {
		const r = renderScript({
			template: TEMPLATE,
			persona: persona({ doctor: { gender: "m", register: "colloquial" } }),
			seed,
			variant: "anamnesis",
		});
		seen.add(r.turns[0]!.text);
	}
	// colloquial greeting variants show informal phrasing
	expect([...seen].some((t) => t.includes("você") || t.includes("te "))).toBe(true);
});
