/**
 * scriptgen.ts — seed-deterministic script rendering for the synthetic
 * dataset (T-099).
 *
 * Pipeline: persona + seed → slot tables pick locale content → `.eta`
 * template lays out the consultation → gold entities are emitted by the
 * SAME slot selection that produced the text (gold is never inferred
 * from rendered text — no circularity).
 *
 * Template sources arrive as strings — domain code never touches the
 * filesystem; adapters (or tests) read `templates/<locale>/*.eta`.
 *
 * Slot names are English literals; rendered content is locale data —
 * it lives in the active LocaleProfile (`locales/pt-BR.ts` is the
 * default). Provider details (voice ids, engines) never appear here.
 */

import { Eta } from "eta";

import type {
	AnamnesisDynamics,
	GenderedText,
	LocaleProfile,
	ScriptContent,
	ScriptPrescription,
} from "./locale.ts";
import { ptBR } from "./locales/pt-BR.ts";
import type { GoldEntity, Persona } from "./schema.ts";

export interface ScriptTurn {
	readonly speaker: "doctor" | "patient";
	readonly text: string;
}

export interface ScriptRender {
	readonly script: string;
	readonly turns: readonly ScriptTurn[];
	readonly entities: readonly GoldEntity[];
	readonly seed: number;
}

/** Declared prompt-registry identity of the `.eta` script template
 * (T-135): on the deterministic generation path the template IS the
 * prompt — eval-cli records name+version+content hash. `version` is
 * the template-FORMAT version (bump when slot/turn semantics change);
 * content drift is caught by the hash, not the version. The platform
 * `ai_prompt` table is the canonical store for PROD prompts; eval
 * prompts live in the domain pack, versioned with the code. */
export const SCRIPT_TEMPLATE_PROMPT_NAME = "eval.consultation/script-template";
export const SCRIPT_TEMPLATE_PROMPT_VERSION = 1;

/** Deterministic PRNG (mulberry32) — same seed → same slot picks.
 * Exported so persona enrichment draws from the same stream
 * discipline as script rendering. */
export const rng = (seed: number) => {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

/** Persona genders as the locale pools need them — patient drives
 * self-inflections ("sou alérgica") and honorifics the doctor uses
 * ("a senhora"); doctor drives honorifics the patient returns
 * ("não, senhora"). Defaults keep pre-gender personas working. */
const patientGenderOf = (persona: Persona): string => (persona.gender === "f" ? "f" : "m");
const doctorGenderOf = (persona: Persona): string => (persona.doctor?.gender === "f" ? "f" : "m");

/** Resolve a GenderedText — `by: "doctor"` entries inflect on the
 * doctor's gender, everything else on the patient's. */
export const genderText = (
	t: GenderedText,
	genders: { readonly patient: string; readonly doctor: string },
): string =>
	typeof t === "string"
		? t
		: (t.by === "doctor" ? genders.doctor : genders.patient) === "f"
			? t.f
			: t.m;

// ---------- context builder ----------

/** Builds the render context for a persona+seed. All randomness flows
 * through `rng(seed)` — no Date/Math.random, so output is replayable.
 * Slot content comes from `profile.script` — the locale owns the
 * strings, this function owns the selection logic. */
export const buildScriptContext = (
	persona: Persona,
	seed: number,
	profile: LocaleProfile = ptBR,
) => {
	const c: ScriptContent = profile.script;
	const rand = rng(seed);
	const register = persona.register === "formal" ? "formal" : "colloquial";
	const specialty =
		c.chiefComplaint[persona.specialty] !== undefined ? persona.specialty : "general_practice";

	const chiefComplaint = pick(rand, c.chiefComplaint[specialty]![register]!);
	const marked =
		register === "colloquial"
			? `${c.regionMarker[persona.region] ?? c.fallbackRegionMarker}, ${chiefComplaint}`
			: chiefComplaint;

	const genders = { patient: patientGenderOf(persona), doctor: doctorGenderOf(persona) };
	const denyAllergy = rand() < 0.6;
	const deny = pick(rand, c.allergyDeny);
	const affirm = pick(rand, c.allergyAffirm);
	const allergyAnswer = denyAllergy ? deny.text : genderText(affirm.text, genders);

	const rx: ScriptPrescription = pick(rand, c.prescriptions[specialty]!);
	const entities: GoldEntity[] = [
		...(denyAllergy ? [{ category: "negation" as const, value: deny.marker }] : []),
		...(denyAllergy ? [] : [{ category: "medication" as const, value: affirm.med }]),
		{ category: "medication", value: rx.med },
		{ category: "dosage", value: rx.dose },
		{ category: "frequency", value: rx.freq },
	];

	const slots = {
		greeting: genderText(pick(rand, c.greeting[register]!), genders),
		chief_complaint: marked,
		allergy_question: genderText(pick(rand, c.allergyQuestion[register]!), genders),
		allergy_answer: allergyAnswer,
		prescription: c.prescriptionText[register]!(rx),
		closing: pick(rand, c.closing[register]!),
	};

	const turns: ScriptTurn[] = [
		{ speaker: "doctor", text: slots.greeting },
		{ speaker: "patient", text: slots.chief_complaint },
		{ speaker: "doctor", text: slots.allergy_question },
		{ speaker: "patient", text: slots.allergy_answer },
		{ speaker: "doctor", text: slots.prescription },
		{ speaker: "doctor", text: slots.closing },
	];

	return { persona, slots, turns, entities };
};

// ---------- long-form anamnesis ----------

/** Build the dynamics + turn list for a full anamnesis dialogue.
 * Same seed discipline as buildScriptContext — every pick goes
 * through rng(seed). Falls back to undefined when the locale has
 * no `anamnesis` content, so callers degrade to the short form. */
/** Roughly four turns per spoken minute — each beat renders one or
 * two sentences, which read aloud at ~15s. */
const TURNS_PER_MINUTE = 4;

/** Scales the beat list to a target interview length. The opening
 * and closing beats always survive; the middle (HDA/history/exam)
 * is sampled evenly so a short consult still covers every section
 * instead of being chopped mid-anamnesis. */
const selectBeats = <T>(beats: readonly T[], minutes: number | undefined): readonly T[] => {
	if (minutes === undefined) return beats;
	const target = Math.max(4, Math.round(minutes * TURNS_PER_MINUTE));
	if (target >= beats.length) return beats;
	const head = beats.slice(0, 2);
	const tail = beats.slice(-2);
	const middle = beats.slice(2, -2);
	const take = target - head.length - tail.length;
	if (take <= 0) return [...head, ...tail];
	const step = middle.length / take;
	const mid = Array.from({ length: take }, (_, i) => middle[Math.floor(i * step)]!);
	return [...head, ...mid, ...tail];
};

const buildAnamnesisContext = (
	persona: Persona,
	seed: number,
	profile: LocaleProfile,
	minutes?: number,
): { turns: ScriptTurn[]; entities: GoldEntity[]; text: string } | undefined => {
	const a = profile.script.anamnesis;
	if (a === undefined) return undefined;
	const c = profile.script;
	const rand = rng(seed);
	const register = persona.register === "formal" ? "formal" : "colloquial";
	const specialty =
		c.chiefComplaint[persona.specialty] !== undefined ? persona.specialty : "general_practice";

	const genders = { patient: patientGenderOf(persona), doctor: doctorGenderOf(persona) };
	const minor = persona.ageBand === "child" || persona.ageBand === "teen";
	const complaint = pick(rand, c.chiefComplaint[specialty]![register]!);
	const denyAllergy = rand() < 0.6;
	const deny = pick(rand, c.allergyDeny);
	const affirm = pick(rand, c.allergyAffirm);
	const rx = pick(rand, c.prescriptions[specialty] ?? c.prescriptions["general_practice"]!);
	const rx2 =
		rand() < 0.5
			? pick(rand, c.prescriptions[specialty] ?? c.prescriptions["general_practice"]!)
			: undefined;
	const currentMeds = a.medPool.filter(() => rand() < 0.35).slice(0, 3);

	const dynamics: AnamnesisDynamics = {
		complaint,
		onset: pick(rand, a.onsets),
		intensity: 5 + Math.floor(rand() * 5),
		hpiDetail: pick(
			rand,
			a.hpiDetail[specialty]?.[register] ?? a.hpiDetail["general_practice"]![register]!,
		),
		associated: pick(rand, a.associated[specialty] ?? a.associated["general_practice"]!),
		comorbidities: genderText(pick(rand, pick(rand, a.comorbidSets)), genders),
		currentMeds,
		allergyAnswer: denyAllergy ? deny.text : genderText(affirm.text, genders),
		familyHx: genderText(pick(rand, a.familyHx), genders),
		habits: pick(rand, minor ? (a.minorHabits ?? a.habits) : a.habits),
		occupation: genderText(
			pick(rand, minor ? (a.minorOccupations ?? a.occupations) : a.occupations),
			genders,
		),
		examFindings: pick(rand, a.examFindings[specialty] ?? a.examFindings["general_practice"]!),
		hypothesis: pick(rand, a.hypothesis[specialty] ?? a.hypothesis["general_practice"]!),
		rx,
		rx2,
		vitals: {
			pa: `${110 + Math.floor(rand() * 30)} por ${70 + Math.floor(rand() * 20)}`,
			fc: 60 + Math.floor(rand() * 30),
			fr: 14 + Math.floor(rand() * 6),
			temp: `${36 + Math.floor(rand() * 2)},${Math.floor(rand() * 9)}`,
			sat: 95 + Math.floor(rand() * 5),
		},
		patientTag: persona.name ?? pick(rand, a.patientTags),
		patientGender: genders.patient,
		doctorGender: genders.doctor,
		minor,
	};

	const doctorRegister = persona.doctor?.register ?? "formal";
	const turns: ScriptTurn[] = selectBeats(a.beats, minutes).map((beat) => ({
		speaker: beat.speaker,
		// Each speaker keeps their own register — a colloquial
		// patient gets lay wording while the doctor stays formal.
		text: pick(rand, beat.variants)(
			dynamics,
			beat.speaker === "doctor" ? doctorRegister : register,
		),
	}));

	const entities: GoldEntity[] = [
		...(denyAllergy
			? [{ category: "negation" as const, value: deny.marker }]
			: [{ category: "medication" as const, value: affirm.med }]),
		...currentMeds.map((m) => ({ category: "medication" as const, value: m.med })),
		{ category: "medication", value: rx.med },
		{ category: "dosage", value: rx.dose },
		{ category: "frequency", value: rx.freq },
		...(rx2 !== undefined ? [{ category: "medication" as const, value: rx2.med }] : []),
	];

	return { turns, entities, text: turns.map((t) => t.text).join("\n") };
};

// ---------- render ----------

// autoTrim: false — a consultation is one turn per line; Eta's default
// slurping would collapse every turn into a single line.
const eta = new Eta({ autoEscape: false, autoTrim: false });

/** Renders a script from an `.eta` template source. Pure — the caller
 * supplies the template string; output is fully determined by
 * (template, persona, seed, profile). */
export const renderScript = (input: {
	readonly template: string;
	readonly persona: Persona;
	readonly seed: number;
	/** Locale profile — slot content + entity markers. Default pt-BR. */
	readonly profile?: LocaleProfile;
	/** "anamnesis" renders the full long-form dialogue (beats list,
	 * ~60 turns) when the locale provides it; anything else renders
	 * the template against the six-slot short context. */
	readonly variant?: "short" | "anamnesis";
	/** Target interview length in minutes — scales the beat list to
	 * ~4 turns/minute; absent renders the full anamnesis. */
	readonly minutes?: number;
}): ScriptRender => {
	const profile = input.profile ?? ptBR;
	if (input.variant === "anamnesis") {
		const long = buildAnamnesisContext(input.persona, input.seed, profile, input.minutes);
		if (long !== undefined) {
			return { script: long.text, turns: long.turns, entities: long.entities, seed: input.seed };
		}
		// Locale without anamnesis content — fall through to short.
	}
	const ctx = buildScriptContext(input.persona, input.seed, profile);
	const script = eta
		.renderString(input.template, ctx)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.join("\n");
	return { script, turns: ctx.turns, entities: ctx.entities, seed: input.seed };
};
