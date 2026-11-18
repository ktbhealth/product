/**
 * llmscript.ts — LLM-driven consultation script generation (the
 * hybrid path): personas stay procedural (matrix + rng), the DIALOGUE
 * is delegated to an LlmPort through a TaskEnvelope.
 *
 * The domain owns two pure pieces:
 * - `buildScriptPrompt` — persona → prompt (pt-BR, demographic
 *   constraints, anamnesis structure, register rules, output format)
 * - `parseScriptTurns` — LLM text → typed turns, with validation
 *
 * The caller (eval-validator service) falls back to the template
 * renderScript when no LlmPort is bound or the response fails
 * validation — the pipeline never stalls on a missing driver.
 */

import type { PromptRef } from "@ktb/eval-core";

import { fnvHex } from "./generate.ts";
import type { Persona } from "./schema.ts";
import type { ScriptTurn } from "./scriptgen.ts";

/** Roughly four turns per spoken minute — same calibration the
 * template renderer uses (~60 turns for a full 15min anamnesis). */
export const TURNS_PER_MINUTE = 4;

/** Turn budget for a requested interview length. */
export const turnsFor = (minutes: number | undefined): number =>
	minutes === undefined ? 60 : Math.max(8, Math.round(minutes * TURNS_PER_MINUTE));

const EDUCATION_LABEL: Record<string, string> = {
	elementary: "ensino fundamental",
	secondary: "ensino médio",
	higher: "ensino superior",
	postgraduate: "pós-graduação",
};

const REGISTER_RULE: Record<string, string> = {
	colloquial:
		"O paciente fala de forma coloquial e leiga — diz 'dor de cabeça', nunca 'cefaleia'; descreve sintomas com palavras do dia a dia, hesita, repete e completa respostas aos poucos.",
	formal:
		"O paciente fala de forma polida e pode usar alguns termos técnicos corretos, mas continua sendo paciente — não profissional de saúde.",
};

/** Persona → generation prompt. Deterministic given the persona —
 * all randomness belongs to the LLM call itself; the envelope's
 * `seed` records intent for replay. */
export const buildScriptPrompt = (input: {
	readonly persona: Persona;
	readonly minutes?: number;
}): string => {
	const p = input.persona;
	const turns = turnsFor(input.minutes);
	const register = p.register === "formal" ? "formal" : "colloquial";
	const doctorGender = p.doctor?.gender ?? "female";
	const doctorRegister = p.doctor?.register ?? "formal";
	const dra = doctorGender === "female" ? "Dra." : "Dr.";
	return [
		"Você escreve roteiros de consultas médicas sintéticas em português brasileiro para avaliação de transcrição por voz.",
		"",
		`Escreva uma consulta COMPLETA com aproximadamente ${turns} falas alternando entre médico e paciente.`,
		"",
		"PACIENTE:",
		`- Nome fictício: ${p.name ?? "Paciente"}`,
		`- Faixa etária: ${p.ageBand ?? "adulto"}`,
		`- Gênero: ${p.gender ?? "não informado"}`,
		`- Região do Brasil: ${p.region ?? "sudeste"}`,
		`- Classe social: ${p.socialClass ?? "c"}`,
		`- Escolaridade: ${EDUCATION_LABEL[p.education ?? "secondary"] ?? p.education}`,
		`- Registro de fala: ${register}`,
		REGISTER_RULE[register]!,
		"",
		"MÉDICO:",
		`- ${dra} atende em ${p.specialty ?? "clínica geral"}`,
		`- Registro de fala: ${doctorRegister} — linguagem profissional, acolhedora e clara`,
		"",
		"ESTRUTURA (cubra todas as seções na ordem, distribuindo as falas):",
		"abertura e acolhimento → queixa principal → história da doença atual (início, localização, caráter, intensidade, fatores) → sintomas associados → antecedentes e comorbidades → medicações em uso → alergias → história familiar → hábitos e ocupação → exame físico com sinais vitais → hipóteses → conduta com prescrição → orientações e retorno → encerramento.",
		"",
		"REGRAS:",
		"- Use nomes REAIS de medicamentos com posologia completa (dose + frequência), ex.: 'Losartana 50 mg, um comprimido pela manhã'.",
		"- Sinais vitais plausíveis (PA '12 por 8', FC, FR, temperatura, saturação).",
		"- O paciente responde como uma pessoa real daquela classe social e escolaridade — frases naturais, às vezes incompletas, com preenchimentos ('é', 'tipo', 'sabe').",
		"- O médico conduz a anamnese com perguntas curtas e diretas.",
		`- ${register === "colloquial" ? "NADA de termos técnicos na fala do paciente." : "O paciente pode usar termos corretos quando apropriado."}`,
		"",
		"FORMATO DE SAÍDA — rigoroso:",
		"- Uma fala por linha, no formato 'doctor: texto' ou 'patient: texto'.",
		"- Comece com uma fala do doctor. Alterne os turnos naturalmente.",
		"- SEM preâmbulo, SEM títulos, SEM markdown — apenas as linhas do diálogo.",
	].join("\n");
};

const SPEAKER_LINE =
	/^\s*(?:doctor|patient|m[eé]dico|paciente|doutor(?:a)?|dr\.?a?)\s*[:.]\s*(.+)$/i;

const canonicalSpeaker = (label: string): "doctor" | "patient" =>
	/^(patient|paciente)$/i.test(label) ? "patient" : "doctor";

/**
 * LLM text → typed turns. Lines that don't carry a `speaker:` label
 * are skipped (preamble tolerance); returns null when the result has
 * fewer than 4 turns or a single speaker — the caller falls back to
 * the template renderer.
 */
export const parseScriptTurns = (text: string): ScriptTurn[] | null => {
	const turns: ScriptTurn[] = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*([A-Za-zÀ-ÿ.]+)\s*[:.]\s*(.+)$/);
		if (m === null) continue;
		const labeled = `${m[1]}: ${m[2]}`.match(SPEAKER_LINE);
		if (labeled === null) continue;
		const speaker = canonicalSpeaker(m[1]!);
		const content = m[2]!.trim();
		if (content.length === 0) continue;
		turns.push({ speaker, text: content });
	}
	if (turns.length < 4) return null;
	const speakers = new Set(turns.map((t) => t.speaker));
	if (speakers.size < 2) return null;
	return turns;
};

/** Joined gold text for the persona row — one utterance per line,
 * NO speaker labels: the template renderer's convention (metrics
 * strip labels anyway, and raw labels would pollute the word diff). */
export const turnsToScript = (turns: readonly ScriptTurn[]): string =>
	turns.map((t) => t.text).join("\n");

// ---------- prompt identity (T-135) ----------

/** Declared name/version of the script-generation prompt — the
 * pack's own registry coordinates. The platform `ai_prompt` table is
 * the canonical store for PROD prompts; eval prompts live in the
 * domain pack, versioned with the code (Experiment.gitSha pins the
 * commit). Bump `version` when the instruction set changes meaning;
 * `hash` catches ANY drift automatically. */
export const SCRIPT_GEN_PROMPT_NAME = "eval.consultation/script-gen";
export const SCRIPT_GEN_PROMPT_VERSION = 1;

/** Fixed persona the content hash renders — pins the prompt TEMPLATE
 * (every static rule/structure line), not one persona's slot values. */
const CANONICAL_SCRIPT_PERSONA: Persona = {
	region: "southeast",
	ageBand: "adult",
	register: "colloquial",
	specialty: "general_practice",
	gender: "female",
	socialClass: "c",
	education: "secondary",
	name: "Paciente Hash",
	doctor: { gender: "female", register: "formal" },
};

/** Canonical render of the generation prompt — deterministic given
 * the code; the hash input for SCRIPT_GEN_PROMPT. */
export const canonicalScriptPrompt = (): string =>
	buildScriptPrompt({ persona: CANONICAL_SCRIPT_PERSONA, minutes: 15 });

/** fnv1a content hash of canonicalScriptPrompt — the pack's
 * dependency-free hash (same function as Sample.scriptHash). */
export const scriptGenPromptHash = (): string => fnvHex(canonicalScriptPrompt());

/** PromptRef for the script-generation prompt — stamped on
 * script_gen RunRecords and recorded in Experiment.summary by
 * consumers. Honestly labeled: this is the PACK's prompt identity,
 * resolved offline — no platform ai_prompt row is queried. */
export const SCRIPT_GEN_PROMPT: PromptRef = {
	name: SCRIPT_GEN_PROMPT_NAME,
	version: SCRIPT_GEN_PROMPT_VERSION,
	hash: scriptGenPromptHash(),
};
