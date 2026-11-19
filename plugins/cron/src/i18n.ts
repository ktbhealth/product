import { paramMessage } from "@ktb/i18n";

/**
 * Cron plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale and the views resolve their strings here. A locale
 * catalog must implement `CronMessages` in full — a missing key is a
 * type error, not an English fallback at runtime.
 */
export const CRON_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "cron";

/** Locale→merged messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): Record<string, unknown> => ({
	...cronMessages(locale),
});

export type CronLocale = (typeof CRON_LOCALES)[number];
export const BASE_LOCALE: CronLocale = "en";

export interface CronMessages {
	readonly title: string;
	readonly description: (n: number) => string;
	readonly jobsTitle: string;
	readonly jobsDescription: string;
	readonly jColJob: string;
	readonly jColSchedules: string;
	readonly jColDescription: string;
	readonly jColLastRun: string;
	readonly jColAction: string;
	readonly neverRan: string;
	readonly lastOk: string;
	readonly lastFailed: string;
	readonly lastRunning: string;
	readonly runNow: string;
	readonly running: string;
	readonly runOk: (summary: string) => string;
	readonly runOkNoSummary: string;
	readonly runUnknown: string;
	readonly runUnavailable: string;
	readonly runForbidden: string;
	readonly runFailed: string;
	readonly emptyJobsTitle: string;
	readonly emptyJobsDescription: string;
	readonly unavailableTitle: string;
	readonly unavailableDescription: string;
	readonly runsTitle: string;
	readonly runsDescription: string;
	readonly rColId: string;
	readonly rColJob: string;
	readonly rColStatus: string;
	readonly rColError: string;
	readonly rColStarted: string;
	readonly emptyRunsTitle: string;
	readonly emptyRunsDescription: string;
}

const en: CronMessages = {
	title: "Cronjobs",
	description: paramMessage(
		"en",
		"{n, plural, =1{{n} scheduled job registered.} other{{n} scheduled jobs registered.}}",
		["n"],
	),
	jobsTitle: "Scheduled jobs",
	jobsDescription:
		"Every cron job the deployment registers, with its triggers and latest recorded run.",
	jColJob: "Job",
	jColSchedules: "Schedules",
	jColDescription: "Description",
	jColLastRun: "Last run",
	jColAction: "Action",
	neverRan: "Never run",
	lastOk: "OK",
	lastFailed: "Failed",
	lastRunning: "Running",
	runNow: "Run now",
	running: "Running…",
	runOk: paramMessage("en", "Run finished — {summary}", ["summary"]),
	runOkNoSummary: "Run finished.",
	runUnknown: "Unknown job id.",
	runUnavailable: "Cron runner unavailable in this environment.",
	runForbidden: "Not permitted.",
	runFailed: "Run failed.",
	emptyJobsTitle: "No cron jobs registered",
	emptyJobsDescription: "This deployment has no scheduled jobs configured.",
	unavailableTitle: "Signal unavailable",
	unavailableDescription: "This signal cannot be read in the current environment.",
	runsTitle: "Run history",
	runsDescription: "Latest cron.* job_runs projection rows, newest first.",
	rColId: "Run",
	rColJob: "Job",
	rColStatus: "Status",
	rColError: "Error",
	rColStarted: "Started",
	emptyRunsTitle: "No cron runs recorded",
	emptyRunsDescription: "Scheduled fires and manual runs will appear here once recorded.",
};

const ptBR: CronMessages = {
	title: "Tarefas agendadas",
	description: paramMessage(
		"pt-BR",
		"{n, plural, =1{{n} tarefa agendada registrada.} other{{n} tarefas agendadas registradas.}}",
		["n"],
	),
	jobsTitle: "Tarefas agendadas",
	jobsDescription:
		"Todas as tarefas cron registradas nesta implantação, com gatilhos e última execução.",
	jColJob: "Tarefa",
	jColSchedules: "Agendamentos",
	jColDescription: "Descrição",
	jColLastRun: "Última execução",
	jColAction: "Ação",
	neverRan: "Nunca executada",
	lastOk: "OK",
	lastFailed: "Falhou",
	lastRunning: "Executando",
	runNow: "Executar agora",
	running: "Executando…",
	runOk: paramMessage("pt-BR", "Execução concluída — {summary}", ["summary"]),
	runOkNoSummary: "Execução concluída.",
	runUnknown: "Id de tarefa desconhecido.",
	runUnavailable: "Executor de tarefas indisponível neste ambiente.",
	runForbidden: "Não permitido.",
	runFailed: "A execução falhou.",
	emptyJobsTitle: "Nenhuma tarefa agendada registrada",
	emptyJobsDescription: "Esta implantação não tem tarefas agendadas configuradas.",
	unavailableTitle: "Sinal indisponível",
	unavailableDescription: "Este sinal não pode ser lido no ambiente atual.",
	runsTitle: "Histórico de execuções",
	runsDescription: "Últimas linhas da projeção job_runs (cron.*), mais recentes primeiro.",
	rColId: "Execução",
	rColJob: "Tarefa",
	rColStatus: "Status",
	rColError: "Erro",
	rColStarted: "Iniciada em",
	emptyRunsTitle: "Nenhuma execução cron registrada",
	emptyRunsDescription: "Disparos agendados e execuções manuais aparecerão aqui quando gravados.",
};

const es: CronMessages = {
	title: "Tareas programadas",
	description: paramMessage(
		"es",
		"{n, plural, =1{{n} tarea programada registrada.} other{{n} tareas programadas registradas.}}",
		["n"],
	),
	jobsTitle: "Tareas programadas",
	jobsDescription:
		"Todas las tareas cron registradas en este despliegue, con disparadores y última ejecución.",
	jColJob: "Tarea",
	jColSchedules: "Programaciones",
	jColDescription: "Descripción",
	jColLastRun: "Última ejecución",
	jColAction: "Acción",
	neverRan: "Nunca ejecutada",
	lastOk: "OK",
	lastFailed: "Falló",
	lastRunning: "Ejecutando",
	runNow: "Ejecutar ahora",
	running: "Ejecutando…",
	runOk: paramMessage("es", "Ejecución finalizada — {summary}", ["summary"]),
	runOkNoSummary: "Ejecución finalizada.",
	runUnknown: "Id de tarea desconocido.",
	runUnavailable: "Ejecutor de tareas no disponible en este entorno.",
	runForbidden: "No permitido.",
	runFailed: "La ejecución falló.",
	emptyJobsTitle: "Ninguna tarea programada registrada",
	emptyJobsDescription: "Este despliegue no tiene tareas programadas configuradas.",
	unavailableTitle: "Señal no disponible",
	unavailableDescription: "Esta señal no se puede leer en el entorno actual.",
	runsTitle: "Historial de ejecuciones",
	runsDescription: "Últimas filas de la proyección job_runs (cron.*), más recientes primero.",
	rColId: "Ejecución",
	rColJob: "Tarea",
	rColStatus: "Estado",
	rColError: "Error",
	rColStarted: "Iniciada",
	emptyRunsTitle: "Ninguna ejecución cron registrada",
	emptyRunsDescription:
		"Los disparos programados y ejecuciones manuales aparecerán aquí al registrarse.",
};

const CATALOGS: Record<CronLocale, CronMessages> = { en, "pt-BR": ptBR, es };

export const isCronLocale = (locale: string): locale is CronLocale =>
	(CRON_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const cronMessages = (locale: string): CronMessages =>
	CATALOGS[isCronLocale(locale) ? locale : BASE_LOCALE];
