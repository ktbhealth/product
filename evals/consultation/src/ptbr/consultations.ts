import { CARDIOLOGY } from "./cardiology.ts";
import { DERMATOLOGY } from "./dermatology.ts";
import { GENERAL_PRACTICE } from "./general-practice.ts";
import { GYNECOLOGY } from "./gynecology.ts";
import { ORTHOPEDICS } from "./orthopedics.ts";
import { PEDIATRICS } from "./pediatrics.ts";
import type { PtbrConsult } from "./types.ts";

/**
 * The full authored cohort — 6 specialties × 3 consults = 18
 * consultations. Order is stable (specialty file order, then
 * in-file order) so sample ids and the dataset contentHash are
 * reproducible across runs and machines.
 */
export const PTBR_CONSULTATIONS: readonly PtbrConsult[] = [
	...GENERAL_PRACTICE,
	...CARDIOLOGY,
	...DERMATOLOGY,
	...ORTHOPEDICS,
	...PEDIATRICS,
	...GYNECOLOGY,
];
