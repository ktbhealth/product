import { CARDIOLOGY } from "./cardiology.ts";
import { DERMATOLOGY } from "./dermatology.ts";
import { EDGE_CASES_A } from "./edge-cases-a.ts";
import { EDGE_CASES_B } from "./edge-cases-b.ts";
import { GENERAL_PRACTICE } from "./general-practice.ts";
import { GYNECOLOGY } from "./gynecology.ts";
import { ORTHOPEDICS } from "./orthopedics.ts";
import { PEDIATRICS } from "./pediatrics.ts";
import type { PtbrConsult } from "./types.ts";

/**
 * The full authored cohort — 6 specialty files (18 consults) plus
 * the edge-case files targeting ASR weak spots (negation density,
 * polypharmacy, numerics, code-switching, interruptions) = 24
 * consultations across 8 specialties. Order is stable (specialty
 * file order, then in-file order) so sample ids and the dataset
 * contentHash are reproducible across runs and machines.
 */
export const PTBR_CONSULTATIONS: readonly PtbrConsult[] = [
	...GENERAL_PRACTICE,
	...CARDIOLOGY,
	...DERMATOLOGY,
	...ORTHOPEDICS,
	...PEDIATRICS,
	...GYNECOLOGY,
	...EDGE_CASES_A,
	...EDGE_CASES_B,
];
