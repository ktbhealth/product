import { describe, expect, it } from "vitest";

import { checkEntities } from "../metrics.ts";
import { Sample } from "../schema.ts";
import { Schema } from "effect";
import { PTBR_CONSULTATIONS } from "./consultations.ts";
import {
	buildPtbrSyntheticSamples,
	PTBR_SYNTHETIC_HELDOUT_SLUGS,
	ptbrConsultToSample,
	ptbrSyntheticAudioUri,
	ptbrSyntheticDatasetVersion,
	ptbrSyntheticSampleId,
	ptbrSyntheticSplit,
	PTBR_SYNTHETIC_DATASET_ID,
	PTBR_SYNTHETIC_DATASET_VERSION,
} from "./dataset.ts";
import type { PtbrConsult } from "./types.ts";
import { suite } from "../../consult-ptbr-synthetic.suite.ts";

const scriptOf = (c: PtbrConsult): string => c.turns.map((t) => t.text).join("\n");

describe("PTBR_CONSULTATIONS (authored cohort)", () => {
	it("has 24 consults across 8 specialties", () => {
		expect(PTBR_CONSULTATIONS).toHaveLength(24);
		const bySpecialty = new Map<string, number>();
		for (const c of PTBR_CONSULTATIONS) {
			bySpecialty.set(c.specialty, (bySpecialty.get(c.specialty) ?? 0) + 1);
		}
		expect([...bySpecialty.keys()].sort()).toEqual([
			"cardiology",
			"dermatology",
			"general_practice",
			"geriatrics",
			"gynecology",
			"orthopedics",
			"pediatrics",
			"psychiatry",
		]);
		// Base cohort is 3/specialty; edge cases add uneven coverage —
		// every specialty still has at least one consult.
		for (const n of bySpecialty.values()) expect(n).toBeGreaterThanOrEqual(1);
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

	it("pins the consult-ptbr-synthetic@v2 dataset identity", () => {
		expect(PTBR_SYNTHETIC_DATASET_ID).toBe("consult-ptbr-synthetic");
		expect(PTBR_SYNTHETIC_DATASET_VERSION).toBe("v2");
		expect(ptbrSyntheticDatasetVersion()).toBe("consult-ptbr-synthetic-v2");
	});

	it("keeps the suite manifest's dataset pin in lockstep with the materializer", () => {
		// `eval run` looks samples up by `${dataset.id}-${dataset.version}`
		// from the suite manifest — a stale pin finds zero rows.
		expect(suite.dataset).toEqual({
			id: PTBR_SYNTHETIC_DATASET_ID,
			version: PTBR_SYNTHETIC_DATASET_VERSION,
		});
	});
});

describe("eval split and axes metadata", () => {
	const baseConsult: PtbrConsult = {
		slug: "test-consult",
		specialty: "general_practice",
		region: "southeast",
		ageBand: "adult",
		register: "colloquial",
		gender: "f",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Teste",
		doctor: { gender: "m", register: "formal" },
		turns: [
			{ speaker: "doctor", text: "Olá, como você está?" },
			{ speaker: "patient", text: "Tudo bem, doutor." },
		],
		entities: [{ category: "medication", value: "dipirona" }],
	};

	it("assigns every consult a split — slug override or field", () => {
		for (const c of PTBR_CONSULTATIONS) {
			const expected =
				PTBR_SYNTHETIC_HELDOUT_SLUGS.includes(c.slug) || c.split === "heldout"
					? "heldout"
					: "train";
			expect(ptbrSyntheticSplit(c)).toBe(expected);
		}
		expect(ptbrSyntheticSplit(baseConsult)).toBe("train");
	});

	it("stamps evalSplit on every sample — heldout wins", () => {
		const samples = buildPtbrSyntheticSamples();
		const bySlug = new Map(PTBR_CONSULTATIONS.map((c) => [c.slug, c]));
		for (const s of samples) {
			const slug = s.id.replace(/^ptbr-/, "");
			expect(s.evalSplit).toBe(ptbrSyntheticSplit(bySlug.get(slug)!));
		}
		expect(PTBR_SYNTHETIC_HELDOUT_SLUGS).toHaveLength(3);
		// ~20% of the cohort is heldout: 3 slug-forced + 2 field-marked.
		const heldoutCount = PTBR_CONSULTATIONS.filter(
			(c) => ptbrSyntheticSplit(c) === "heldout",
		).length;
		expect(heldoutCount).toBe(5);
	});

	it("heldout slug override beats an explicit consult.split", () => {
		const forced = { ...baseConsult, slug: "gp-cefaleia-01", split: "train" as const };
		expect(ptbrSyntheticSplit(forced)).toBe("heldout");
		expect(ptbrConsultToSample(forced, "v").evalSplit).toBe("heldout");
	});

	it("consult.split=heldout marks non-listed slugs heldout", () => {
		const heldout = { ...baseConsult, split: "heldout" as const };
		expect(ptbrSyntheticSplit(heldout)).toBe("heldout");
		expect(ptbrConsultToSample(heldout, "v").evalSplit).toBe("heldout");
	});

	it("propagates axes to the sample and omits them when absent", () => {
		const tagged = ptbrConsultToSample(
			{ ...baseConsult, axes: ["negation-dense", "numeric-dense"] },
			"v",
		);
		expect(tagged.axes).toEqual(["negation-dense", "numeric-dense"]);
		const untagged = ptbrConsultToSample(baseConsult, "v");
		expect(untagged.axes).toBeUndefined();
		// Decoded rows keep the metadata — the schema fields are real.
		const decode = Schema.decodeUnknownSync(Sample);
		expect(decode(tagged).axes).toEqual(["negation-dense", "numeric-dense"]);
		expect(decode(tagged).evalSplit).toBe("train");
	});
});
