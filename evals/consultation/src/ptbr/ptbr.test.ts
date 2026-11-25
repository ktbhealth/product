import { describe, expect, it } from "vitest";

import { checkEntities } from "../metrics.ts";
import { Sample } from "../schema.ts";
import { Schema } from "effect";
import { PTBR_CONSULTATIONS } from "./consultations.ts";
import {
	buildPtbrSyntheticSamples,
	ptbrSyntheticAudioUri,
	ptbrSyntheticDatasetVersion,
	ptbrSyntheticSampleId,
	PTBR_SYNTHETIC_DATASET_ID,
	PTBR_SYNTHETIC_DATASET_VERSION,
} from "./dataset.ts";
import type { PtbrConsult } from "./types.ts";

const scriptOf = (c: PtbrConsult): string => c.turns.map((t) => t.text).join("\n");

describe("PTBR_CONSULTATIONS (authored cohort)", () => {
	it("has 18 consults across 6 specialties, 3 each", () => {
		expect(PTBR_CONSULTATIONS).toHaveLength(18);
		const bySpecialty = new Map<string, number>();
		for (const c of PTBR_CONSULTATIONS) {
			bySpecialty.set(c.specialty, (bySpecialty.get(c.specialty) ?? 0) + 1);
		}
		expect([...bySpecialty.keys()].sort()).toEqual([
			"cardiology",
			"dermatology",
			"general_practice",
			"gynecology",
			"orthopedics",
			"pediatrics",
		]);
		for (const n of bySpecialty.values()) expect(n).toBe(3);
	});

	it("has unique slugs and well-formed turns", () => {
		const slugs = new Set<string>();
		for (const c of PTBR_CONSULTATIONS) {
			expect(slugs.has(c.slug)).toBe(false);
			slugs.add(c.slug);
			expect(c.turns.length).toBeGreaterThanOrEqual(10);
			expect(c.entities.length).toBeGreaterThanOrEqual(3);
			const speakers = new Set(c.turns.map((t) => t.speaker));
			expect(speakers).toEqual(new Set(["doctor", "patient"]));
			for (const t of c.turns) {
				expect(t.text.trim().length).toBeGreaterThan(0);
			}
			// Persona coherence spot-checks — pediatric patients are
			// minors, gynecology patients are female.
			if (c.specialty === "pediatrics") {
				expect(["child", "teen"]).toContain(c.ageBand);
			}
			if (c.specialty === "gynecology") expect(c.gender).toBe("f");
		}
	});

	it("every gold entity is present in the script text", () => {
		for (const c of PTBR_CONSULTATIONS) {
			const verdicts = checkEntities(c.entities, scriptOf(c));
			for (const [i, v] of verdicts.entries()) {
				// "dropped" = the entity value does not appear in the
				// gold transcript — an authoring bug the dataset must
				// never ship. Negations floor at "unverified" by design
				// (metrics.ts: presence ≠ proven polarity).
				expect(v.status, `${c.slug} entity[${i}] ${v.entity}`).not.toBe("dropped");
				if (c.entities[i]!.category !== "negation") {
					expect(v.status, `${c.slug} entity[${i}] ${v.entity}`).toBe("correct");
				}
			}
		}
	});
});

describe("buildPtbrSyntheticSamples", () => {
	it("projects every consult into a schema-valid Sample", () => {
		const samples = buildPtbrSyntheticSamples();
		expect(samples).toHaveLength(PTBR_CONSULTATIONS.length);
		const decode = Schema.decodeUnknownSync(Sample);
		for (const [i, s] of samples.entries()) {
			const c = PTBR_CONSULTATIONS[i]!;
			expect(() => decode(s)).not.toThrow();
			expect(s.datasetVersion).toBe(ptbrSyntheticDatasetVersion());
			expect(s.origin).toBe("synthetic");
			expect(s.id).toBe(ptbrSyntheticSampleId(c));
			expect(s.audio?.uri).toBe(ptbrSyntheticAudioUri(c));
			expect(s.audio?.uri.startsWith("pending://ptbr-synthetic/")).toBe(true);
			expect(s.turns).toHaveLength(c.turns.length);
			expect(s.gold.entities).toEqual(c.entities);
			expect(s.persona.specialty).toBe(c.specialty);
			expect(s.persona.name).toBe(c.patientName);
		}
	});

	it("is deterministic — same input, same samples", () => {
		expect(buildPtbrSyntheticSamples()).toEqual(buildPtbrSyntheticSamples());
	});

	it("limit slices the stable cohort order", () => {
		const all = buildPtbrSyntheticSamples();
		const few = buildPtbrSyntheticSamples({ limit: 4 });
		expect(few).toHaveLength(4);
		expect(few.map((s) => s.id)).toEqual(all.slice(0, 4).map((s) => s.id));
	});

	it("pins the consult-ptbr-synthetic@v1 dataset identity", () => {
		expect(PTBR_SYNTHETIC_DATASET_ID).toBe("consult-ptbr-synthetic");
		expect(PTBR_SYNTHETIC_DATASET_VERSION).toBe("v1");
		expect(ptbrSyntheticDatasetVersion()).toBe("consult-ptbr-synthetic-v1");
	});
});
