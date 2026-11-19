import { paramMessage } from "@ktb/i18n";

/**
 * Queue plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale and the views resolve their strings here. A locale
 * catalog must implement `QueueMessages` in full — a missing key is a
 * type error, not an English fallback at runtime.
 */
export const QUEUE_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "queue";

/** Locale→merged messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): Record<string, unknown> => ({
	...queueMessages(locale),
});

export type QueueLocale = (typeof QUEUE_LOCALES)[number];
export const BASE_LOCALE: QueueLocale = "en";

export interface QueueMessages {
	readonly title: string;
	readonly description: (n: number) => string;
	readonly queuesTitle: string;
	readonly queuesDescription: string;
	readonly qColQueue: string;
	readonly qColTransport: string;
	readonly qColConsumer: string;
	readonly qColPending: string;
	readonly qColProcessing: string;
	readonly qColDone: string;
	readonly qColFailed: string;
	readonly transportCloudflare: string;
	readonly transportRedis: string;
	readonly transportSqlite: string;
	readonly transportUnknown: string;
	readonly consumerInApp: string;
	readonly consumerJobsWorker: string;
	readonly consumerExternal: string;
	readonly consumerNone: string;
	readonly emptyQueuesTitle: string;
	readonly emptyQueuesDescription: string;
	readonly unavailableTitle: string;
	readonly unavailableDescription: string;
	readonly runsTitle: string;
	readonly runsDescription: string;
	readonly rColId: string;
	readonly rColKind: string;
	readonly rColStatus: string;
	readonly rColError: string;
	readonly rColCreated: string;
	readonly rColPayloadRef: string;
	readonly filterKind: string;
	readonly filterStatus: string;
	readonly kindAll: string;
	readonly statusAll: string;
	readonly statusQueued: string;
	readonly statusProcessing: string;
	readonly statusDone: string;
	readonly statusFailed: string;
	readonly emptyRunsTitle: string;
	readonly emptyRunsDescription: string;
	readonly noMatch: string;
	readonly enqueueTitle: string;
	readonly enqueueDescription: string;
	readonly enqueueKind: string;
	readonly selectKind: string;
	readonly payloadLabel: string;
	readonly payloadPlaceholder: string;
	readonly payloadHint: string;
	readonly enqueueSubmit: string;
	readonly enqueueSuccess: string;
	readonly enqueueError: string;
	readonly payloadInvalid: string;
	readonly noKinds: string;
}

const en: QueueMessages = {
	title: "Queue",
	description: paramMessage(
		"en",
		"{n, plural, =1{{n} job run tracked.} other{{n} job runs tracked.}}",
		["n"],
	),
	queuesTitle: "Bound queues",
	queuesDescription: "Every queue transport this deployment binds, with best-effort depth.",
	qColQueue: "Queue",
	qColTransport: "Transport",
	qColConsumer: "Consumer",
	qColPending: "Pending",
	qColProcessing: "Processing",
	qColDone: "Done",
	qColFailed: "Failed",
	transportCloudflare: "Cloudflare Queue",
	transportRedis: "Redis",
	transportSqlite: "SQLite (dev)",
	transportUnknown: "Unknown",
	consumerInApp: "In-app worker",
	consumerJobsWorker: "Jobs worker",
	consumerExternal: "External",
	consumerNone: "None",
	emptyQueuesTitle: "No queues bound",
	emptyQueuesDescription: "This deployment has no queue transports configured.",
	unavailableTitle: "Signal unavailable",
	unavailableDescription: "This signal cannot be read in the current environment.",
	runsTitle: "Job runs",
	runsDescription: "Latest job_runs projection rows across all transports.",
	rColId: "Run",
	rColKind: "Kind",
	rColStatus: "Status",
	rColError: "Error",
	rColCreated: "Created",
	rColPayloadRef: "Payload ref",
	filterKind: "Filter by kind",
	filterStatus: "Filter by status",
	kindAll: "All kinds",
	statusAll: "All statuses",
	statusQueued: "Queued",
	statusProcessing: "Processing",
	statusDone: "Done",
	statusFailed: "Failed",
	emptyRunsTitle: "No job runs",
	emptyRunsDescription: "Enqueued jobs will appear here once the projection records them.",
	noMatch: "No runs match the filters.",
	enqueueTitle: "Enqueue test job",
	enqueueDescription: "Send a job envelope through the bound Jobs port — lands in job_runs.",
	enqueueKind: "Job kind",
	selectKind: "Select a kind",
	payloadLabel: "Payload (JSON, optional)",
	payloadPlaceholder: '{"key": "value"}',
	payloadHint: "Must be valid JSON; defaults to {} when empty.",
	enqueueSubmit: "Enqueue",
	enqueueSuccess: "Job enqueued.",
	enqueueError: "Enqueue failed — the job could not be sent.",
	payloadInvalid: "Payload is not valid JSON.",
	noKinds: "No job kinds registered.",
};

const ptBR: QueueMessages = {
	title: "Fila",
	description: paramMessage(
		"pt-BR",
		"{n, plural, =1{{n} execução de tarefa registrada.} other{{n} execuções de tarefa registradas.}}",
		["n"],
	),
	queuesTitle: "Filas vinculadas",
	queuesDescription: "Todos os transportes de fila desta implantação, com profundidade aproximada.",
	qColQueue: "Fila",
	qColTransport: "Transporte",
	qColConsumer: "Consumidor",
	qColPending: "Pendentes",
	qColProcessing: "Processando",
	qColDone: "Concluídas",
	qColFailed: "Falhas",
	transportCloudflare: "Cloudflare Queue",
	transportRedis: "Redis",
	transportSqlite: "SQLite (dev)",
	transportUnknown: "Desconhecido",
	consumerInApp: "Worker interno",
	consumerJobsWorker: "Worker de tarefas",
	consumerExternal: "Externo",
	consumerNone: "Nenhum",
	emptyQueuesTitle: "Nenhuma fila vinculada",
	emptyQueuesDescription: "Esta implantação não tem transportes de fila configurados.",
	unavailableTitle: "Sinal indisponível",
	unavailableDescription: "Este sinal não pode ser lido no ambiente atual.",
	runsTitle: "Execuções de tarefas",
	runsDescription: "Últimas linhas da projeção job_runs em todos os transportes.",
	rColId: "Execução",
	rColKind: "Tipo",
	rColStatus: "Status",
	rColError: "Erro",
	rColCreated: "Criada em",
	rColPayloadRef: "Ref. do payload",
	filterKind: "Filtrar por tipo",
	filterStatus: "Filtrar por status",
	kindAll: "Todos os tipos",
	statusAll: "Todos os status",
	statusQueued: "Na fila",
	statusProcessing: "Processando",
	statusDone: "Concluído",
	statusFailed: "Falhou",
	emptyRunsTitle: "Nenhuma execução de tarefa",
	emptyRunsDescription: "Tarefas enfileiradas aparecerão aqui quando a projeção as registrar.",
	noMatch: "Nenhuma execução corresponde aos filtros.",
	enqueueTitle: "Enfileirar tarefa de teste",
	enqueueDescription:
		"Enviar um envelope de tarefa pela porta Jobs vinculada — registrado em job_runs.",
	enqueueKind: "Tipo de tarefa",
	selectKind: "Selecione um tipo",
	payloadLabel: "Payload (JSON, opcional)",
	payloadPlaceholder: '{"key": "value"}',
	payloadHint: "Deve ser JSON válido; assume {} quando vazio.",
	enqueueSubmit: "Enfileirar",
	enqueueSuccess: "Tarefa enfileirada.",
	enqueueError: "Falha ao enfileirar — a tarefa não pôde ser enviada.",
	payloadInvalid: "O payload não é JSON válido.",
	noKinds: "Nenhum tipo de tarefa registrado.",
};

const es: QueueMessages = {
	title: "Cola",
	description: paramMessage(
		"es",
		"{n, plural, =1{{n} ejecución de tarea registrada.} other{{n} ejecuciones de tarea registradas.}}",
		["n"],
	),
	queuesTitle: "Colas vinculadas",
	queuesDescription:
		"Todos los transportes de cola de este despliegue, con profundidad aproximada.",
	qColQueue: "Cola",
	qColTransport: "Transporte",
	qColConsumer: "Consumidor",
	qColPending: "Pendientes",
	qColProcessing: "Procesando",
	qColDone: "Completadas",
	qColFailed: "Fallidas",
	transportCloudflare: "Cloudflare Queue",
	transportRedis: "Redis",
	transportSqlite: "SQLite (dev)",
	transportUnknown: "Desconocido",
	consumerInApp: "Worker interno",
	consumerJobsWorker: "Worker de tareas",
	consumerExternal: "Externo",
	consumerNone: "Ninguno",
	emptyQueuesTitle: "Ninguna cola vinculada",
	emptyQueuesDescription: "Este despliegue no tiene transportes de cola configurados.",
	unavailableTitle: "Señal no disponible",
	unavailableDescription: "Esta señal no se puede leer en el entorno actual.",
	runsTitle: "Ejecuciones de tareas",
	runsDescription: "Últimas filas de la proyección job_runs en todos los transportes.",
	rColId: "Ejecución",
	rColKind: "Tipo",
	rColStatus: "Estado",
	rColError: "Error",
	rColCreated: "Creada",
	rColPayloadRef: "Ref. del payload",
	filterKind: "Filtrar por tipo",
	filterStatus: "Filtrar por estado",
	kindAll: "Todos los tipos",
	statusAll: "Todos los estados",
	statusQueued: "En cola",
	statusProcessing: "Procesando",
	statusDone: "Completado",
	statusFailed: "Falló",
	emptyRunsTitle: "Ninguna ejecución de tarea",
	emptyRunsDescription: "Las tareas encoladas aparecerán aquí cuando la proyección las registre.",
	noMatch: "Ninguna ejecución coincide con los filtros.",
	enqueueTitle: "Encolar tarea de prueba",
	enqueueDescription:
		"Enviar un envelope de tarea por el puerto Jobs vinculado — queda en job_runs.",
	enqueueKind: "Tipo de tarea",
	selectKind: "Selecciona un tipo",
	payloadLabel: "Payload (JSON, opcional)",
	payloadPlaceholder: '{"key": "value"}',
	payloadHint: "Debe ser JSON válido; usa {} cuando está vacío.",
	enqueueSubmit: "Encolar",
	enqueueSuccess: "Tarea encolada.",
	enqueueError: "Error al encolar — la tarea no se pudo enviar.",
	payloadInvalid: "El payload no es JSON válido.",
	noKinds: "Ningún tipo de tarea registrado.",
};

const CATALOGS: Record<QueueLocale, QueueMessages> = { en, "pt-BR": ptBR, es };

export const isQueueLocale = (locale: string): locale is QueueLocale =>
	(QUEUE_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const queueMessages = (locale: string): QueueMessages =>
	CATALOGS[isQueueLocale(locale) ? locale : BASE_LOCALE];
