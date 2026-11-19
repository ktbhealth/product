/**
 * Schemas plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the page/chrome ctx and the view resolves its
 * strings here. A locale catalog must implement `SchemasMessages` in
 * full — a missing key is a type error, not an English fallback.
 */

import { paramMessage } from "@ktb/i18n";

export const SCHEMAS_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "schemas";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): SchemasMessages => schemasMessages(locale);
export type SchemasLocale = (typeof SCHEMAS_LOCALES)[number];
const BASE_LOCALE: SchemasLocale = "en";

export interface SchemasMessages {
	readonly title: string;
	readonly description: string;
	readonly newSchema: string;
	readonly edit: string;
	readonly delete: string;
	readonly save: string;
	readonly cancel: string;
	readonly create: string;
	readonly saving: string;
	readonly saved: string;
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	readonly colName: string;
	readonly colDescription: string;
	readonly colUpdated: string;
	readonly colActions: string;
	readonly fieldName: string;
	readonly namePlaceholder: string;
	readonly fieldDescription: string;
	readonly fieldSchema: string;
	readonly deleteTitle: string;
	readonly deleteBody: (name: string) => string;
	readonly deleteConfirm: string;
	readonly deleted: string;
	readonly deleteFailed: string;
	readonly loadFailed: string;
	readonly saveFailed: string;
	readonly validate: string;
	readonly validating: string;
	readonly validationValid: string;
	readonly validationFailed: string;
}

const en: SchemasMessages = {
	title: "Schemas",
	description: "Manage the JSON Schemas used to validate data.",
	newSchema: "New schema",
	edit: "Edit",
	delete: "Delete",
	save: "Save",
	cancel: "Cancel",
	create: "Create",
	saving: "Saving…",
	saved: "Saved",
	emptyTitle: "No schemas yet",
	emptyDescription: "Create your first JSON Schema.",
	colName: "Name",
	colDescription: "Description",
	colUpdated: "Updated",
	colActions: "Actions",
	fieldName: "Name",
	namePlaceholder: "e.g. page-search-params",
	fieldDescription: "Description",
	fieldSchema: "JSON Schema",
	deleteTitle: "Delete schema",
	deleteBody: paramMessage("en", 'Delete "{name}"? This cannot be undone.', ["name"]),
	deleteConfirm: "Delete",
	deleted: "Schema deleted",
	deleteFailed: "Could not delete the schema.",
	loadFailed: "Could not load the schema.",
	saveFailed: "Could not save the schema.",
	validate: "Validate",
	validating: "Validating…",
	validationValid: "Valid",
	validationFailed: "Invalid",
};

const ptBR: SchemasMessages = {
	title: "Esquemas",
	description: "Gerencie os JSON Schemas usados para validar dados.",
	newSchema: "Novo esquema",
	edit: "Editar",
	delete: "Excluir",
	save: "Salvar",
	cancel: "Cancelar",
	create: "Criar",
	saving: "Salvando…",
	saved: "Salvo",
	emptyTitle: "Nenhum esquema ainda",
	emptyDescription: "Crie seu primeiro JSON Schema.",
	colName: "Nome",
	colDescription: "Descrição",
	colUpdated: "Atualizado",
	colActions: "Ações",
	fieldName: "Nome",
	namePlaceholder: "ex.: page-search-params",
	fieldDescription: "Descrição",
	fieldSchema: "JSON Schema",
	deleteTitle: "Excluir esquema",
	deleteBody: paramMessage("pt-BR", 'Excluir "{name}"? Esta ação não pode ser desfeita.', ["name"]),
	deleteConfirm: "Excluir",
	deleted: "Esquema excluído",
	deleteFailed: "Não foi possível excluir o esquema.",
	loadFailed: "Não foi possível carregar o esquema.",
	saveFailed: "Não foi possível salvar o esquema.",
	validate: "Validar",
	validating: "Validando…",
	validationValid: "Válido",
	validationFailed: "Inválido",
};

const es: SchemasMessages = {
	title: "Esquemas",
	description: "Gestiona los JSON Schemas usados para validar datos.",
	newSchema: "Nuevo esquema",
	edit: "Editar",
	delete: "Eliminar",
	save: "Guardar",
	cancel: "Cancelar",
	create: "Crear",
	saving: "Guardando…",
	saved: "Guardado",
	emptyTitle: "Aún no hay esquemas",
	emptyDescription: "Crea tu primer JSON Schema.",
	colName: "Nombre",
	colDescription: "Descripción",
	colUpdated: "Actualizado",
	colActions: "Acciones",
	fieldName: "Nombre",
	namePlaceholder: "p. ej. page-search-params",
	fieldDescription: "Descripción",
	fieldSchema: "JSON Schema",
	deleteTitle: "Eliminar esquema",
	deleteBody: paramMessage("es", '¿Eliminar "{name}"? Esta acción no se puede deshacer.', ["name"]),
	deleteConfirm: "Eliminar",
	deleted: "Esquema eliminado",
	deleteFailed: "No se pudo eliminar el esquema.",
	loadFailed: "No se pudo cargar el esquema.",
	saveFailed: "No se pudo guardar el esquema.",
	validate: "Validar",
	validating: "Validando…",
	validationValid: "Válido",
	validationFailed: "Inválido",
};

const CATALOGS: Record<SchemasLocale, SchemasMessages> = { en, "pt-BR": ptBR, es };

export const isSchemasLocale = (locale: string): locale is SchemasLocale =>
	(SCHEMAS_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const schemasMessages = (locale: string | undefined): SchemasMessages =>
	CATALOGS[isSchemasLocale(locale ?? "") ? (locale as SchemasLocale) : BASE_LOCALE];
