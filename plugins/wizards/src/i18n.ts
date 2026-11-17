import { paramMessage } from "@ktb/i18n";

/**
 * Wizards plugin copy, one typed catalog per locale — same contract as
 * plugins/forms/src/i18n.ts: plugins cannot import the host's
 * Paraglide output, so surfaces resolve strings here from the active
 * locale (PageContext.locale / panel ctx). A locale catalog must
 * implement `WizardMessages` in full.
 */

export const WIZARDS_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "wizards";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): WizardMessages => wizardsMessages(locale);
export type WizardsLocale = (typeof WIZARDS_LOCALES)[number];
const BASE_LOCALE: WizardsLocale = "en";

export interface WizardMessages {
	// ---- runner (/wizards/<id>) ----
	/** Empty-state copy when no definition matches the URL id. */
	readonly notFoundTitle: string;
	readonly notFoundDescription: string;
	/** Shown while the run is being created/fetched. */
	readonly loading: string;
	/** Generic failure starting/advancing a run — param is optional detail. */
	readonly runError: string;
	/** Progress line — params are 1-based current and total step counts. */
	readonly stepProgress: (current: number, total: number) => string;
	/** Navigation buttons. */
	readonly back: string;
	readonly continueLabel: string;
	readonly submit: string;
	readonly abandon: string;
	/** Terminal states. */
	readonly completedTitle: string;
	readonly completedDescription: string;
	readonly abandonedTitle: string;
	readonly abandonedDescription: string;
	// ---- admin console (/platform/wizards) ----
	readonly adminTitle: string;
	readonly adminDescription: string;
	readonly defsHeading: string;
	readonly codeDefsHeading: string;
	readonly codeDefsHint: string;
	readonly emptyDefs: string;
	readonly fieldKey: string;
	readonly fieldTitle: string;
	readonly fieldDescription: string;
	readonly fieldDefinition: string;
	readonly fieldPublished: string;
	readonly save: string;
	readonly deleteLabel: string;
	readonly newDef: string;
	readonly editDef: string;
	readonly confirmDelete: string;
	readonly invalidJson: string;
	readonly saveFailed: string;
	readonly cancel: string;
	readonly saved: string;
	readonly deleted: string;
	readonly unpublishedBadge: string;
	readonly publishedBadge: string;
}

const en: WizardMessages = {
	notFoundTitle: "Wizard not found",
	notFoundDescription: "No wizard is published at this address.",
	loading: "Loading…",
	runError: "Something went wrong while running this wizard. Please try again.",
	stepProgress: paramMessage("en", "Step {current} of {total}", ["current", "total"]),
	back: "Back",
	continueLabel: "Continue",
	submit: "Submit",
	abandon: "Abandon wizard",
	completedTitle: "Wizard complete",
	completedDescription: "Your answers were recorded. You can close this page.",
	abandonedTitle: "Wizard abandoned",
	abandonedDescription: "This wizard run was cancelled.",
	adminTitle: "Wizards",
	adminDescription:
		"Author and publish wizard definitions. Plugins can also contribute wizards in code.",
	defsHeading: "Database definitions",
	codeDefsHeading: "Plugin-contributed definitions",
	codeDefsHint: "Read-only — contributed via wizard.def manifest entries.",
	emptyDefs: "No wizard definitions yet.",
	fieldKey: "Key",
	fieldTitle: "Title",
	fieldDescription: "Description",
	fieldDefinition: "Definition (JSON)",
	fieldPublished: "Published",
	save: "Save",
	deleteLabel: "Delete",
	newDef: "New wizard",
	editDef: "Edit",
	confirmDelete: "Delete this wizard definition?",
	invalidJson: "Definition is not valid JSON.",
	saveFailed: "The wizard definition could not be saved.",
	cancel: "Cancel",
	saved: "Saved.",
	deleted: "Deleted.",
	unpublishedBadge: "Draft",
	publishedBadge: "Published",
};

const ptBR: WizardMessages = {
	notFoundTitle: "Assistente não encontrado",
	notFoundDescription: "Nenhum assistente está publicado neste endereço.",
	loading: "Carregando…",
	runError: "Algo deu errado ao executar este assistente. Tente novamente.",
	stepProgress: paramMessage("pt-BR", "Etapa {current} de {total}", ["current", "total"]),
	back: "Voltar",
	continueLabel: "Continuar",
	submit: "Enviar",
	abandon: "Abandonar assistente",
	completedTitle: "Assistente concluído",
	completedDescription: "Suas respostas foram registradas. Você pode fechar esta página.",
	abandonedTitle: "Assistente abandonado",
	abandonedDescription: "Esta execução do assistente foi cancelada.",
	adminTitle: "Assistentes",
	adminDescription:
		"Crie e publique definições de assistentes. Plugins também podem contribuir assistentes em código.",
	defsHeading: "Definições do banco de dados",
	codeDefsHeading: "Definições contribuídas por plugins",
	codeDefsHint: "Somente leitura — contribuídas via entradas wizard.def do manifesto.",
	emptyDefs: "Nenhuma definição de assistente ainda.",
	fieldKey: "Chave",
	fieldTitle: "Título",
	fieldDescription: "Descrição",
	fieldDefinition: "Definição (JSON)",
	fieldPublished: "Publicado",
	save: "Salvar",
	deleteLabel: "Excluir",
	newDef: "Novo assistente",
	editDef: "Editar",
	confirmDelete: "Excluir esta definição de assistente?",
	invalidJson: "A definição não é um JSON válido.",
	saveFailed: "Não foi possível salvar a definição do assistente.",
	cancel: "Cancelar",
	saved: "Salvo.",
	deleted: "Excluído.",
	unpublishedBadge: "Rascunho",
	publishedBadge: "Publicado",
};

const es: WizardMessages = {
	notFoundTitle: "Asistente no encontrado",
	notFoundDescription: "No hay ningún asistente publicado en esta dirección.",
	loading: "Cargando…",
	runError: "Algo salió mal al ejecutar este asistente. Inténtalo de nuevo.",
	stepProgress: paramMessage("es", "Paso {current} de {total}", ["current", "total"]),
	back: "Atrás",
	continueLabel: "Continuar",
	submit: "Enviar",
	abandon: "Abandonar asistente",
	completedTitle: "Asistente completado",
	completedDescription: "Tus respuestas fueron registradas. Puedes cerrar esta página.",
	abandonedTitle: "Asistente abandonado",
	abandonedDescription: "Esta ejecución del asistente fue cancelada.",
	adminTitle: "Asistentes",
	adminDescription:
		"Crea y publica definiciones de asistentes. Los plugins también pueden contribuir asistentes en código.",
	defsHeading: "Definiciones de base de datos",
	codeDefsHeading: "Definiciones contribuídas por plugins",
	codeDefsHint: "Solo lectura — contribuídas vía entradas wizard.def del manifiesto.",
	emptyDefs: "Aún no hay definiciones de asistentes.",
	fieldKey: "Clave",
	fieldTitle: "Título",
	fieldDescription: "Descripción",
	fieldDefinition: "Definición (JSON)",
	fieldPublished: "Publicado",
	save: "Guardar",
	deleteLabel: "Eliminar",
	newDef: "Nuevo asistente",
	editDef: "Editar",
	confirmDelete: "¿Eliminar esta definición de asistente?",
	invalidJson: "La definición no es un JSON válido.",
	saveFailed: "No se pudo guardar la definición del asistente.",
	cancel: "Cancelar",
	saved: "Guardado.",
	deleted: "Eliminado.",
	unpublishedBadge: "Borrador",
	publishedBadge: "Publicado",
};

const CATALOGS: Record<WizardsLocale, WizardMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isWizardsLocale = (locale: string): locale is WizardsLocale =>
	(WIZARDS_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const wizardsMessages = (locale: string | undefined): WizardMessages =>
	CATALOGS[isWizardsLocale(locale ?? "") ? (locale as WizardsLocale) : BASE_LOCALE];
