/**
 * Eval validator copy, one typed catalog per locale. Plugins cannot
 * import the app's i18n runtime — the panel page ctx carries the
 * active locale and the view resolves its strings here.
 */
export const EVAL_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "eval.validator";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): EvalMessages => evalMessages(locale);
export type EvalLocale = (typeof EVAL_LOCALES)[number];
const BASE_LOCALE: EvalLocale = "en";

export interface EvalMessages {
	readonly title: string;
	readonly description: string;
	readonly stepPersonas: string;
	readonly stepGenerate: string;
	readonly stepRunEval: string;
	readonly runEval: string;
	readonly view: string;
	readonly approve: string;
	readonly reject: string;
	readonly pending: string;
	readonly approved: string;
	readonly rejected: string;
	readonly items: string;
	readonly generating: string;
	readonly doctor: string;
	readonly voices: string;
	readonly feedbackPlaceholder: string;
	readonly feedback: string;
	readonly run: string;
	readonly samplesOf: string;
	readonly emptyCohorts: string;
	readonly emptyItems: string;
	readonly moreTurns: string;
	readonly actionFailed: string;
	readonly synthetic: string;
	readonly deleteRun: string;
	readonly confirmDelete: string;
	readonly stageCleanup: string;
	readonly stageAnamnesis: string;
	readonly stageError: string;
	readonly completeness: string;
	readonly edits: string;
	readonly noRunnerBound: string;
	readonly runnerInline: string;
}

const en: EvalMessages = {
	title: "Run eval",
	description:
		"Review the generated consultations of a cohort, approve them, then run the eval and inspect per-stage metrics.",
	stepPersonas: "1 · Personas",
	stepGenerate: "2 · Generate consultations",
	stepRunEval: "3 · Run eval",
	runEval: "Run eval",
	view: "View",
	approve: "Approve",
	reject: "Reject",
	pending: "pending",
	approved: "approved",
	rejected: "rejected",
	items: "consultations",
	generating: "generating",
	doctor: "Doctor",
	voices: "voices",
	feedbackPlaceholder: "feedback (optional)",
	feedback: "Feedback",
	run: "Run",
	samplesOf: "samples",
	emptyCohorts: "No cohorts yet — generate consultations on step 2 first.",
	emptyItems: "Select a cohort to review its consultations.",
	moreTurns: "more turns",
	actionFailed: "Action failed — check your permissions and try again.",
	synthetic: "synthetic",
	deleteRun: "Delete run",
	confirmDelete: "Confirm delete",
	stageCleanup: "cleanup",
	stageAnamnesis: "anamnesis",
	stageError: "stage error",
	completeness: "completeness",
	edits: "edits",
	noRunnerBound:
		"no eval runner bound — install/configure the local eval drivers (EVAL_RUNNER_DIR + EVAL_ASR_BASE_URL) or runs stay queued",
	runnerInline: "runner bound but no jobs queue — runs execute inline",
};

const ptBR: EvalMessages = {
	...en,
	title: "Rodar eval",
	description:
		"Revise as consultas geradas de uma coorte, aprove-as, depois rode o eval e inspecione as métricas por estágio.",
	stepPersonas: "1 · Personas",
	stepGenerate: "2 · Gerar consultas",
	stepRunEval: "3 · Rodar eval",
	runEval: "Rodar eval",
	view: "Ver",
	approve: "Aprovar",
	reject: "Rejeitar",
	pending: "pendentes",
	approved: "aprovadas",
	rejected: "rejeitadas",
	items: "consultas",
	generating: "gerando",
	doctor: "Médico",
	voices: "vozes",
	feedbackPlaceholder: "feedback (opcional)",
	run: "Run",
	samplesOf: "amostras",
	emptyCohorts: "Nenhuma coorte ainda — gere consultas na etapa 2 primeiro.",
	emptyItems: "Selecione uma coorte para revisar as consultas.",
	moreTurns: "turnos a mais",
	actionFailed: "Ação falhou — verifique suas permissões e tente novamente.",
	synthetic: "sintético",
	deleteRun: "Excluir run",
	confirmDelete: "Confirmar exclusão",
	stageCleanup: "limpeza",
	stageAnamnesis: "anamnese",
	stageError: "erro no estágio",
	completeness: "completude",
	edits: "edições",
	noRunnerBound:
		"nenhum runner de eval vinculado — instale/configure os drivers locais de eval (EVAL_RUNNER_DIR + EVAL_ASR_BASE_URL) ou os runs ficam na fila",
	runnerInline: "runner vinculado, mas sem fila de jobs — os runs executam inline",
};

const es: EvalMessages = {
	...en,
	title: "Ejecutar eval",
	stepPersonas: "1 · Personas",
	stepGenerate: "2 · Generar consultas",
	stepRunEval: "3 · Ejecutar eval",
	noRunnerBound:
		"no hay runner de eval vinculado — instala/configura los drivers locales de eval (EVAL_RUNNER_DIR + EVAL_ASR_BASE_URL) o los runs quedan en cola",
	runnerInline: "runner vinculado pero sin cola de jobs — los runs se ejecutan en línea",
};

const CATALOGS: Record<EvalLocale, EvalMessages> = { en, "pt-BR": ptBR, es };

export const isEvalLocale = (locale: string): locale is EvalLocale =>
	(EVAL_LOCALES as readonly string[]).includes(locale);

export const evalMessages = (locale: string): EvalMessages =>
	CATALOGS[isEvalLocale(locale) ? locale : BASE_LOCALE];
