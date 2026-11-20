/**
 * Layouts plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the page/chrome ctx and the view resolves its
 * strings here. A locale catalog must implement `LayoutsMessages` in
 * full — a missing key is a type error, not an English fallback.
 */

import { paramMessage } from "@ktb/i18n";

export const LAYOUTS_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "layouts";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): LayoutsMessages => layoutsMessages(locale);
export type LayoutsLocale = (typeof LAYOUTS_LOCALES)[number];
const BASE_LOCALE: LayoutsLocale = "en";

export interface LayoutsMessages {
	readonly title: string;
	readonly description: string;
	readonly newLayout: string;
	readonly edit: string;
	readonly openInBuilder: string;
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
	readonly colSections: string;
	readonly colUpdated: string;
	readonly colActions: string;
	readonly fieldName: string;
	readonly namePlaceholder: string;
	readonly fieldDescription: string;
	readonly fieldConfig: string;
	readonly configHint: string;
	readonly sectionsPreview: string;
	readonly noSections: string;
	readonly deleteTitle: string;
	readonly deleteBody: (name: string) => string;
	readonly deleteConfirm: string;
	readonly deleted: string;
	readonly deleteFailed: string;
	readonly loadFailed: string;
	readonly saveFailed: string;
	readonly saveAsTemplate: string;
	readonly templateSaved: string;
	readonly templateSaveFailed: string;
}

const en: LayoutsMessages = {
	title: "Layouts",
	description: "Compose page bodies from ordered sections bound to rich-text documents.",
	newLayout: "New layout",
	edit: "Edit",
	openInBuilder: "Open in builder",
	delete: "Delete",
	save: "Save",
	cancel: "Cancel",
	create: "Create",
	saving: "Saving…",
	saved: "Saved",
	emptyTitle: "No layouts yet",
	emptyDescription: "Create your first layout to compose page bodies.",
	colName: "Name",
	colDescription: "Description",
	colSections: "Sections",
	colUpdated: "Updated",
	colActions: "Actions",
	fieldName: "Name",
	namePlaceholder: "e.g. landing-page",
	fieldDescription: "Description",
	fieldConfig: "Layout config (JSON)",
	configHint:
		'JSON config — a sections array; each item has id, title, kind "rich-text", and refId (rich-text document id). Sections render in order on pages that select this layout.',
	sectionsPreview: "Sections",
	noSections: "No sections",
	deleteTitle: "Delete layout",
	deleteBody: paramMessage("en", 'Delete "{name}"? This cannot be undone.', ["name"]),
	deleteConfirm: "Delete",
	deleted: "Layout deleted",
	deleteFailed: "Could not delete the layout.",
	loadFailed: "Could not load the layout.",
	saveFailed: "Could not save the layout. Check the config JSON and try again.",
	saveAsTemplate: "Save as template",
	templateSaved: "Template saved",
	templateSaveFailed: "Could not save the template.",
};

const ptBR: LayoutsMessages = {
	title: "Layouts",
	description: "Componha corpos de página com seções ordenadas ligadas a documentos de texto rico.",
	newLayout: "Novo layout",
	edit: "Editar",
	openInBuilder: "Abrir no construtor",
	delete: "Excluir",
	save: "Salvar",
	cancel: "Cancelar",
	create: "Criar",
	saving: "Salvando…",
	saved: "Salvo",
	emptyTitle: "Nenhum layout ainda",
	emptyDescription: "Crie seu primeiro layout para compor corpos de página.",
	colName: "Nome",
	colDescription: "Descrição",
	colSections: "Seções",
	colUpdated: "Atualizado",
	colActions: "Ações",
	fieldName: "Nome",
	namePlaceholder: "ex.: landing-page",
	fieldDescription: "Descrição",
	fieldConfig: "Configuração do layout (JSON)",
	configHint:
		'Configuração JSON — um array sections; cada item tem id, title, kind "rich-text" e refId (id do documento rich-text). As seções são exibidas em ordem nas páginas que selecionam este layout.',
	sectionsPreview: "Seções",
	noSections: "Nenhuma seção",
	deleteTitle: "Excluir layout",
	deleteBody: paramMessage("pt-BR", 'Excluir "{name}"? Esta ação não pode ser desfeita.', ["name"]),
	deleteConfirm: "Excluir",
	deleted: "Layout excluído",
	deleteFailed: "Não foi possível excluir o layout.",
	loadFailed: "Não foi possível carregar o layout.",
	saveFailed:
		"Não foi possível salvar o layout. Verifique o JSON de configuração e tente novamente.",
	saveAsTemplate: "Salvar como modelo",
	templateSaved: "Modelo salvo",
	templateSaveFailed: "Não foi possível salvar o modelo.",
};

const es: LayoutsMessages = {
	title: "Layouts",
	description:
		"Compón cuerpos de página con secciones ordenadas vinculadas a documentos de texto enriquecido.",
	newLayout: "Nuevo layout",
	edit: "Editar",
	openInBuilder: "Abrir en el editor",
	delete: "Eliminar",
	save: "Guardar",
	cancel: "Cancelar",
	create: "Crear",
	saving: "Guardando…",
	saved: "Guardado",
	emptyTitle: "Aún no hay layouts",
	emptyDescription: "Crea tu primer layout para componer cuerpos de página.",
	colName: "Nombre",
	colDescription: "Descripción",
	colSections: "Secciones",
	colUpdated: "Actualizado",
	colActions: "Acciones",
	fieldName: "Nombre",
	namePlaceholder: "p. ej. landing-page",
	fieldDescription: "Descripción",
	fieldConfig: "Configuración del layout (JSON)",
	configHint:
		'Configuración JSON — un array sections; cada elemento tiene id, title, kind "rich-text" y refId (id del documento rich-text). Las secciones se muestran en orden en las páginas que seleccionan este layout.',
	sectionsPreview: "Secciones",
	noSections: "Sin secciones",
	deleteTitle: "Eliminar layout",
	deleteBody: paramMessage("es", '¿Eliminar "{name}"? Esta acción no se puede deshacer.', ["name"]),
	deleteConfirm: "Eliminar",
	deleted: "Layout eliminado",
	deleteFailed: "No se pudo eliminar el layout.",
	loadFailed: "No se pudo cargar el layout.",
	saveFailed: "No se pudo guardar el layout. Revisa el JSON de configuración e inténtalo de nuevo.",
	saveAsTemplate: "Guardar como plantilla",
	templateSaved: "Plantilla guardada",
	templateSaveFailed: "No se pudo guardar la plantilla.",
};

const CATALOGS: Record<LayoutsLocale, LayoutsMessages> = { en, "pt-BR": ptBR, es };

export const isLayoutsLocale = (locale: string): locale is LayoutsLocale =>
	(LAYOUTS_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const layoutsMessages = (locale: string | undefined): LayoutsMessages =>
	CATALOGS[isLayoutsLocale(locale ?? "") ? (locale as LayoutsLocale) : BASE_LOCALE];
