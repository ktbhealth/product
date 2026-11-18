import { describe, expect, it } from "vitest";

import {
	buildScriptPrompt,
	canonicalScriptPrompt,
	parseScriptTurns,
	SCRIPT_GEN_PROMPT,
	SCRIPT_GEN_PROMPT_NAME,
	SCRIPT_GEN_PROMPT_VERSION,
	scriptGenPromptHash,
	turnsFor,
	turnsToScript,
} from "./llmscript.ts";
import type { Persona } from "./schema.ts";

const persona = (over: Partial<Persona> = {}): Persona => ({
	region: "nordeste",
	ageBand: "60+",
	register: "colloquial",
	specialty: "cardiology",
	gender: "female",
	socialClass: "d",
	education: "elementary",
	name: "Paciente Ana",
	doctor: { gender: "female", register: "formal" },
	...over,
});

describe("turnsFor", () => {
	it("maps minutes to ~4 turns/min with a floor", () => {
		expect(turnsFor(15)).toBe(60);
		expect(turnsFor(5)).toBe(20);
		expect(turnsFor(0.5)).toBe(8);
		expect(turnsFor(undefined)).toBe(60);
	});
});

describe("buildScriptPrompt", () => {
	it("carries the persona demographics and the colloquial register rule", () => {
		const prompt = buildScriptPrompt({ persona: persona(), minutes: 10 });
		expect(prompt).toContain("40 falas");
		expect(prompt).toContain("nordeste");
		expect(prompt).toContain("Paciente Ana");
		expect(prompt).toContain("dor de cabeça");
		expect(prompt).toContain("Dra.");
		expect(prompt).toContain("doctor: texto");
	});

	it("switches to formal register and male doctor honorific", () => {
		const prompt = buildScriptPrompt({
			persona: persona({ register: "formal", doctor: { gender: "male", register: "colloquial" } }),
		});
		expect(prompt).toContain("Dr. ");
		expect(prompt).not.toContain("dor de cabeça");
	});

	it("falls back to defaults for missing persona fields", () => {
		// The prompt builder tolerates a sparse persona (defensive `??`
		// fallbacks) even though matrix cells always carry the axes.
		const prompt = buildScriptPrompt({ persona: {} as Persona });
		expect(prompt).toContain("ensino médio");
	});

	it("falls back to the raw education label for unknown keys", () => {
		const prompt = buildScriptPrompt({
			persona: { education: "outro_curso" } as Persona,
		});
		expect(prompt).toContain("outro_curso");
	});
});

describe("parseScriptTurns", () => {
	it("parses doctor/patient labeled lines", () => {
		const text = [
			"doctor: Bom dia, como posso ajudar?",
			"patient: Tô com dor de cabeça, doutor.",
			"doctor: Há quanto tempo?",
			"patient: Desde segunda, uai.",
		].join("\n");
		const turns = parseScriptTurns(text);
		expect(turns).toHaveLength(4);
		expect(turns?.[0]).toEqual({ speaker: "doctor", text: "Bom dia, como posso ajudar?" });
		expect(turns?.[1]?.speaker).toBe("patient");
	});

	it("accepts pt-BR labels and skips preamble lines", () => {
		const text = [
			"Aqui está o roteiro:",
			"médico: Seja bem-vindo.",
			"paciente: Obrigada.",
			"Dr: Como se sente?",
			"paciente: Melhor.",
			"Dra.: Vou examinar.",
			"paciente: Certo.",
		].join("\n");
		const turns = parseScriptTurns(text);
		expect(turns).toHaveLength(6);
		expect(turns?.filter((t) => t.speaker === "doctor")).toHaveLength(3);
	});

	it("returns null for too few turns or a single speaker", () => {
		expect(parseScriptTurns("doctor: oi")).toBeNull();
		expect(parseScriptTurns("doctor: a\ndoctor: b\ndoctor: c\ndoctor: d")).toBeNull();
		expect(parseScriptTurns("")).toBeNull();
	});

	it("skips non-speaker labels and empty utterances", () => {
		const text = [
			"resumo: isto não é fala",
			"doctor: Bom dia.",
			"patient:   ",
			"patient: Oi.",
			"doctor: Como vai?",
			"patient: Bem.",
			"doctor: Ótimo.",
			"patient: Obrigado.",
		].join("\n");
		const turns = parseScriptTurns(text);
		expect(turns).toHaveLength(6);
	});
});

describe("script-gen prompt identity (T-135)", () => {
	it("declares a stable name/version and a deterministic fnv1a hash", () => {
		expect(SCRIPT_GEN_PROMPT_NAME).toBe("eval.consultation/script-gen");
		expect(SCRIPT_GEN_PROMPT_VERSION).toBe(1);
		expect(SCRIPT_GEN_PROMPT).toEqual({
			name: SCRIPT_GEN_PROMPT_NAME,
			version: SCRIPT_GEN_PROMPT_VERSION,
			hash: scriptGenPromptHash(),
		});
		expect(SCRIPT_GEN_PROMPT.hash).toMatch(/^[0-9a-f]{8}$/);
	});

	it("the canonical prompt pins the static instruction set", () => {
		const p = canonicalScriptPrompt();
		expect(p).toContain("FORMATO DE SAÍDA");
		expect(p).toContain("doctor: texto");
		expect(p).toContain("ESTRUTURA");
		// Deterministic — same code, same canonical render, same hash.
		expect(canonicalScriptPrompt()).toBe(p);
		expect(scriptGenPromptHash()).toBe(SCRIPT_GEN_PROMPT.hash);
	});
});

describe("turnsToScript", () => {
	it("joins utterances without speaker labels", () => {
		expect(
			turnsToScript([
				{ speaker: "doctor", text: "Bom dia." },
				{ speaker: "patient", text: "Oi." },
			]),
		).toBe("Bom dia.\nOi.");
	});
});
