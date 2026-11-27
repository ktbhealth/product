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
	readonly schedulesTab: string;
	readonly schedulesTitle: string;
	readonly schedulesDescription: string;
	readonly sColKind: string;
	readonly sColSchedule: string;
	readonly sColNextRun: string;
	readonly sColLastRun: string;
	readonly sColStatus: string;
	readonly sColAction: string;
	readonly eColName: string;
	readonly eColSource: string;
	readonly eColTriggers: string;
	readonly eColDescription: string;
	readonly sourceCron: string;
	readonly sourceRuntime: string;
	readonly statusActive: string;
	readonly statusPaused: string;
	readonly statusDone: string;
	readonly emptySchedulesTitle: string;
	readonly emptySchedulesDescription: string;
	readonly newScheduleTitle: string;
	readonly fKind: string;
	readonly fKindPlaceholder: string;
	readonly fModeRecurring: string;
	readonly fModeOnce: string;
	readonly fCronExpr: string;
	readonly fCronExprPlaceholder: string;
	readonly fRunAt: string;
	readonly fParams: string;
	readonly fParamsPlaceholder: string;
	readonly fCreate: string;
	readonly fCreating: string;
	readonly actPause: string;
	readonly actResume: string;
	readonly actDelete: string;
	readonly schedCreated: string;
	readonly schedUpdated: string;
	readonly schedDeleted: string;
	readonly schedFailed: string;
	readonly schedInvalid: string;
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
	schedulesTab: "Schedules",
	schedulesTitle: "Schedules",
	schedulesDescription:
		"Every scheduled thing this deployment knows — deploy-time cron jobs and runtime scheduled_jobs rows in one list.",
	sColKind: "Kind",
	sColSchedule: "Schedule",
	sColNextRun: "Next run",
	sColLastRun: "Last run",
	sColStatus: "Status",
	sColAction: "Action",
	eColName: "Name",
	eColSource: "Source",
	eColTriggers: "Triggers",
	eColDescription: "Description",
	sourceCron: "Deployed",
	sourceRuntime: "Runtime",
	statusActive: "Active",
	statusPaused: "Paused",
	statusDone: "Done",
	emptySchedulesTitle: "No schedules",
	emptySchedulesDescription:
		"Deploy-time cron jobs appear here automatically; create a runtime schedule below.",
	newScheduleTitle: "New schedule",
	fKind: "Job kind",
	fKindPlaceholder: "e.g. agenda.reminders",
	fModeRecurring: "Recurring (cron)",
	fModeOnce: "One-off (date & time)",
	fCronExpr: "Cron expression (UTC, 5 fields)",
	fCronExprPlaceholder: "*/15 * * * *",
	fRunAt: "Run at",
	fParams: "Params (JSON, optional)",
	fParamsPlaceholder: '{"key": "value"}',
	fCreate: "Create schedule",
	fCreating: "Creating…",
	actPause: "Pause",
	actResume: "Resume",
	actDelete: "Delete",
	schedCreated: "Schedule created.",
	schedUpdated: "Schedule updated.",
	schedDeleted: "Schedule deleted.",
	schedFailed: "Schedule operation failed.",
	schedInvalid: "Invalid schedule — check the kind and timing fields.",
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
	schedulesTab: "Agendamentos",
	schedulesTitle: "Agendamentos",
	schedulesDescription:
		"Tudo que está agendado nesta implantação — tarefas cron de deploy e linhas scheduled_jobs em tempo de execução em uma só lista.",
	sColKind: "Tipo",
	sColSchedule: "Agendamento",
	sColNextRun: "Próxima execução",
	sColLastRun: "Última execução",
	sColStatus: "Status",
	sColAction: "Ação",
	eColName: "Nome",
	eColSource: "Origem",
	eColTriggers: "Gatilhos",
	eColDescription: "Descrição",
	sourceCron: "Implantada",
	sourceRuntime: "Runtime",
	statusActive: "Ativa",
	statusPaused: "Pausada",
	statusDone: "Concluída",
	emptySchedulesTitle: "Nenhum agendamento",
	emptySchedulesDescription:
		"Tarefas cron de deploy aparecem aqui automaticamente; crie um agendamento em tempo de execução abaixo.",
	newScheduleTitle: "Novo agendamento",
	fKind: "Tipo de tarefa",
	fKindPlaceholder: "ex.: agenda.reminders",
	fModeRecurring: "Recorrente (cron)",
	fModeOnce: "Pontual (data e hora)",
	fCronExpr: "Expressão cron (UTC, 5 campos)",
	fCronExprPlaceholder: "*/15 * * * *",
	fRunAt: "Executar em",
	fParams: "Parâmetros (JSON, opcional)",
	fParamsPlaceholder: '{"chave": "valor"}',
	fCreate: "Criar agendamento",
	fCreating: "Criando…",
	actPause: "Pausar",
	actResume: "Retomar",
	actDelete: "Excluir",
	schedCreated: "Agendamento criado.",
	schedUpdated: "Agendamento atualizado.",
	schedDeleted: "Agendamento excluído.",
	schedFailed: "Operação de agendamento falhou.",
	schedInvalid: "Agendamento inválido — verifique tipo e horário.",
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
	schedulesTab: "Programaciones",
	schedulesTitle: "Programaciones",
	schedulesDescription:
		"Todo lo programado en este despliegue — tareas cron de despliegue y filas scheduled_jobs en tiempo de ejecución en una sola lista.",
	sColKind: "Tipo",
	sColSchedule: "Programación",
	sColNextRun: "Próxima ejecución",
	sColLastRun: "Última ejecución",
	sColStatus: "Estado",
	sColAction: "Acción",
	eColName: "Nombre",
	eColSource: "Origen",
	eColTriggers: "Disparadores",
	eColDescription: "Descripción",
	sourceCron: "Desplegada",
	sourceRuntime: "Runtime",
	statusActive: "Activa",
	statusPaused: "Pausada",
	statusDone: "Finalizada",
	emptySchedulesTitle: "Ninguna programación",
	emptySchedulesDescription:
		"Las tareas cron de despliegue aparecen aquí automáticamente; crea una programación en tiempo de ejecución abajo.",
	newScheduleTitle: "Nueva programación",
	fKind: "Tipo de tarea",
	fKindPlaceholder: "p. ej. agenda.reminders",
	fModeRecurring: "Recurrente (cron)",
	fModeOnce: "Puntual (fecha y hora)",
	fCronExpr: "Expresión cron (UTC, 5 campos)",
	fCronExprPlaceholder: "*/15 * * * *",
	fRunAt: "Ejecutar el",
	fParams: "Parámetros (JSON, opcional)",
	fParamsPlaceholder: '{"clave": "valor"}',
	fCreate: "Crear programación",
	fCreating: "Creando…",
	actPause: "Pausar",
	actResume: "Reanudar",
	actDelete: "Eliminar",
	schedCreated: "Programación creada.",
	schedUpdated: "Programación actualizada.",
	schedDeleted: "Programación eliminada.",
	schedFailed: "La operación de programación falló.",
	schedInvalid: "Programación inválida — revisa tipo y horario.",
};

const CATALOGS: Record<CronLocale, CronMessages> = { en, "pt-BR": ptBR, es };

export const isCronLocale = (locale: string): locale is CronLocale =>
	(CRON_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const cronMessages = (locale: string): CronMessages =>
	CATALOGS[isCronLocale(locale) ? locale : BASE_LOCALE];
