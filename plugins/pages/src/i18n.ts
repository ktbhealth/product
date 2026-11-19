/**
 * Custom pages plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the page/chrome ctx and the view resolves its
 * strings here. A locale catalog must implement `PagesMessages` in
 * full — a missing key is a type error, not an English fallback.
 */

import { paramMessage } from "@ktb/i18n";

export const PAGES_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "pages";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): PagesMessages => pagesMessages(locale);
export type PagesLocale = (typeof PAGES_LOCALES)[number];
const BASE_LOCALE: PagesLocale = "en";

export interface PagesMessages {
	readonly title: string;
	readonly description: string;
	readonly newPage: string;
	readonly edit: string;
	readonly view: string;
	readonly delete: string;
	readonly save: string;
	readonly cancel: string;
	readonly create: string;
	readonly saving: string;
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	readonly colPath: string;
	readonly colTitle: string;
	readonly colStatus: string;
	readonly colNav: string;
	readonly colOrder: string;
	readonly colActions: string;
	readonly statusPublished: string;
	readonly statusDraft: string;
	readonly navShown: string;
	readonly navHidden: string;
	readonly fieldPath: string;
	readonly fieldTitle: string;
	readonly fieldContentDoc: string;
	readonly fieldPublished: string;
	readonly fieldShowInNav: string;
	readonly fieldSortOrder: string;
	readonly contentDocNone: string;
	readonly contentDocHint: string;
	readonly manageDocs: string;
	readonly manageDoc: string;
	readonly fieldSearchSchema: string;
	readonly searchSchemaNone: string;
	readonly searchSchemaHint: string;
	readonly manageSchemas: string;
	readonly fieldLayout: string;
	readonly layoutNone: string;
	readonly layoutHint: string;
	readonly manageLayouts: string;
	readonly pathHint: string;
	readonly deleteTitle: string;
	readonly deleteBody: (path: string) => string;
	readonly deleteConfirm: string;
	readonly saveFailed: string;
}

const en: PagesMessages = {
	title: "Pages",
	description: "Create and manage custom pages rendered on this site.",
	newPage: "New page",
	edit: "Edit",
	view: "View",
	delete: "Delete",
	save: "Save",
	cancel: "Cancel",
	create: "Create",
	saving: "Saving…",
	emptyTitle: "No custom pages yet",
	emptyDescription: "Create your first page to publish it on the site.",
	colPath: "Path",
	colTitle: "Title",
	colStatus: "Status",
	colNav: "Nav",
	colOrder: "Order",
	colActions: "Actions",
	statusPublished: "Published",
	statusDraft: "Draft",
	navShown: "Shown",
	navHidden: "Hidden",
	fieldPath: "Path",
	fieldTitle: "Title",
	fieldContentDoc: "Content document",
	fieldPublished: "Published",
	fieldShowInNav: "Show in navigation",
	fieldSortOrder: "Sort order",
	contentDocNone: "No document",
	contentDocHint: "The page renders the selected rich-text document.",
	manageDocs: "Manage documents",
	manageDoc: "Manage rich text",
	fieldSearchSchema: "Search schema",
	searchSchemaNone: "No schema",
	searchSchemaHint:
		"URL search params are validated against the selected schema; invalid params are dropped.",
	manageSchemas: "Manage schemas",
	fieldLayout: "Layout",
	layoutNone: "No layout",
	layoutHint:
		"The page body renders the selected layout's ordered sections instead of the content document.",
	manageLayouts: "Manage layouts",
	pathHint: "Starts with / — e.g. /about. /platform paths are reserved.",
	deleteTitle: "Delete page",
	deleteBody: paramMessage("en", 'Delete "{path}"? This cannot be undone.', ["path"]),
	deleteConfirm: "Delete",
	saveFailed: "Could not save the page. Check the path and try again.",
};

const ptBR: PagesMessages = {
	title: "Páginas",
	description: "Crie e gerencie páginas personalizadas exibidas neste site.",
	newPage: "Nova página",
	edit: "Editar",
	view: "Ver",
	delete: "Excluir",
	save: "Salvar",
	cancel: "Cancelar",
	create: "Criar",
	saving: "Salvando…",
	emptyTitle: "Nenhuma página personalizada ainda",
	emptyDescription: "Crie sua primeira página para publicá-la no site.",
	colPath: "Caminho",
	colTitle: "Título",
	colStatus: "Status",
	colNav: "Nav",
	colOrder: "Ordem",
	colActions: "Ações",
	statusPublished: "Publicada",
	statusDraft: "Rascunho",
	navShown: "Visível",
	navHidden: "Oculta",
	fieldPath: "Caminho",
	fieldTitle: "Título",
	fieldContentDoc: "Documento de conteúdo",
	fieldPublished: "Publicada",
	fieldShowInNav: "Mostrar na navegação",
	fieldSortOrder: "Ordem de exibição",
	contentDocNone: "Nenhum documento",
	contentDocHint: "A página exibe o documento de texto rico selecionado.",
	manageDocs: "Gerenciar documentos",
	manageDoc: "Gerenciar texto rico",
	fieldSearchSchema: "Esquema de busca",
	searchSchemaNone: "Nenhum esquema",
	searchSchemaHint:
		"Os parâmetros de busca da URL são validados pelo esquema selecionado; parâmetros inválidos são removidos.",
	manageSchemas: "Gerenciar esquemas",
	fieldLayout: "Layout",
	layoutNone: "Nenhum layout",
	layoutHint:
		"O corpo da página exibe as seções ordenadas do layout selecionado em vez do documento de conteúdo.",
	manageLayouts: "Gerenciar layouts",
	pathHint: "Começa com / — ex.: /sobre. Caminhos /platform são reservados.",
	deleteTitle: "Excluir página",
	deleteBody: paramMessage("pt-BR", 'Excluir "{path}"? Esta ação não pode ser desfeita.', ["path"]),
	deleteConfirm: "Excluir",
	saveFailed: "Não foi possível salvar a página. Verifique o caminho e tente novamente.",
};

const es: PagesMessages = {
	title: "Páginas",
	description: "Crea y gestiona páginas personalizadas en este sitio.",
	newPage: "Nueva página",
	edit: "Editar",
	view: "Ver",
	delete: "Eliminar",
	save: "Guardar",
	cancel: "Cancelar",
	create: "Crear",
	saving: "Guardando…",
	emptyTitle: "Aún no hay páginas personalizadas",
	emptyDescription: "Crea tu primera página para publicarla en el sitio.",
	colPath: "Ruta",
	colTitle: "Título",
	colStatus: "Estado",
	colNav: "Nav",
	colOrder: "Orden",
	colActions: "Acciones",
	statusPublished: "Publicada",
	statusDraft: "Borrador",
	navShown: "Visible",
	navHidden: "Oculta",
	fieldPath: "Ruta",
	fieldTitle: "Título",
	fieldContentDoc: "Documento de contenido",
	fieldPublished: "Publicada",
	fieldShowInNav: "Mostrar en la navegación",
	fieldSortOrder: "Orden de visualización",
	contentDocNone: "Ningún documento",
	contentDocHint: "La página muestra el documento de texto enriquecido seleccionado.",
	manageDocs: "Gestionar documentos",
	manageDoc: "Gestionar texto enriquecido",
	fieldSearchSchema: "Esquema de búsqueda",
	searchSchemaNone: "Ningún esquema",
	searchSchemaHint:
		"Los parámetros de búsqueda de la URL se validan con el esquema seleccionado; los inválidos se eliminan.",
	manageSchemas: "Gestionar esquemas",
	fieldLayout: "Layout",
	layoutNone: "Ningún layout",
	layoutHint:
		"El cuerpo de la página muestra las secciones ordenadas del layout seleccionado en lugar del documento de contenido.",
	manageLayouts: "Gestionar layouts",
	pathHint: "Empieza con / — p. ej. /acerca. Las rutas /platform están reservadas.",
	deleteTitle: "Eliminar página",
	deleteBody: paramMessage("es", '¿Eliminar "{path}"? Esta acción no se puede deshacer.', ["path"]),
	deleteConfirm: "Eliminar",
	saveFailed: "No se pudo guardar la página. Revisa la ruta e inténtalo de nuevo.",
};

const CATALOGS: Record<PagesLocale, PagesMessages> = { en, "pt-BR": ptBR, es };

export const isPagesLocale = (locale: string): locale is PagesLocale =>
	(PAGES_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const pagesMessages = (locale: string | undefined): PagesMessages =>
	CATALOGS[isPagesLocale(locale ?? "") ? (locale as PagesLocale) : BASE_LOCALE];
