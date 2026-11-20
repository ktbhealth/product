/**
 * Image plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the page/chrome ctx and the view resolves its
 * strings here. A locale catalog must implement `ImageMessages` in
 * full — a missing key is a type error, not an English fallback.
 */

import { paramMessage } from "@ktb/i18n";

export const IMAGE_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "image";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): ImageMessages => imageMessages(locale);
export type ImageLocale = (typeof IMAGE_LOCALES)[number];
const BASE_LOCALE: ImageLocale = "en";

export interface ImageMessages {
	readonly title: string;
	readonly description: string;
	readonly upload: string;
	readonly uploading: string;
	readonly edit: string;
	readonly delete: string;
	readonly save: string;
	readonly cancel: string;
	readonly untitled: string;
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	readonly fieldTitle: string;
	readonly fieldAlt: string;
	readonly deleteTitle: string;
	readonly deleteBody: (title: string) => string;
	readonly deleteConfirm: string;
	readonly deleteUsedBy: string;
	readonly deleteActionPrompt: string;
	readonly deleteInUse: string;
	readonly deleted: string;
	readonly deleteFailed: string;
	readonly uploadFailed: string;
	readonly saveFailed: string;
	readonly loadFailed: string;
}

const en: ImageMessages = {
	title: "Images",
	description: "Upload and manage the media library for site content.",
	upload: "Upload image",
	uploading: "Uploading…",
	edit: "Edit",
	delete: "Delete",
	save: "Save",
	cancel: "Cancel",
	untitled: "Untitled",
	emptyTitle: "No images yet",
	emptyDescription: "Upload the first image for your site content.",
	fieldTitle: "Title",
	fieldAlt: "Alt text",
	deleteTitle: "Delete image",
	deleteBody: paramMessage("en", 'Delete "{title}"? This cannot be undone.', ["title"]),
	deleteConfirm: "Delete",
	deleteUsedBy: "Referenced by",
	deleteActionPrompt: "Choose what happens to the references:",
	deleteInUse:
		"This image is referenced elsewhere — unlink or delete the referents before deleting it.",
	deleted: "Image deleted",
	deleteFailed: "Could not delete the image.",
	uploadFailed: "Could not upload the image.",
	saveFailed: "Could not save the image.",
	loadFailed: "Could not load the image.",
};

const ptBR: ImageMessages = {
	title: "Imagens",
	description: "Envie e gerencie a biblioteca de mídia do conteúdo do site.",
	upload: "Enviar imagem",
	uploading: "Enviando…",
	edit: "Editar",
	delete: "Excluir",
	save: "Salvar",
	cancel: "Cancelar",
	untitled: "Sem título",
	emptyTitle: "Nenhuma imagem ainda",
	emptyDescription: "Envie a primeira imagem do conteúdo do site.",
	fieldTitle: "Título",
	fieldAlt: "Texto alternativo",
	deleteTitle: "Excluir imagem",
	deleteBody: paramMessage("pt-BR", 'Excluir "{title}"? Esta ação não pode ser desfeita.', [
		"title",
	]),
	deleteConfirm: "Excluir",
	deleteUsedBy: "Referenciado por",
	deleteActionPrompt: "Escolha o que acontece com as referências:",
	deleteInUse:
		"Esta imagem é referenciada em outro lugar — remova ou exclua as referências antes de excluí-la.",
	deleted: "Imagem excluída",
	deleteFailed: "Não foi possível excluir a imagem.",
	uploadFailed: "Não foi possível enviar a imagem.",
	saveFailed: "Não foi possível salvar a imagem.",
	loadFailed: "Não foi possível carregar a imagem.",
};

const es: ImageMessages = {
	title: "Imágenes",
	description: "Sube y gestiona la biblioteca de medios del contenido del sitio.",
	upload: "Subir imagen",
	uploading: "Subiendo…",
	edit: "Editar",
	delete: "Eliminar",
	save: "Guardar",
	cancel: "Cancelar",
	untitled: "Sin título",
	emptyTitle: "Aún no hay imágenes",
	emptyDescription: "Sube la primera imagen del contenido del sitio.",
	fieldTitle: "Título",
	fieldAlt: "Texto alternativo",
	deleteTitle: "Eliminar imagen",
	deleteBody: paramMessage("es", '¿Eliminar "{title}"? Esta acción no se puede deshacer.', [
		"title",
	]),
	deleteConfirm: "Eliminar",
	deleteUsedBy: "Referenciado por",
	deleteActionPrompt: "Elige qué ocurre con las referencias:",
	deleteInUse:
		"Esta imagen está referenciada en otro lugar — desvincula o elimina las referencias antes de eliminarla.",
	deleted: "Imagen eliminada",
	deleteFailed: "No se pudo eliminar la imagen.",
	uploadFailed: "No se pudo subir la imagen.",
	saveFailed: "No se pudo guardar la imagen.",
	loadFailed: "No se pudo cargar la imagen.",
};

const CATALOGS: Record<ImageLocale, ImageMessages> = { en, "pt-BR": ptBR, es };

export const isImageLocale = (locale: string): locale is ImageLocale =>
	(IMAGE_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const imageMessages = (locale: string | undefined): ImageMessages =>
	CATALOGS[isImageLocale(locale ?? "") ? (locale as ImageLocale) : BASE_LOCALE];
