import { describe, expect, it } from "vitest";

import { SAMPLE_TRANSCRIPT } from "@ktb/anamnesis";
import { HeuristicExtractor } from "./heuristic.ts";

describe("HeuristicExtractor", () => {
	it("extracts a structured anamnese from the sample transcript", async () => {
		const a = await new HeuristicExtractor().extract(SAMPLE_TRANSCRIPT);

		expect(a.queixa_principal.content).toMatch(/dor de cabeça/i);
		expect(a.medicamentos_em_uso.content).toMatch(/losartana/i);
		expect(a.antecedentes.content).toMatch(/hipertenso/i);
		expect(a.alergias.evidence.length).toBeGreaterThan(0);
		expect(a.exame_fisico.confidence).toBe("baixa");
	});

	it("exposes a stable extractor name", () => {
		expect(new HeuristicExtractor().name).toBe("heuristic");
	});

	it("classifies each section with exact content, evidence and confidence", async () => {
		const transcript = [
			"Dor de cabeça forte.",
			"Sinto enjoo matinal.",
			"Tem dor de garganta e alergia a pó.",
			"Paciente comparece para retorno.",
			"Não tem alergia a medicamentos.",
			"Toma losartana 50 mg.",
			"Toma sinvastatina à noite.",
			"É hipertenso há cinco anos.",
		].join(" ");
		const a = await new HeuristicExtractor().extract(transcript);

		expect(a.queixa_principal).toEqual({
			content: "Dor de cabeça forte.",
			confidence: "media",
			evidence: ["Dor de cabeça forte."],
		});
		// The allergy sentence is claimed by `alergias` and stays out of the HDA;
		// the neutral sentence matches nothing and stays out too.
		expect(a.hda).toEqual({
			content: "Sinto enjoo matinal. É hipertenso há cinco anos.",
			confidence: "media",
			evidence: ["Sinto enjoo matinal.", "É hipertenso há cinco anos."],
		});
		expect(a.antecedentes).toEqual({
			content: "É hipertenso há cinco anos.",
			confidence: "media",
			evidence: ["É hipertenso há cinco anos."],
		});
		expect(a.alergias).toEqual({
			content: "Tem dor de garganta e alergia a pó. Não tem alergia a medicamentos.",
			confidence: "media",
			evidence: ["Tem dor de garganta e alergia a pó.", "Não tem alergia a medicamentos."],
		});
		// "medicamentos" matches MEDS but the sentence is an allergy — excluded.
		expect(a.medicamentos_em_uso).toEqual({
			content: "Toma losartana 50 mg. Toma sinvastatina à noite.",
			confidence: "media",
			evidence: ["Toma losartana 50 mg.", "Toma sinvastatina à noite."],
		});
	});

	it("fills judge-only sections with pt-BR placeholders and no evidence", async () => {
		const a = await new HeuristicExtractor().extract(SAMPLE_TRANSCRIPT);

		expect(a.exame_fisico).toEqual({
			content: "A preencher pelo médico: não registrado em áudio.",
			confidence: "baixa",
			evidence: [],
		});
		expect(a.hipoteses.content).toBe("A preencher pelo médico: julgamento clínico.");
		expect(a.conduta.content).toBe("A preencher pelo médico: julgamento clínico.");
		expect(a.hipoteses.evidence).toEqual([]);
		expect(a.conduta.evidence).toEqual([]);
	});

	it("falls back to first sentence when no symptom keyword matches", async () => {
		const a = await new HeuristicExtractor().extract("Paciente comparece para retorno.");
		expect(a.queixa_principal.content).toBe("Paciente comparece para retorno.");
	});

	it("uses pt-BR placeholders when no section keyword matches", async () => {
		const a = await new HeuristicExtractor().extract("Paciente comparece para retorno.");

		expect(a.hda).toEqual({
			content: "Sem detalhes temporais extraídos. Revisar transcrição.",
			confidence: "baixa",
			evidence: [],
		});
		expect(a.antecedentes.content).toBe("Nega / não informado.");
		expect(a.antecedentes.evidence).toEqual([]);
		expect(a.alergias.content).toBe("Nega / não informado.");
		expect(a.alergias.evidence).toEqual([]);
		expect(a.medicamentos_em_uso.content).toBe("Nenhum informado.");
		expect(a.medicamentos_em_uso.evidence).toEqual([]);
	});

	it("ignores sentences of two characters or fewer", async () => {
		const a = await new HeuristicExtractor().extract("oi\nPaciente bem.");
		expect(a.queixa_principal.content).toBe("Paciente bem.");
	});

	it("trims sentences and splits on newlines", async () => {
		const a = await new HeuristicExtractor().extract(
			"  Dor de cabeça.\n\nSinto enjoo há dois dias.  ",
		);
		expect(a.queixa_principal).toEqual({
			content: "Dor de cabeça.",
			confidence: "media",
			evidence: ["Dor de cabeça."],
		});
		expect(a.hda.content).toBe("Sinto enjoo há dois dias.");
		expect(a.hda.evidence).toEqual(["Sinto enjoo há dois dias."]);
	});

	it("lists non-complaint symptoms before a temporal chief complaint in the HDA", async () => {
		const a = await new HeuristicExtractor().extract("Dor de cabeça desde ontem. Sinto enjoo.");
		expect(a.hda.content).toBe("Sinto enjoo. Dor de cabeça desde ontem.");
		expect(a.hda.evidence).toEqual(["Sinto enjoo.", "Dor de cabeça desde ontem."]);
	});

	it("keeps temporal sentences in the HDA whatever their phrasing", async () => {
		const transcript = [
			"Os episódios ocorrem há pouco.",
			"Os sinais ocorrem há  muito.",
			"No ano passado mudou de cidade.",
			"Ele usa remédio faz tempo.",
			"O remédio faz  efeito.",
		].join(" ");
		const a = await new HeuristicExtractor().extract(transcript);

		expect(a.hda.content).toBe(transcript);
	});

	it("extracts each history keyword family into antecedentes", async () => {
		const transcript = [
			"Tem diabetes.",
			"São hipertensos.",
			"Tem cardiopatia.",
			"Tem tabagismo.",
			"Foi internado.",
			"Fez cirurgia.",
			"Tem quadro depressivo.",
		].join(" ");
		const a = await new HeuristicExtractor().extract(transcript);

		expect(a.antecedentes.content).toBe(transcript);
		expect(a.antecedentes.evidence).toHaveLength(7);
		expect(a.antecedentes.confidence).toBe("media");
	});

	it("handles an empty transcript", async () => {
		const a = await new HeuristicExtractor().extract("");
		expect(a.queixa_principal.content).toBe("Não identificada.");
		expect(a.queixa_principal.evidence).toEqual([]);
	});
});
