import type { Persona } from "./schema.ts";

/** Abstract voice aliases per gender — the adapter's voiceMap
 * resolves them to engine voices; domain code only sees these
 * literals. More than one per gender so samples vary timbre, not
 * just who holds which role. */
export const VOICE_POOL: Readonly<Record<string, readonly string[]>> = {
	m: ["br_male_1", "br_male_2", "br_male_3"],
	f: ["br_female_1", "br_female_2", "br_female_3"],
};

/**
 * Persona matrix — the axes the dataset varies over. Each sample is
 * one cell: region (speech register/accent cue for the TTS + script
 * generator) × age band × register (education/social class proxy) ×
 * specialty. Literals are English — generators map them to locale
 * content via the active LocaleProfile; they never leak provider ids
 * or rendered text. NOTE: the default region list is Brazilian
 * geography — a non-pt-BR locale should ship its own matrix (see
 * locale.ts).
 */

export interface PersonaMatrix {
	readonly regions: readonly string[];
	readonly ageBands: readonly string[];
	readonly registers: readonly string[];
	readonly specialties: readonly string[];
}

/** Default matrix — covers the diversity axes the eval must
 * prove: regional accent/register, life stage, clinical domain. */
export const DEFAULT_MATRIX: PersonaMatrix = {
	regions: ["southeast", "south", "northeast", "north", "central_west"],
	ageBands: ["child", "adult", "elderly"],
	registers: ["formal", "colloquial"],
	specialties: [
		"general_practice",
		"pediatrics",
		"gynecology",
		"geriatrics",
		"cardiology",
		"psychiatry",
	],
};

/** Every cell of the matrix — cartesian product, stable order
 * (region outer → specialty inner). */
export const expandPersonaMatrix = (matrix: PersonaMatrix): Persona[] =>
	matrix.regions.flatMap((region) =>
		matrix.ageBands.flatMap((ageBand) =>
			matrix.registers.flatMap((register) =>
				matrix.specialties.map((specialty) => ({ region, ageBand, register, specialty })),
			),
		),
	);

/** Deterministic sub-sample for quick runs: every `step`-th cell of
 * the expansion, offset by `start`. Stable across runs — same params,
 * same personas. */
export const sampleMatrix = (matrix: PersonaMatrix, step: number, start = 0): Persona[] => {
	const all = expandPersonaMatrix(matrix);
	return all.filter((_, i) => (i - start) % Math.max(1, step) === 0);
};

// ---------- persona enrichment (T-128) ----------

/** Synthetic patient name tags by gender — NEVER real identifiers.
 * The greeting beat speaks them; they exist so a validator can tell
 * personas apart in the UI ("Paciente Helena" reads better than a
 * hash). */
const NAME_TAGS: Readonly<Record<string, readonly string[]>> = {
	f: ["Paciente Helena", "Paciente Marta", "Paciente Sofia", "Paciente Lia"],
	m: ["Paciente Rui", "Paciente Davi", "Paciente Nilo", "Paciente Otto"],
};

/** Voice alias for a persona role — gender-keyed pool pick under
 * the same rng stream so voice follows the persona, deterministically. */
export const voiceFor = (
	gender: string | undefined,
	rand: () => number,
	pool: Readonly<Record<string, readonly string[]>> = VOICE_POOL,
): string => {
	const key = gender === "f" ? "f" : "m";
	return pickR(rand, pool[key] ?? pool["m"]!);
};

const pickR = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

/** Fill the demographic fields a bare matrix cell lacks, seeded by
 * the same rng discipline as scriptgen — same (cell, seed) → same
 * enriched persona. Constraints:
 * - gynecology patients are always female; pediatrics keeps either.
 * - register ↔ class/education stay correlated: colloquial cells
 *   draw from c/d/e + elementary/secondary, formal cells from
 *   a/b/c + higher/postgraduate. A "formal, classe e" persona is
 *   unrealistic; the eval's job is believable pairs, not the full
 *   cartesian space.
 * - The doctor is derived (not a matrix axis): gender 50/50,
 *   register always formal — clinicians code-switch upward. */
export const enrichPersona = (
	cell: Persona,
	rand: () => number,
	nameTags?: Readonly<Record<string, readonly string[]>>,
): Persona => {
	// Callers may pass "female"/"male" instead of the compact f/m —
	// normalize before it keys pools.
	const normGender = (g: string | undefined): string | undefined =>
		g === undefined ? undefined : g === "f" || g === "female" ? "f" : "m";
	const colloquial = cell.register === "colloquial";
	const gender =
		normGender(cell.gender) ?? (cell.specialty === "gynecology" ? "f" : rand() < 0.5 ? "f" : "m");
	const socialClass =
		cell.socialClass ??
		(colloquial ? pickR(rand, ["c", "d", "d", "e"]) : pickR(rand, ["a", "b", "b", "c"]));
	const education =
		cell.education ??
		(colloquial
			? pickR(rand, ["elementary", "elementary", "secondary"])
			: pickR(rand, ["higher", "higher", "postgraduate"]));
	const tags = nameTags?.[gender] ?? NAME_TAGS[gender]!;
	const name = cell.name ?? pickR(rand, tags);
	const doctor = cell.doctor ?? {
		gender: rand() < 0.5 ? "f" : "m",
		// Most clinicians code-switch up; a minority of consults are
		// genuinely informal (rural GP, long-standing patient).
		register: rand() < 0.2 ? "colloquial" : "formal",
	};
	return { ...cell, gender, socialClass, education, name, doctor };
};
