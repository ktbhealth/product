/**
 * Templates plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the page/chrome ctx and the view resolves its
 * strings here. A locale catalog must implement `TemplatesMessages` in
 * full — a missing key is a type error, not an English fallback.
 */

import { paramMessage } from "@ktb/i18n";

export const TEMPLATES_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "templates";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): TemplatesMessages => templatesMessages(locale);
export type TemplatesLocale = (typeof TEMPLATES_LOCALES)[number];
const BASE_LOCALE: TemplatesLocale = "en";

export interface TemplatesMessages {
	readonly title: string;
	readonly description: string;
	readonly newTemplate: string;
	readonly edit: string;
	readonly delete: string;
	readonly save: string;
	readonly cancel: string;
	readonly create: string;
	readonly saving: string;
	readonly saved: string;
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	readonly noKinds: string;
	readonly colName: string;
	readonly colDescription: string;
	readonly colCreatedBy: string;
	readonly colUpdated: string;
	readonly colActions: string;
	readonly fieldKind: string;
	readonly fieldName: string;
	readonly namePlaceholder: string;
	readonly fieldDescription: string;
	readonly fieldPayload: string;
	readonly payloadHint: string;
	readonly invalidJson: string;
	readonly deleteTitle: string;
	readonly deleteBody: (name: string) => string;
	readonly deleteConfirm: string;
	readonly deleted: string;
	readonly deleteFailed: string;
	readonly loadFailed: string;
	readonly saveFailed: string;
	// Save-as-template dialog (shared by every templatable surface).
	readonly saveAsTitle: string;
	readonly saveAsBody: (name: string) => string;
	readonly saveAsPrompt: string;
}

const en: TemplatesMessages = {
	title: "Templates",
	description: "Saved snapshots that admin surfaces can reuse.",
	newTemplate: "New template",
	edit: "Edit",
	delete: "Delete",
	save: "Save",
	cancel: "Cancel",
	create: "Create",
	saving: "Saving…",
	saved: "Saved",
	emptyTitle: "No templates yet",
	emptyDescription: "Save a template from a supported surface to reuse it here.",
	noKinds: "No template kinds are registered yet.",
	colName: "Name",
	colDescription: "Description",
	colCreatedBy: "Created by",
	colUpdated: "Updated",
	colActions: "Actions",
	fieldKind: "Kind",
	fieldName: "Name",
	namePlaceholder: "e.g. landing-hero",
	fieldDescription: "Description",
	fieldPayload: "Payload (JSON)",
	payloadHint: "Kind-specific JSON snapshot. Validated against the kind on save.",
	invalidJson: "Payload is not valid JSON.",
	deleteTitle: "Delete template",
	deleteBody: paramMessage("en", 'Delete "{name}"? This cannot be undone.', ["name"]),
	deleteConfirm: "Delete",
	deleted: "Template deleted",
	deleteFailed: "Could not delete the template.",
	loadFailed: "Could not load the template.",
	saveFailed: "Could not save the template.",
	saveAsTitle: "Save as template",
	saveAsBody: paramMessage("en", 'Save "{name}" as a reusable template.', ["name"]),
	saveAsPrompt: "Save options",
};

const ptBR: TemplatesMessages = {
	title: "Modelos",
	description: "Snapshots salvos que superfícies de administração podem reutilizar.",
	newTemplate: "Novo modelo",
	edit: "Editar",
	delete: "Excluir",
	save: "Salvar",
	cancel: "Cancelar",
	create: "Criar",
	saving: "Salvando…",
	saved: "Salvo",
	emptyTitle: "Nenhum modelo ainda",
	emptyDescription: "Salve um modelo a partir de uma superfície compatível para reutilizá-lo aqui.",
	noKinds: "Nenhum tipo de modelo está registrado ainda.",
	colName: "Nome",
	colDescription: "Descrição",
	colCreatedBy: "Criado por",
	colUpdated: "Atualizado",
	colActions: "Ações",
	fieldKind: "Tipo",
	fieldName: "Nome",
	namePlaceholder: "ex.: landing-hero",
	fieldDescription: "Descrição",
	fieldPayload: "Payload (JSON)",
	payloadHint: "Snapshot JSON específico do tipo. Validado contra o tipo ao salvar.",
	invalidJson: "O payload não é um JSON válido.",
	deleteTitle: "Excluir modelo",
	deleteBody: paramMessage("pt-BR", 'Excluir "{name}"? Esta ação não pode ser desfeita.', ["name"]),
	deleteConfirm: "Excluir",
	deleted: "Modelo excluído",
	deleteFailed: "Não foi possível excluir o modelo.",
	loadFailed: "Não foi possível carregar o modelo.",
	saveFailed: "Não foi possível salvar o modelo.",
	saveAsTitle: "Salvar como modelo",
	saveAsBody: paramMessage("pt-BR", 'Salvar "{name}" como um modelo reutilizável.', ["name"]),
	saveAsPrompt: "Opções de salvamento",
};

const es: TemplatesMessages = {
	title: "Plantillas",
	description: "Instantáneas guardadas que las superficies de administración pueden reutilizar.",
	newTemplate: "Nueva plantilla",
	edit: "Editar",
	delete: "Eliminar",
	save: "Guardar",
	cancel: "Cancelar",
	create: "Crear",
	saving: "Guardando…",
	saved: "Guardado",
	emptyTitle: "Aún no hay plantillas",
	emptyDescription: "Guarda una plantilla desde una superficie compatible para reutilizarla aquí.",
	noKinds: "Aún no hay tipos de plantilla registrados.",
	colName: "Nombre",
	colDescription: "Descripción",
	colCreatedBy: "Creada por",
	colUpdated: "Actualizado",
	colActions: "Acciones",
	fieldKind: "Tipo",
	fieldName: "Nombre",
	namePlaceholder: "p. ej. landing-hero",
	fieldDescription: "Descripción",
	fieldPayload: "Payload (JSON)",
	payloadHint: "Instantánea JSON específica del tipo. Validada contra el tipo al guardar.",
	invalidJson: "El payload no es un JSON válido.",
	deleteTitle: "Eliminar plantilla",
	deleteBody: paramMessage("es", '¿Eliminar "{name}"? Esta acción no se puede deshacer.', ["name"]),
	deleteConfirm: "Eliminar",
	deleted: "Plantilla eliminada",
	deleteFailed: "No se pudo eliminar la plantilla.",
	loadFailed: "No se pudo cargar la plantilla.",
	saveFailed: "No se pudo guardar la plantilla.",
	saveAsTitle: "Guardar como plantilla",
	saveAsBody: paramMessage("es", 'Guardar "{name}" como una plantilla reutilizable.', ["name"]),
	saveAsPrompt: "Opciones de guardado",
};

const CATALOGS: Record<TemplatesLocale, TemplatesMessages> = { en, "pt-BR": ptBR, es };

export const isTemplatesLocale = (locale: string): locale is TemplatesLocale =>
	(TEMPLATES_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const templatesMessages = (locale: string | undefined): TemplatesMessages =>
	CATALOGS[isTemplatesLocale(locale ?? "") ? (locale as TemplatesLocale) : BASE_LOCALE];
