import type { PhiCategory } from "./anonymize.ts";

/**
 * locale.ts — the locale/profile port (T-118).
 *
 * Everything in the eval core that is language- or region-specific
 * lives behind `LocaleProfile`: text normalization (number words,
 * speaker labels, decimal separator), PHI scrub patterns, the ASR
 * language hint, and the script-generation slot tables. The domain
 * pipeline (metrics, anonymize, scriptgen, pipeline) is
 * language-agnostic — every entry point takes an optional profile
 * defaulting to `ptBR`, so existing call sites are unchanged.
 *
 * Adding a locale is additive: implement a `LocaleProfile` (see
 * `locales/pt-BR.ts` for the reference), add its `.eta` templates
 * under `templates/<locale-tag>/`, and pass the profile where the
 * pipeline is invoked. `profile.id` is what `StageMetrics.normalization`
 * persists — bump the id when normalization behavior changes.
 *
 * Deliberately NOT covered (follow-up, not forgotten):
 * - `personas.ts` DEFAULT_MATRIX axis values are Brazilian regions —
 *   English literals, but the region list itself is pt-BR geography.
 *   A second locale should ship its own matrix alongside its profile.
 * - Judge question phrasing in pipeline.ts is English already.
 * - eval-adapter-local adapter defaults (pt-BR edge-tts voices,
 *   faster-whisper "pt") are edge/provider concerns, owned by the
 *   adapters — the profile's `asrLanguage` is what the domain sends.
 */

/** One PHI scrub rule — regex + replacement token + audit category. */
export interface PiiPattern {
	readonly category: PhiCategory;
	readonly re: RegExp;
	readonly token: string;
}

/** A prescription slot triple — med name, dose, frequency. */
export interface ScriptPrescription {
	readonly med: string;
	readonly dose: string;
	readonly freq: string;
}

/**
 * Script-generation slot tables — English axis keys (register,
 * specialty, region) mapped to locale content. All randomness stays
 * in scriptgen.ts; this is pure data + tiny render functions.
 */
export interface ScriptContent {
	/** register → greeting line. */
	readonly greeting: Readonly<Record<string, readonly string[]>>;
	/** specialty → register → chief-complaint line. Must include a
	 * "general_practice" entry — scriptgen falls back to it for
	 * unknown specialties. */
	readonly chiefComplaint: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
	/** register → allergy question line. */
	readonly allergyQuestion: Readonly<Record<string, readonly string[]>>;
	/** Denial variants — `marker` is the gold negation entity. */
	readonly allergyDeny: readonly { readonly marker: string; readonly text: string }[];
	/** Affirmation variants — `med` is the gold medication entity. */
	readonly allergyAffirm: readonly { readonly med: string; readonly text: string }[];
	/** specialty → prescription candidates. */
	readonly prescriptions: Readonly<Record<string, readonly ScriptPrescription[]>>;
	/** register → prescription sentence renderer. */
	readonly prescriptionText: Readonly<Record<string, (p: ScriptPrescription) => string>>;
	/** register → closing line. */
	readonly closing: Readonly<Record<string, readonly string[]>>;
	/** persona region → discourse marker ("uai", "tchê"…). */
	readonly regionMarker: Readonly<Record<string, string>>;
	/** Marker used when the persona's region has no entry. */
	readonly fallbackRegionMarker: string;
	/** Long-form anamnesis content — when present, scriptgen can
	 * render a full history-taking dialogue (queixa → HDA →
	 * antecedentes → medicações → alergias → familiar → hábitos →
	 * exame → hipótese → prescrição → orientações → encerramento)
	 * instead of the six-turn micro-script. */
	readonly anamnesis?: AnamnesisContent;
}

/** Everything the doctor/patient dialogue needs that is picked
 * deterministically in scriptgen — the locale only owns the
 * text templates, never the picking. */
export interface AnamnesisDynamics {
	/** Specialty-keyed opening complaint — the same slot the short
	 * form uses, so short and long share a gold. */
	readonly complaint: string;
	/** "há cinco dias" / "faz umas duas semanas". */
	readonly onset: string;
	/** 0–10 pain/symptom intensity. */
	readonly intensity: number;
	/** Specialty-keyed detail the patient volunteers on HDA. */
	readonly hpiDetail: string;
	/** Specialty-keyed symptom cluster volunteered on association. */
	readonly associated: string;
	/** Comorbidity sentence — "não" or a picked list. */
	readonly comorbidities: string;
	/** Current medications the patient reports (may be empty →
	 * the beat text says "não usa nada"). */
	readonly currentMeds: readonly ScriptPrescription[];
	/** Allergic reaction answer (existing slot). */
	readonly allergyAnswer: string;
	/** Family-history sentence. */
	readonly familyHx: string;
	/** Tobacco/alcohol/exercise sentence. */
	readonly habits: string;
	/** Occupation/sleep sentence. */
	readonly occupation: string;
	/** Specialty-keyed exam findings the doctor narrates. */
	readonly examFindings: string;
	/** Working hypothesis phrased for the patient. */
	readonly hypothesis: string;
	/** Primary prescription (existing ScriptPrescription shape). */
	readonly rx: ScriptPrescription;
	/** Optional second prescription/symptomatic. */
	readonly rx2: ScriptPrescription | undefined;
	/** Vital signs narration values. */
	readonly vitals: {
		readonly pa: string;
		readonly fc: number;
		readonly fr: number;
		readonly temp: string;
		readonly sat: number;
	};
	/** Patient's spoken name fragment for the greeting beat —
	 * synthetic, never a real identifier. */
	readonly patientTag: string;
}

/** One dialogue beat: who speaks + text variants. Variants are
 * functions so dynamic picks (med names, vitals, onset) interpolate
 * into otherwise-static sentences without template logic. */
export interface AnamnesisBeat {
	readonly speaker: "doctor" | "patient";
	readonly variants: readonly ((d: AnamnesisDynamics, register: string) => string)[];
}

/** Locale-owned content for the long form — pure data. */
export interface AnamnesisContent {
	readonly beats: readonly AnamnesisBeat[];
	/** specialty → register → volunteered HDA detail sentences. */
	readonly hpiDetail: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
	/** specialty → associated-symptom clusters. */
	readonly associated: Readonly<Record<string, readonly string[]>>;
	/** specialty → exam findings the doctor narrates. */
	readonly examFindings: Readonly<Record<string, readonly string[]>>;
	/** specialty → hypothesis phrases. */
	readonly hypothesis: Readonly<Record<string, readonly string[]>>;
	/** onset phrases ("há cinco dias"…). */
	readonly onsets: readonly string[];
	/** comorbidity answer variants (arrays of sentences joined). */
	readonly comorbidSets: readonly string[][];
	/** current-medication pool the patient may report. */
	readonly medPool: readonly ScriptPrescription[];
	/** family-history answers. */
	readonly familyHx: readonly string[];
	/** habit answers (tobacco/alcohol/exercise). */
	readonly habits: readonly string[];
	/** occupation/sleep answers. */
	readonly occupations: readonly string[];
	/** patient worry/question beats answered by reassurance. */
	readonly patientQuestions: readonly string[];
	/** synthetic patient name tags — NEVER real names. */
	readonly patientTags: readonly string[];
}

/**
 * A locale profile — the single object the eval core needs to speak
 * (and measure) one language. Plain data + pure functions; no I/O,
 * no provider literals.
 */
export interface LocaleProfile {
	/** Stable profile id — persisted as StageMetrics.normalization.
	 * Version it like NORMALIZATION_PROFILE: "ptbr-v1". */
	readonly id: string;
	/** ASR language hint sent through AsrPort (e.g. "pt"). */
	readonly asrLanguage: string;
	/** Cardinal number → words, 0–9999+ ("50"→"cinquenta"). Must be
	 * deterministic; approximation is fine since ref and hyp
	 * normalize identically. */
	readonly numberToWords: (n: number) => string;
	/** Speaker-label stripper ("Doctor:", "Paciente:"…) — applied
	 * during normalize when stripSpeakers is on. Case-insensitive,
	 * must carry the /g flag. */
	readonly speakerLabelRe: RegExp;
	/** Word inserted between digits of a decimal ("2,5"→"2 virgula
	 * 5"). Supply the already-normalized (lowercase, unaccented)
	 * form — it is inserted after the foldAccents step. */
	readonly decimalWord: string;
	/** PHI scrub rules applied by anonymize/gateTranscript. */
	readonly piiPatterns: readonly PiiPattern[];
	/** Residual-identifier heuristic for gateTranscript — long digit
	 * runs that survived scrubbing fail the gate. Used with `.test()`,
	 * so it must NOT carry the /g flag (lastIndex is stateful). */
	readonly residualIdRe: RegExp;
	/** Script-generation slot tables for this locale. */
	readonly script: ScriptContent;
}
