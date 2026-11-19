/**
 * Fonts plugin copy — one typed catalog per locale (same contract as
 * @ktb/theme i18n: plugins cannot import the host's Paraglide output).
 */

export const FONTS_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "fonts";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): FontMessages => fontMessages(locale);
export type FontLocale = (typeof FONTS_LOCALES)[number];
export const BASE_LOCALE: FontLocale = "en";

export interface FontMessages {
	readonly providersTitle: string;
	readonly providersDescription: string;
	readonly fontsTitle: string;
	readonly fontsDescription: string;
	readonly colName: string;
	readonly colKind: string;
	readonly colEnabled: string;
	readonly colFamilies: string;
	readonly colUpdated: string;
	readonly colActions: string;
	readonly colFamily: string;
	readonly colProvider: string;
	readonly colWeights: string;
	readonly colStatus: string;
	readonly addProvider: string;
	readonly dialogAddTitle: string;
	readonly nameLabel: string;
	readonly namePlaceholder: string;
	readonly kindLabel: string;
	readonly create: string;
	readonly creating: string;
	readonly cancel: string;
	readonly createError: string;
	readonly sync: string;
	readonly syncing: string;
	readonly syncedToast: string;
	readonly syncError: string;
	readonly deleteProvider: string;
	readonly deleteConfirm: string;
	readonly deleteError: string;
	readonly emptyProviders: string;
	readonly emptyFamilies: string;
	readonly searchPlaceholder: string;
	readonly searchLabel: string;
	readonly filteredCount: (shown: number, total: number) => string;
	readonly noResults: string;
	readonly allProviders: string;
	readonly providerFilterLabel: string;
	readonly statusPending: string;
	readonly statusReady: string;
	readonly statusFailed: string;
	readonly weightsNone: string;
	readonly uploadFont: string;
	readonly dialogUploadTitle: string;
	readonly familyLabel: string;
	readonly familyPlaceholder: string;
	readonly weightLabel: string;
	readonly weightPlaceholder: string;
	readonly fileLabel: string;
	readonly upload: string;
	readonly uploading: string;
	readonly uploadToast: string;
	readonly uploadError: string;
}

const en: FontMessages = {
	providersTitle: "Font providers",
	providersDescription:
		"Font sources the platform can sync — local theme assets and embedded catalogs.",
	fontsTitle: "Fonts",
	fontsDescription: "Synced font families offered by the enabled providers.",
	colName: "Name",
	colKind: "Kind",
	colEnabled: "Enabled",
	colFamilies: "Families",
	colUpdated: "Updated",
	colActions: "Actions",
	colFamily: "Family",
	colProvider: "Provider",
	colWeights: "Weights",
	colStatus: "Status",
	addProvider: "Add provider",
	dialogAddTitle: "Add font provider",
	nameLabel: "Name",
	namePlaceholder: "e.g. Google Fonts",
	kindLabel: "Kind",
	create: "Create",
	creating: "Creating…",
	cancel: "Cancel",
	createError: "Could not create the provider",
	sync: "Sync",
	syncing: "Syncing…",
	syncedToast: "Font catalog synced",
	syncError: "Sync failed",
	deleteProvider: "Delete",
	deleteConfirm: "Delete this font provider? Its synced families are removed too.",
	deleteError: "Could not delete the provider",
	emptyProviders: "No font providers yet — add one to start syncing families.",
	emptyFamilies: "No font families synced yet — sync a provider first.",
	searchPlaceholder: "Search providers…",
	searchLabel: "Search providers",
	filteredCount: (shown, total) => `${shown} of ${total} providers`,
	noResults: "No providers match the search.",
	allProviders: "All providers",
	providerFilterLabel: "Provider",
	statusPending: "Pending",
	statusReady: "Ready",
	statusFailed: "Failed",
	weightsNone: "—",
	uploadFont: "Upload font",
	dialogUploadTitle: "Upload font to catalog",
	familyLabel: "Family name",
	familyPlaceholder: "e.g. Brand Sans",
	weightLabel: "Weight (optional)",
	weightPlaceholder: "400",
	fileLabel: "Font file",
	upload: "Upload",
	uploading: "Uploading…",
	uploadToast: "Font added to the catalog",
	uploadError: "Font upload failed",
};

const ptBR: FontMessages = {
	providersTitle: "Provedores de fontes",
	providersDescription:
		"Fontes que a plataforma pode sincronizar — assets locais de tema e catálogos embutidos.",
	fontsTitle: "Fontes",
	fontsDescription: "Famílias de fontes sincronizadas oferecidas pelos provedores ativos.",
	colName: "Nome",
	colKind: "Tipo",
	colEnabled: "Ativo",
	colFamilies: "Famílias",
	colUpdated: "Atualizado",
	colActions: "Ações",
	colFamily: "Família",
	colProvider: "Provedor",
	colWeights: "Pesos",
	colStatus: "Status",
	addProvider: "Adicionar provedor",
	dialogAddTitle: "Adicionar provedor de fontes",
	nameLabel: "Nome",
	namePlaceholder: "ex.: Google Fonts",
	kindLabel: "Tipo",
	create: "Criar",
	creating: "Criando…",
	cancel: "Cancelar",
	createError: "Não foi possível criar o provedor",
	sync: "Sincronizar",
	syncing: "Sincronizando…",
	syncedToast: "Catálogo de fontes sincronizado",
	syncError: "Falha na sincronização",
	deleteProvider: "Excluir",
	deleteConfirm:
		"Excluir este provedor de fontes? As famílias sincronizadas também serão removidas.",
	deleteError: "Não foi possível excluir o provedor",
	emptyProviders:
		"Nenhum provedor de fontes ainda — adicione um para começar a sincronizar famílias.",
	emptyFamilies: "Nenhuma família de fontes sincronizada — sincronize um provedor primeiro.",
	searchPlaceholder: "Buscar provedores…",
	searchLabel: "Buscar provedores",
	filteredCount: (shown, total) => `${shown} de ${total} provedores`,
	noResults: "Nenhum provedor corresponde à busca.",
	allProviders: "Todos os provedores",
	providerFilterLabel: "Provedor",
	statusPending: "Pendente",
	statusReady: "Pronto",
	statusFailed: "Falhou",
	weightsNone: "—",
	uploadFont: "Enviar fonte",
	dialogUploadTitle: "Enviar fonte ao catálogo",
	familyLabel: "Nome da família",
	familyPlaceholder: "ex.: Brand Sans",
	weightLabel: "Peso (opcional)",
	weightPlaceholder: "400",
	fileLabel: "Arquivo de fonte",
	upload: "Enviar",
	uploading: "Enviando…",
	uploadToast: "Fonte adicionada ao catálogo",
	uploadError: "Falha no envio da fonte",
};

const es: FontMessages = {
	providersTitle: "Proveedores de fuentes",
	providersDescription:
		"Fuentes que la plataforma puede sincronizar — assets locales de tema y catálogos integrados.",
	fontsTitle: "Fuentes",
	fontsDescription: "Familias de fuentes sincronizadas ofrecidas por los proveedores activos.",
	colName: "Nombre",
	colKind: "Tipo",
	colEnabled: "Activo",
	colFamilies: "Familias",
	colUpdated: "Actualizado",
	colActions: "Acciones",
	colFamily: "Familia",
	colProvider: "Proveedor",
	colWeights: "Pesos",
	colStatus: "Estado",
	addProvider: "Añadir proveedor",
	dialogAddTitle: "Añadir proveedor de fuentes",
	nameLabel: "Nombre",
	namePlaceholder: "p. ej. Google Fonts",
	kindLabel: "Tipo",
	create: "Crear",
	creating: "Creando…",
	cancel: "Cancelar",
	createError: "No se pudo crear el proveedor",
	sync: "Sincronizar",
	syncing: "Sincronizando…",
	syncedToast: "Catálogo de fuentes sincronizado",
	syncError: "Error de sincronización",
	deleteProvider: "Eliminar",
	deleteConfirm:
		"¿Eliminar este proveedor de fuentes? Sus familias sincronizadas también se eliminarán.",
	deleteError: "No se pudo eliminar el proveedor",
	emptyProviders:
		"Aún no hay proveedores de fuentes — añade uno para empezar a sincronizar familias.",
	emptyFamilies: "Aún no hay familias de fuentes sincronizadas — sincroniza un proveedor primero.",
	searchPlaceholder: "Buscar proveedores…",
	searchLabel: "Buscar proveedores",
	filteredCount: (shown, total) => `${shown} de ${total} proveedores`,
	noResults: "Ningún proveedor coincide con la búsqueda.",
	allProviders: "Todos los proveedores",
	providerFilterLabel: "Proveedor",
	statusPending: "Pendiente",
	statusReady: "Listo",
	statusFailed: "Falló",
	weightsNone: "—",
	uploadFont: "Subir fuente",
	dialogUploadTitle: "Subir fuente al catálogo",
	familyLabel: "Nombre de la familia",
	familyPlaceholder: "p. ej. Brand Sans",
	weightLabel: "Peso (opcional)",
	weightPlaceholder: "400",
	fileLabel: "Archivo de fuente",
	upload: "Subir",
	uploading: "Subiendo…",
	uploadToast: "Fuente añadida al catálogo",
	uploadError: "Error al subir la fuente",
};

const CATALOGS: Record<FontLocale, FontMessages> = { en, "pt-BR": ptBR, es };

export const isFontLocale = (locale: string): locale is FontLocale =>
	(FONTS_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const fontMessages = (locale: string): FontMessages =>
	CATALOGS[isFontLocale(locale) ? locale : BASE_LOCALE];
