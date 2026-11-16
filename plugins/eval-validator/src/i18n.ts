/**
 * Eval validator copy, one typed catalog per locale. Plugins cannot
 * import the app's i18n runtime — the panel page ctx carries the
 * active locale and the view resolves its strings here.
 */
export const EVAL_LOCALES = ["en", "pt-BR", "es"] as const;
export type EvalLocale = (typeof EVAL_LOCALES)[number];
export const BASE_LOCALE: EvalLocale = "en";

export interface EvalMessages {
	readonly title: string;
	readonly description: string;
	readonly generate: string;
	readonly runEval: string;
	readonly view: string;
	readonly approve: string;
	readonly reject: string;
	readonly pending: string;
	readonly approved: string;
	readonly rejected: string;
	readonly personas: string;
	readonly doctor: string;
	readonly voices: string;
	readonly feedbackPlaceholder: string;
	readonly feedback: string;
	readonly run: string;
	readonly samplesOf: string;
	readonly emptyBatches: string;
	readonly emptyPersonas: string;
	readonly moreTurns: string;
}

const en: EvalMessages = {
	title: "Eval validator",
	description: "Generate persona cohorts, review them, then run the eval and inspect metrics.",
	generate: "Generate personas",
	runEval: "Run eval",
	view: "View",
	approve: "Approve",
	reject: "Reject",
	pending: "pending",
	approved: "approved",
	rejected: "rejected",
	personas: "personas",
	doctor: "Doctor",
	voices: "voices",
	feedbackPlaceholder: "feedback (optional)",
	feedback: "Feedback",
	run: "Run",
	samplesOf: "samples",
	emptyBatches: "No persona batches yet — generate one to start reviewing.",
	emptyPersonas: "Select a batch to review its personas.",
	moreTurns: "more turns",
};

const ptBR: EvalMessages = {
	...en,
	title: "Validador de eval",
	description: "Gere personas, revise-as, depois rode o eval e inspecione as métricas.",
	generate: "Gerar personas",
	runEval: "Rodar eval",
	view: "Ver",
	approve: "Aprovar",
	reject: "Rejeitar",
	pending: "pendentes",
	approved: "aprovadas",
	rejected: "rejeitadas",
	personas: "personas",
	doctor: "Médico",
	voices: "vozes",
	feedbackPlaceholder: "feedback (opcional)",
	run: "Run",
	samplesOf: "amostras",
	emptyBatches: "Nenhuma coorte ainda — gere uma para começar a revisão.",
	emptyPersonas: "Selecione uma coorte para revisar as personas.",
	moreTurns: "turnos a mais",
};

const es: EvalMessages = { ...en };

const CATALOGS: Record<EvalLocale, EvalMessages> = { en, "pt-BR": ptBR, es };

export const isEvalLocale = (locale: string): locale is EvalLocale =>
	(EVAL_LOCALES as readonly string[]).includes(locale);

export const evalMessages = (locale: string): EvalMessages =>
	CATALOGS[isEvalLocale(locale) ? locale : BASE_LOCALE];
