import { describe, expect, it } from "vitest";

import { anamnesisToText } from "./format.ts";
import { HeuristicExtractor } from "./heuristic.ts";
import { SAMPLE_TRANSCRIPT } from "./testing.ts";
import { HISTORY_SECTION_LABEL, SECTION_LABELS } from "./types.ts";
import type { AnamnesisSectionKey } from "./types.ts";

describe("anamnesisToText", () => {
	it("formats anamnesis into plain text sections", async () => {
		const anamnesis = await new HeuristicExtractor().extract(SAMPLE_TRANSCRIPT);
		const text = anamnesisToText(anamnesis);
		expect(text).toContain("CHIEF COMPLAINT\n");
		expect(text).toContain("HISTORY OF PRESENT ILLNESS\n");
		expect(text).toContain(anamnesis.queixa_principal.content);
		expect(text).toContain(anamnesis.conduta.content);
	});

	it("joins every section with a blank line, historico last", async () => {
		const anamnesis = await new HeuristicExtractor().extract(SAMPLE_TRANSCRIPT);
		const text = anamnesisToText({ ...anamnesis, historico: anamnesis.hda });

		const keys = Object.keys(SECTION_LABELS) as AnamnesisSectionKey[];
		const expected = keys
			.map((k) => `${SECTION_LABELS[k].toUpperCase()}\n${anamnesis[k].content}`)
			.concat(`${HISTORY_SECTION_LABEL.toUpperCase()}\n${anamnesis.hda.content}`)
			.join("\n\n");
		expect(text).toBe(expected);
	});
});
