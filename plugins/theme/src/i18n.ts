/**
 * Theme plugin copy — one typed catalog per locale (same contract as
 * @ktb/jobs i18n: plugins cannot import the host's Paraglide output).
 */

export const THEME_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "theme";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): ThemeMessages => themeMessages(locale);
export type ThemeLocale = (typeof THEME_LOCALES)[number];
export const BASE_LOCALE: ThemeLocale = "en";

export interface ThemeMessages {
	readonly pageTitle: string;
	readonly pageDescription: string;
	readonly scopeLabel: string;
	readonly scopePlatform: string;
	readonly scopeTenant: string;
	readonly scopePortalInstance: string;
	readonly scopeIdLabel: string;
	readonly scopeIdPlaceholder: string;
	readonly appNameLabel: string;
	readonly appNamePlaceholder: string;
	readonly seedsTitle: string;
	readonly seedsDescription: string;
	readonly seedPrimary: string;
	readonly seedSecondary: string;
	readonly seedAccent: string;
	readonly seedBackground: string;
	readonly seedForeground: string;
	readonly seedDestructive: string;
	readonly seedRadius: string;
	readonly darkTitle: string;
	readonly darkDescription: string;
	readonly fontsTitle: string;
	readonly fontsDeliveryLabel: string;
	readonly fontsSelfHost: string;
	readonly fontsGoogle: string;
	readonly fontsGoogleWarning: string;
	readonly fontsFamiliesLabel: string;
	readonly fontSans: string;
	readonly fontHeading: string;
	readonly fontMono: string;
	readonly brandTitle: string;
	readonly brandAppName: string;
	readonly previewTitle: string;
	readonly previewDescription: string;
	readonly contrastTitle: string;
	readonly contrastLight: string;
	readonly contrastDark: string;
	readonly contrastPass: string;
	readonly contrastFail: string;
	readonly publish: string;
	readonly publishing: string;
	readonly published: string;
	readonly publishError: string;
	readonly listTitle: string;
	readonly colScope: string;
	readonly colScopeId: string;
	readonly colName: string;
	readonly colEnabled: string;
	readonly colVersion: string;
	readonly colActions: string;
	readonly emptyList: string;
	readonly previewAction: string;
	readonly previewing: string;
	readonly edit: string;
	readonly enable: string;
	readonly disable: string;
	readonly assetTodo: string;
	readonly assetsTitle: string;
	readonly assetThemeLabel: string;
	readonly assetKindLabel: string;
	readonly assetFileLabel: string;
	readonly assetUpload: string;
	readonly assetUploading: string;
	readonly assetUploaded: string;
	readonly assetUploadError: string;
	readonly assetFontFamily: string;
	readonly assetFontSlot: string;
	readonly assetGoogleFetch: string;
	readonly assetGoogleFetching: string;
	readonly assetGoogleError: string;
	readonly bannerText: string;
	readonly bannerExit: string;
	readonly headerLabel: string;
	readonly headerEmpty: string;
	readonly headerPreview: string;
	readonly headerManage: string;
}

const en: ThemeMessages = {
	pageTitle: "Theme",
	pageDescription: "White-label tokens, brand assets and accessible palettes.",
	scopeLabel: "Scope",
	scopePlatform: "Platform default",
	scopeTenant: "Tenant",
	scopePortalInstance: "Portal instance",
	scopeIdLabel: "Scope id",
	scopeIdPlaceholder: "tenant id or portal instance id",
	appNameLabel: "App name",
	appNamePlaceholder: "Shown in titles and brand slots",
	seedsTitle: "Seed colors",
	seedsDescription:
		"Brand hues and surface preferences — every foreground pairing is derived and AA-checked automatically.",
	seedPrimary: "Primary",
	seedSecondary: "Secondary",
	seedAccent: "Accent",
	seedBackground: "Background",
	seedForeground: "Foreground",
	seedDestructive: "Destructive",
	seedRadius: "Radius",
	darkTitle: "Dark scheme overrides",
	darkDescription: "Optional — leave empty to derive dark mode from the same seeds.",
	fontsTitle: "Typography",
	fontsDeliveryLabel: "Font delivery",
	fontsSelfHost: "Self-hosted (recommended)",
	fontsGoogle: "Google Fonts link",
	fontsGoogleWarning:
		"Google Fonts sends visitor requests to Google — conflicts with on-prem deployments.",
	fontsFamiliesLabel: "Font families",
	fontSans: "Sans",
	fontHeading: "Heading",
	fontMono: "Mono",
	brandTitle: "Brand",
	brandAppName: "Brand app name",
	previewTitle: "Live preview",
	previewDescription: "Palette derived from the current seeds, both schemes.",
	contrastTitle: "Contrast report",
	contrastLight: "Light",
	contrastDark: "Dark",
	contrastPass: "AA pass",
	contrastFail: "below AA",
	publish: "Publish theme",
	publishing: "Publishing…",
	published: "Theme published",
	publishError: "Publish failed",
	listTitle: "Defined themes",
	colScope: "Scope",
	colScopeId: "Scope id",
	colName: "Name",
	colEnabled: "Enabled",
	colVersion: "v",
	colActions: "Actions",
	emptyList: "No themes defined yet — the ui defaults apply everywhere.",
	previewAction: "Preview",
	previewing: "Previewing…",
	edit: "Edit",
	enable: "Enable",
	disable: "Disable",
	assetTodo:
		"Asset uploads (logo, favicon, fonts) arrive with the async pipeline — manage URLs in the brand fields for now.",
	assetsTitle: "Asset uploads",
	assetThemeLabel: "Theme",
	assetKindLabel: "Asset kind",
	assetFileLabel: "File",
	assetUpload: "Upload",
	assetUploading: "Uploading…",
	assetUploaded: "Upload queued — variants are generated asynchronously.",
	assetUploadError: "Upload failed",
	assetFontFamily: "Font family",
	assetFontSlot: "Font slot",
	assetGoogleFetch: "Fetch from Google Fonts",
	assetGoogleFetching: "Fetching…",
	assetGoogleError: "Font fetch failed",
	bannerText: "Theme preview active",
	bannerExit: "Exit preview",
	headerLabel: "Theme",
	headerEmpty: "No themes defined yet.",
	headerPreview: "Preview",
	headerManage: "Manage themes",
};

const ptBR: ThemeMessages = {
	pageTitle: "Tema",
	pageDescription: "Tokens white-label, assets de marca e paletas acessíveis.",
	scopeLabel: "Escopo",
	scopePlatform: "Padrão da plataforma",
	scopeTenant: "Tenant",
	scopePortalInstance: "Instância de portal",
	scopeIdLabel: "Id do escopo",
	scopeIdPlaceholder: "id do tenant ou da instância de portal",
	appNameLabel: "Nome do app",
	appNamePlaceholder: "Exibido em títulos e slots de marca",
	seedsTitle: "Cores base",
	seedsDescription:
		"Matizes da marca e preferências de superfície — todos os pares de primeiro plano são derivados e verificados em AA automaticamente.",
	seedPrimary: "Primária",
	seedSecondary: "Secundária",
	seedAccent: "Destaque",
	seedBackground: "Fundo",
	seedForeground: "Primeiro plano",
	seedDestructive: "Destrutiva",
	seedRadius: "Raio",
	darkTitle: "Sobrescritas do tema escuro",
	darkDescription: "Opcional — deixe vazio para derivar o modo escuro das mesmas cores base.",
	fontsTitle: "Tipografia",
	fontsDeliveryLabel: "Entrega de fontes",
	fontsSelfHost: "Auto-hospedada (recomendado)",
	fontsGoogle: "Link do Google Fonts",
	fontsGoogleWarning:
		"O Google Fonts envia requisições de visitantes ao Google — conflita com implantações on-prem.",
	fontsFamiliesLabel: "Famílias de fontes",
	fontSans: "Sans",
	fontHeading: "Títulos",
	fontMono: "Mono",
	brandTitle: "Marca",
	brandAppName: "Nome do app na marca",
	previewTitle: "Pré-visualização ao vivo",
	previewDescription: "Paleta derivada das cores base atuais, nos dois esquemas.",
	contrastTitle: "Relatório de contraste",
	contrastLight: "Claro",
	contrastDark: "Escuro",
	contrastPass: "AA ok",
	contrastFail: "abaixo de AA",
	publish: "Publicar tema",
	publishing: "Publicando…",
	published: "Tema publicado",
	publishError: "Falha ao publicar",
	listTitle: "Temas definidos",
	colScope: "Escopo",
	colScopeId: "Id do escopo",
	colName: "Nome",
	colEnabled: "Ativo",
	colVersion: "v",
	colActions: "Ações",
	emptyList: "Nenhum tema definido — os padrões da ui valem em todo lugar.",
	previewAction: "Pré-visualizar",
	previewing: "Pré-visualizando…",
	edit: "Editar",
	enable: "Ativar",
	disable: "Desativar",
	assetTodo:
		"Uploads de assets (logo, favicon, fontes) chegam com o pipeline assíncrono — gerencie URLs nos campos de marca por enquanto.",
	assetsTitle: "Uploads de assets",
	assetThemeLabel: "Tema",
	assetKindLabel: "Tipo de asset",
	assetFileLabel: "Arquivo",
	assetUpload: "Enviar",
	assetUploading: "Enviando…",
	assetUploaded: "Upload na fila — variantes são geradas de forma assíncrona.",
	assetUploadError: "Falha no upload",
	assetFontFamily: "Família da fonte",
	assetFontSlot: "Slot da fonte",
	assetGoogleFetch: "Buscar no Google Fonts",
	assetGoogleFetching: "Buscando…",
	assetGoogleError: "Falha ao buscar fonte",
	bannerText: "Pré-visualização de tema ativa",
	bannerExit: "Sair da pré-visualização",
	headerLabel: "Tema",
	headerEmpty: "Nenhum tema definido ainda.",
	headerPreview: "Pré-visualizar",
	headerManage: "Gerenciar temas",
};

const es: ThemeMessages = {
	pageTitle: "Tema",
	pageDescription: "Tokens white-label, assets de marca y paletas accesibles.",
	scopeLabel: "Ámbito",
	scopePlatform: "Predeterminado de la plataforma",
	scopeTenant: "Tenant",
	scopePortalInstance: "Instancia de portal",
	scopeIdLabel: "Id del ámbito",
	scopeIdPlaceholder: "id del tenant o de la instancia de portal",
	appNameLabel: "Nombre de la app",
	appNamePlaceholder: "Se muestra en títulos y espacios de marca",
	seedsTitle: "Colores base",
	seedsDescription:
		"Matices de marca y preferencias de superficie — todos los pares de primer plano se derivan y verifican en AA automáticamente.",
	seedPrimary: "Primario",
	seedSecondary: "Secundario",
	seedAccent: "Acento",
	seedBackground: "Fondo",
	seedForeground: "Primer plano",
	seedDestructive: "Destructivo",
	seedRadius: "Radio",
	darkTitle: "Anulaciones del tema oscuro",
	darkDescription:
		"Opcional — déjelo vacío para derivar el modo oscuro de los mismos colores base.",
	fontsTitle: "Tipografía",
	fontsDeliveryLabel: "Entrega de fuentes",
	fontsSelfHost: "Autoalojada (recomendado)",
	fontsGoogle: "Enlace de Google Fonts",
	fontsGoogleWarning:
		"Google Fonts envía solicitudes de visitantes a Google — entra en conflicto con despliegues on-prem.",
	fontsFamiliesLabel: "Familias de fuentes",
	fontSans: "Sans",
	fontHeading: "Títulos",
	fontMono: "Mono",
	brandTitle: "Marca",
	brandAppName: "Nombre de la app en la marca",
	previewTitle: "Vista previa en vivo",
	previewDescription: "Paleta derivada de los colores base actuales, en ambos esquemas.",
	contrastTitle: "Informe de contraste",
	contrastLight: "Claro",
	contrastDark: "Oscuro",
	contrastPass: "AA ok",
	contrastFail: "bajo AA",
	publish: "Publicar tema",
	publishing: "Publicando…",
	published: "Tema publicado",
	publishError: "Error al publicar",
	listTitle: "Temas definidos",
	colScope: "Ámbito",
	colScopeId: "Id del ámbito",
	colName: "Nombre",
	colEnabled: "Activo",
	colVersion: "v",
	colActions: "Acciones",
	emptyList:
		"Aún no hay temas definidos — los valores predeterminados de la ui aplican en todas partes.",
	previewAction: "Vista previa",
	previewing: "Vista previa…",
	edit: "Editar",
	enable: "Activar",
	disable: "Desactivar",
	assetTodo:
		"Las subidas de assets (logo, favicon, fuentes) llegan con el pipeline asíncrono — gestione URLs en los campos de marca por ahora.",
	assetsTitle: "Subidas de assets",
	assetThemeLabel: "Tema",
	assetKindLabel: "Tipo de asset",
	assetFileLabel: "Archivo",
	assetUpload: "Subir",
	assetUploading: "Subiendo…",
	assetUploaded: "Subida en cola — las variantes se generan de forma asíncrona.",
	assetUploadError: "Error en la subida",
	assetFontFamily: "Familia de la fuente",
	assetFontSlot: "Espacio de la fuente",
	assetGoogleFetch: "Obtener de Google Fonts",
	assetGoogleFetching: "Obteniendo…",
	assetGoogleError: "Error al obtener la fuente",
	bannerText: "Vista previa de tema activa",
	bannerExit: "Salir de la vista previa",
	headerLabel: "Tema",
	headerEmpty: "Aún no hay temas definidos.",
	headerPreview: "Vista previa",
	headerManage: "Gestionar temas",
};

const CATALOGS: Record<ThemeLocale, ThemeMessages> = { en, "pt-BR": ptBR, es };

export const isThemeLocale = (locale: string): locale is ThemeLocale =>
	(THEME_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const themeMessages = (locale: string): ThemeMessages =>
	CATALOGS[isThemeLocale(locale) ? locale : BASE_LOCALE];
