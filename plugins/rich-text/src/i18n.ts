/**
 * Rich-text plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the page/chrome ctx and the view resolves its
 * strings here. A locale catalog must implement `RichTextMessages` in
 * full — a missing key is a type error, not an English fallback.
 */

import { paramMessage } from "@ktb/i18n";

export const RICH_TEXT_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "rich-text";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): RichTextMessages => richTextMessages(locale);
export type RichTextLocale = (typeof RICH_TEXT_LOCALES)[number];
const BASE_LOCALE: RichTextLocale = "en";

export interface RichTextMessages {
	readonly title: string;
	readonly description: string;
	readonly newDoc: string;
	readonly edit: string;
	readonly delete: string;
	readonly save: string;
	readonly cancel: string;
	readonly create: string;
	readonly saving: string;
	readonly saved: string;
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	readonly colTitle: string;
	readonly colUpdated: string;
	readonly colActions: string;
	readonly fieldTitle: string;
	readonly fieldContent: string;
	readonly untitled: string;
	readonly deleteTitle: string;
	readonly deleteBody: (title: string) => string;
	readonly deleteConfirm: string;
	readonly deletedEmpty: string;
	readonly deleted: string;
	readonly deleteFailed: string;
	readonly loadFailed: string;
	readonly saveFailed: string;
}

const en: RichTextMessages = {
	title: "Rich text",
	description: "Write and manage rich-text documents.",
	newDoc: "New document",
	edit: "Edit",
	delete: "Delete",
	save: "Save",
	cancel: "Cancel",
	create: "Create",
	saving: "Saving…",
	saved: "Saved",
	emptyTitle: "No documents yet",
	emptyDescription: "Create your first rich-text document.",
	colTitle: "Title",
	colUpdated: "Updated",
	colActions: "Actions",
	fieldTitle: "Title",
	fieldContent: "Content",
	untitled: "Untitled",
	deleteTitle: "Delete document",
	deleteBody: paramMessage("en", 'Delete "{title}"? This cannot be undone.', ["title"]),
	deleteConfirm: "Delete",
	deletedEmpty: "Empty document deleted",
	deleted: "Document deleted",
	deleteFailed: "Could not delete the document.",
	loadFailed: "Could not load the document.",
	saveFailed: "Could not save the document.",
};

const ptBR: RichTextMessages = {
	title: "Texto rico",
	description: "Escreva e gerencie documentos de texto rico.",
	newDoc: "Novo documento",
	edit: "Editar",
	delete: "Excluir",
	save: "Salvar",
	cancel: "Cancelar",
	create: "Criar",
	saving: "Salvando…",
	saved: "Salvo",
	emptyTitle: "Nenhum documento ainda",
	emptyDescription: "Crie seu primeiro documento de texto rico.",
	colTitle: "Título",
	colUpdated: "Atualizado",
	colActions: "Ações",
	fieldTitle: "Título",
	fieldContent: "Conteúdo",
	untitled: "Sem título",
	deleteTitle: "Excluir documento",
	deleteBody: paramMessage("pt-BR", 'Excluir "{title}"? Esta ação não pode ser desfeita.', [
		"title",
	]),
	deleteConfirm: "Excluir",
	deletedEmpty: "Documento vazio excluído",
	deleted: "Documento excluído",
	deleteFailed: "Não foi possível excluir o documento.",
	loadFailed: "Não foi possível carregar o documento.",
	saveFailed: "Não foi possível salvar o documento.",
};

const es: RichTextMessages = {
	title: "Texto enriquecido",
	description: "Escribe y gestiona documentos de texto enriquecido.",
	newDoc: "Nuevo documento",
	edit: "Editar",
	delete: "Eliminar",
	save: "Guardar",
	cancel: "Cancelar",
	create: "Crear",
	saving: "Guardando…",
	saved: "Guardado",
	emptyTitle: "Aún no hay documentos",
	emptyDescription: "Crea tu primer documento de texto enriquecido.",
	colTitle: "Título",
	colUpdated: "Actualizado",
	colActions: "Acciones",
	fieldTitle: "Título",
	fieldContent: "Contenido",
	untitled: "Sin título",
	deleteTitle: "Eliminar documento",
	deleteBody: paramMessage("es", '¿Eliminar "{title}"? Esta acción no se puede deshacer.', [
		"title",
	]),
	deleteConfirm: "Eliminar",
	deletedEmpty: "Documento vacío eliminado",
	deleted: "Documento eliminado",
	deleteFailed: "No se pudo eliminar el documento.",
	loadFailed: "No se pudo cargar el documento.",
	saveFailed: "No se pudo guardar el documento.",
};

const CATALOGS: Record<RichTextLocale, RichTextMessages> = { en, "pt-BR": ptBR, es };

export const isRichTextLocale = (locale: string): locale is RichTextLocale =>
	(RICH_TEXT_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const richTextMessages = (locale: string | undefined): RichTextMessages =>
	CATALOGS[isRichTextLocale(locale ?? "") ? (locale as RichTextLocale) : BASE_LOCALE];
