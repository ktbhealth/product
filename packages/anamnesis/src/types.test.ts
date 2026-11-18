import { describe, expect, it } from "vitest";

import { CONFIDENCE_LABELS, SECTION_LABELS } from "./types.ts";

describe("types labels", () => {
	it("maps every confidence value to its English label", () => {
		expect(CONFIDENCE_LABELS).toEqual({
			alta: "high confidence",
			media: "medium confidence",
			baixa: "low confidence",
		});
	});

	it("maps every section key to its English label", () => {
		expect(SECTION_LABELS).toEqual({
			queixa_principal: "Chief complaint",
			hda: "History of present illness",
			antecedentes: "Past medical history",
			alergias: "Allergies",
			medicamentos_em_uso: "Current medications",
			exame_fisico: "Physical examination",
			hipoteses: "Diagnostic hypotheses",
			conduta: "Management plan",
		});
	});
});
