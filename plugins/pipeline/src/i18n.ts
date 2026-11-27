/**
 * Pipeline plugin copy, one typed catalog per locale — same convention
 * as the other plugin i18n modules: plugins cannot import the host's
 * Paraglide output, so the panel page ctx injects the active locale and
 * the view resolves strings here. A locale catalog must implement
 * `PipelineMessages` in full — a missing key is a type error, not an
 * English fallback at runtime.
 */

import { paramMessage } from "@ktb/i18n";

export const PIPELINE_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "pipeline";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): PipelineMessages => pipelineMessages(locale);
export type PipelineLocale = (typeof PIPELINE_LOCALES)[number];
export const BASE_LOCALE: PipelineLocale = "en";

export interface PipelineMessages {
	readonly title: string;
	readonly description: string;
	readonly newPipeline: string;
	readonly colId: string;
	readonly colVersion: string;
	readonly colDescription: string;
	readonly colNodes: string;
	readonly colUpdated: string;
	readonly empty: string;
	readonly backToList: string;
	readonly editorNewTitle: string;
	readonly editorEditTitle: (id: string) => string;
	readonly editorMissing: string;
	readonly defSection: string;
	readonly defId: string;
	readonly defVersion: string;
	readonly defDescription: string;
	readonly onNodeError: string;
	readonly onNodeErrorHalt: string;
	readonly onNodeErrorContinue: string;
	readonly paletteTitle: string;
	readonly paletteHint: string;
	readonly nodeSection: string;
	readonly selectNodeHint: string;
	readonly nodeId: string;
	readonly nodeKind: string;
	readonly nodeOn: string;
	readonly nodeEmits: string;
	readonly nodeParams: string;
	readonly nodeParamsJson: string;
	readonly nodeParamsInvalid: string;
	readonly applyParams: string;
	readonly deleteNode: string;
	readonly connectTitle: string;
	readonly connectEventType: string;
	readonly connectConfirm: string;
	readonly cancel: string;
	readonly save: string;
	readonly saved: string;
	readonly saveFailed: string;
	readonly kindAiTemplate: string;
	readonly kindAiModel: string;
	readonly kindAiEcho: string;
	readonly kindGatePath: string;
	readonly kindGateEquals: string;
	readonly kindGatePassEvent: string;
	readonly kindGateFailEvent: string;
	readonly kindEmitEvents: string;
	readonly kindsLoading: string;
}

const en: PipelineMessages = {
	title: "Pipelines",
	description:
		"Orchestration defs — event-driven node graphs stored in orchestration_defs. Edges are derived: a node fires on every event type it subscribes to that another node emits.",
	newPipeline: "New pipeline",
	colId: "Id",
	colVersion: "Version",
	colDescription: "Description",
	colNodes: "Nodes",
	colUpdated: "Updated",
	empty: "No orchestration defs stored yet.",
	backToList: "Back to pipelines",
	editorNewTitle: "New orchestration",
	editorEditTitle: paramMessage("en", "Orchestration {id}", ["id"]),
	editorMissing: "Orchestration not found.",
	defSection: "Definition",
	defId: "Id",
	defVersion: "Version",
	defDescription: "Description",
	onNodeError: "Node failure policy",
	onNodeErrorHalt: "Halt run",
	onNodeErrorContinue: "Continue run",
	paletteTitle: "Node kinds",
	paletteHint: "Click a kind to add a node to the canvas.",
	nodeSection: "Node",
	selectNodeHint: "Select a node to edit its configuration.",
	nodeId: "Node id",
	nodeKind: "Kind",
	nodeOn: "Subscribes to (on)",
	nodeEmits: "Emits",
	nodeParams: "Parameters",
	nodeParamsJson: "Raw JSON",
	nodeParamsInvalid: "Invalid JSON — fix it before saving.",
	applyParams: "Apply",
	deleteNode: "Delete node",
	connectTitle: "Connect nodes",
	connectEventType: "Event type",
	connectConfirm: "Connect",
	cancel: "Cancel",
	save: "Save",
	saved: "Saved.",
	saveFailed: "Could not save the orchestration.",
	kindAiTemplate: "Template",
	kindAiModel: "Model",
	kindAiEcho: "Echo payload",
	kindGatePath: "Condition path",
	kindGateEquals: "Equals (JSON)",
	kindGatePassEvent: "Pass event",
	kindGateFailEvent: "Fail event",
	kindEmitEvents: "Events (JSON array)",
	kindsLoading: "Loading kinds…",
};

const ptBR: PipelineMessages = {
	title: "Pipelines",
	description:
		"Defs de orquestração — grafos de nós orientados a eventos armazenados em orchestration_defs. As arestas são derivadas: um nó dispara para cada tipo de evento que assina e que outro nó emite.",
	newPipeline: "Nova pipeline",
	colId: "Id",
	colVersion: "Versão",
	colDescription: "Descrição",
	colNodes: "Nós",
	colUpdated: "Atualizado",
	empty: "Nenhuma def de orquestração armazenada ainda.",
	backToList: "Voltar para pipelines",
	editorNewTitle: "Nova orquestração",
	editorEditTitle: paramMessage("pt-BR", "Orquestração {id}", ["id"]),
	editorMissing: "Orquestração não encontrada.",
	defSection: "Definição",
	defId: "Id",
	defVersion: "Versão",
	defDescription: "Descrição",
	onNodeError: "Política de falha de nó",
	onNodeErrorHalt: "Interromper execução",
	onNodeErrorContinue: "Continuar execução",
	paletteTitle: "Tipos de nó",
	paletteHint: "Clique em um tipo para adicionar um nó ao canvas.",
	nodeSection: "Nó",
	selectNodeHint: "Selecione um nó para editar sua configuração.",
	nodeId: "Id do nó",
	nodeKind: "Tipo",
	nodeOn: "Assina (on)",
	nodeEmits: "Emite",
	nodeParams: "Parâmetros",
	nodeParamsJson: "JSON bruto",
	nodeParamsInvalid: "JSON inválido — corrija antes de salvar.",
	applyParams: "Aplicar",
	deleteNode: "Excluir nó",
	connectTitle: "Conectar nós",
	connectEventType: "Tipo de evento",
	connectConfirm: "Conectar",
	cancel: "Cancelar",
	save: "Salvar",
	saved: "Salvo.",
	saveFailed: "Não foi possível salvar a orquestração.",
	kindAiTemplate: "Template",
	kindAiModel: "Modelo",
	kindAiEcho: "Ecoar payload",
	kindGatePath: "Caminho da condição",
	kindGateEquals: "Igual a (JSON)",
	kindGatePassEvent: "Evento de sucesso",
	kindGateFailEvent: "Evento de falha",
	kindEmitEvents: "Eventos (array JSON)",
	kindsLoading: "Carregando tipos…",
};

const es: PipelineMessages = {
	title: "Pipelines",
	description:
		"Defs de orquestación — grafos de nodos orientados a eventos almacenados en orchestration_defs. Las aristas se derivan: un nodo se dispara por cada tipo de evento que suscribe y que otro nodo emite.",
	newPipeline: "Nueva pipeline",
	colId: "Id",
	colVersion: "Versión",
	colDescription: "Descripción",
	colNodes: "Nodos",
	colUpdated: "Actualizado",
	empty: "Aún no hay defs de orquestación almacenadas.",
	backToList: "Volver a pipelines",
	editorNewTitle: "Nueva orquestación",
	editorEditTitle: paramMessage("es", "Orquestación {id}", ["id"]),
	editorMissing: "Orquestación no encontrada.",
	defSection: "Definición",
	defId: "Id",
	defVersion: "Versión",
	defDescription: "Descripción",
	onNodeError: "Política de fallo de nodo",
	onNodeErrorHalt: "Detener ejecución",
	onNodeErrorContinue: "Continuar ejecución",
	paletteTitle: "Tipos de nodo",
	paletteHint: "Haz clic en un tipo para añadir un nodo al lienzo.",
	nodeSection: "Nodo",
	selectNodeHint: "Selecciona un nodo para editar su configuración.",
	nodeId: "Id del nodo",
	nodeKind: "Tipo",
	nodeOn: "Suscribe (on)",
	nodeEmits: "Emite",
	nodeParams: "Parámetros",
	nodeParamsJson: "JSON en bruto",
	nodeParamsInvalid: "JSON inválido — corrígelo antes de guardar.",
	applyParams: "Aplicar",
	deleteNode: "Eliminar nodo",
	connectTitle: "Conectar nodos",
	connectEventType: "Tipo de evento",
	connectConfirm: "Conectar",
	cancel: "Cancelar",
	save: "Guardar",
	saved: "Guardado.",
	saveFailed: "No se pudo guardar la orquestación.",
	kindAiTemplate: "Plantilla",
	kindAiModel: "Modelo",
	kindAiEcho: "Ecoar payload",
	kindGatePath: "Ruta de la condición",
	kindGateEquals: "Igual a (JSON)",
	kindGatePassEvent: "Evento de éxito",
	kindGateFailEvent: "Evento de fallo",
	kindEmitEvents: "Eventos (array JSON)",
	kindsLoading: "Cargando tipos…",
};

const catalogs: Record<PipelineLocale, PipelineMessages> = { en, "pt-BR": ptBR, es };

export const pipelineMessages = (locale?: string): PipelineMessages =>
	catalogs[(locale as PipelineLocale) ?? BASE_LOCALE] ?? catalogs[BASE_LOCALE];
