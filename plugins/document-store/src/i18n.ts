import { paramMessage } from "@ktb/i18n";

/**
 * Document-store plugin copy, one typed catalog per locale — same
 * contract as plugins/pages/src/i18n.ts: plugins cannot import the
 * host's Paraglide output, so the host injects the active locale
 * through the page ctx and views resolve strings here. A locale
 * catalog must implement `DocumentStoreMessages` in full.
 */

export const DOCUMENT_STORE_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "document-store";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): DocumentStoreMessages =>
	documentStoreMessages(locale);
export type DocumentStoreLocale = (typeof DOCUMENT_STORE_LOCALES)[number];
const BASE_LOCALE: DocumentStoreLocale = "en";

export interface DocumentStoreMessages {
	readonly title: string;
	readonly description: string;
	readonly colName: string;
	readonly colOwner: string;
	readonly colVersion: string;
	readonly colFields: string;
	readonly colRecords: string;
	readonly colStatus: string;
	readonly colId: string;
	readonly colUpdated: string;
	readonly colActions: string;
	readonly statusContributed: string;
	readonly statusDbOnly: string;
	readonly badgeUnregistered: string;
	readonly open: string;
	readonly back: string;
	readonly newDocument: string;
	readonly editDocument: string;
	readonly edit: string;
	readonly delete: string;
	readonly save: string;
	readonly cancel: string;
	readonly create: string;
	readonly saving: string;
	readonly saveFailed: string;
	readonly emptyCollectionsTitle: string;
	readonly emptyCollectionsDescription: string;
	readonly emptyDocumentsTitle: string;
	readonly emptyDocumentsDescription: string;
	readonly deleteTitle: string;
	readonly deleteBody: (name: string) => string;
	readonly deleteConfirm: string;
	readonly deleteInUse: (referrers: string) => string;
	readonly prevPage: string;
	readonly nextPage: string;
	readonly pageInfo: (current: number, total: number) => string;
	readonly none: string;
	readonly invalidJson: string;
	readonly invalidNumber: string;
	readonly invalidDate: string;
	readonly loadFailed: string;
}

const en: DocumentStoreMessages = {
	title: "Document store",
	description: "Browse runtime data collections and manage their documents.",
	colName: "Collection",
	colOwner: "Owner",
	colVersion: "Version",
	colFields: "Fields",
	colRecords: "Records",
	colStatus: "Status",
	colId: "ID",
	colUpdated: "Updated",
	colActions: "Actions",
	statusContributed: "Contributed",
	statusDbOnly: "DB only",
	badgeUnregistered: "Unregistered",
	open: "Open",
	back: "All collections",
	newDocument: "New document",
	editDocument: "Edit document",
	edit: "Edit",
	delete: "Delete",
	save: "Save",
	cancel: "Cancel",
	create: "Create",
	saving: "Saving…",
	saveFailed: "Could not save the document. Check the highlighted issues and try again.",
	emptyCollectionsTitle: "No collections yet",
	emptyCollectionsDescription:
		"Collections appear here once a plugin contributes a document.collection definition.",
	emptyDocumentsTitle: "No documents yet",
	emptyDocumentsDescription: "Create the first document in this collection.",
	deleteTitle: "Delete document",
	deleteBody: paramMessage("en", "Delete document #{id}? This cannot be undone.", ["id"]),
	deleteConfirm: "Delete",
	deleteInUse: paramMessage("en", "This document is still referenced by {referrers}.", [
		"referrers",
	]),
	prevPage: "Previous",
	nextPage: "Next",
	pageInfo: paramMessage("en", "Page {current} of {total}", ["current", "total"]),
	none: "None",
	invalidJson: "Invalid JSON",
	invalidNumber: "Invalid number",
	invalidDate: "Invalid date",
	loadFailed: "Could not load documents. Try again.",
};

const ptBR: DocumentStoreMessages = {
	title: "Document store",
	description: "Navegue pelas coleções de dados de runtime e gerencie seus documentos.",
	colName: "Coleção",
	colOwner: "Proprietário",
	colVersion: "Versão",
	colFields: "Campos",
	colRecords: "Registros",
	colStatus: "Status",
	colId: "ID",
	colUpdated: "Atualizado",
	colActions: "Ações",
	statusContributed: "Contribuída",
	statusDbOnly: "Somente DB",
	badgeUnregistered: "Não registrada",
	open: "Abrir",
	back: "Todas as coleções",
	newDocument: "Novo documento",
	editDocument: "Editar documento",
	edit: "Editar",
	delete: "Excluir",
	save: "Salvar",
	cancel: "Cancelar",
	create: "Criar",
	saving: "Salvando…",
	saveFailed:
		"Não foi possível salvar o documento. Verifique os problemas destacados e tente novamente.",
	emptyCollectionsTitle: "Nenhuma coleção ainda",
	emptyCollectionsDescription:
		"As coleções aparecem aqui quando um plugin contribui uma definição document.collection.",
	emptyDocumentsTitle: "Nenhum documento ainda",
	emptyDocumentsDescription: "Crie o primeiro documento desta coleção.",
	deleteTitle: "Excluir documento",
	deleteBody: paramMessage("pt-BR", "Excluir o documento #{id}? Esta ação não pode ser desfeita.", [
		"id",
	]),
	deleteConfirm: "Excluir",
	deleteInUse: paramMessage("pt-BR", "Este documento ainda é referenciado por {referrers}.", [
		"referrers",
	]),
	prevPage: "Anterior",
	nextPage: "Próxima",
	pageInfo: paramMessage("pt-BR", "Página {current} de {total}", ["current", "total"]),
	none: "Nenhum",
	invalidJson: "JSON inválido",
	invalidNumber: "Número inválido",
	invalidDate: "Data inválida",
	loadFailed: "Não foi possível carregar os documentos. Tente novamente.",
};

const es: DocumentStoreMessages = {
	title: "Document store",
	description: "Explora las colecciones de datos en tiempo de ejecución y gestiona sus documentos.",
	colName: "Colección",
	colOwner: "Propietario",
	colVersion: "Versión",
	colFields: "Campos",
	colRecords: "Registros",
	colStatus: "Estado",
	colId: "ID",
	colUpdated: "Actualizado",
	colActions: "Acciones",
	statusContributed: "Contribuida",
	statusDbOnly: "Solo BD",
	badgeUnregistered: "No registrada",
	open: "Abrir",
	back: "Todas las colecciones",
	newDocument: "Nuevo documento",
	editDocument: "Editar documento",
	edit: "Editar",
	delete: "Eliminar",
	save: "Guardar",
	cancel: "Cancelar",
	create: "Crear",
	saving: "Guardando…",
	saveFailed:
		"No se pudo guardar el documento. Revisa los problemas indicados e inténtalo de nuevo.",
	emptyCollectionsTitle: "Aún no hay colecciones",
	emptyCollectionsDescription:
		"Las colecciones aparecen aquí cuando un plugin contribuye una definición document.collection.",
	emptyDocumentsTitle: "Aún no hay documentos",
	emptyDocumentsDescription: "Crea el primer documento de esta colección.",
	deleteTitle: "Eliminar documento",
	deleteBody: paramMessage(
		"es",
		"¿Eliminar el documento #{id}? Esta acción no se puede deshacer.",
		["id"],
	),
	deleteConfirm: "Eliminar",
	deleteInUse: paramMessage("es", "Este documento aún está referenciado por {referrers}.", [
		"referrers",
	]),
	prevPage: "Anterior",
	nextPage: "Siguiente",
	pageInfo: paramMessage("es", "Página {current} de {total}", ["current", "total"]),
	none: "Ninguno",
	invalidJson: "JSON no válido",
	invalidNumber: "Número no válido",
	invalidDate: "Fecha no válida",
	loadFailed: "No se pudieron cargar los documentos. Inténtalo de nuevo.",
};

const CATALOGS: Record<DocumentStoreLocale, DocumentStoreMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isDocumentStoreLocale = (locale: string): locale is DocumentStoreLocale =>
	(DOCUMENT_STORE_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const documentStoreMessages = (locale: string | undefined): DocumentStoreMessages =>
	CATALOGS[isDocumentStoreLocale(locale ?? "") ? (locale as DocumentStoreLocale) : BASE_LOCALE];
