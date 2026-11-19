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
	readonly fontsSourcesLabel: string;
	readonly fontSourceLabel: string;
	readonly fontSourceCustom: string;
	readonly fontSourceSearchPlaceholder: string;
	readonly fontSourceNoResults: string;
	readonly fontSans: string;
	readonly fontHeading: string;
	readonly fontMono: string;
	readonly fontPreviewLabel: string;
	readonly fontPreviewText: string;
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
	readonly badgeMain: string;
	readonly setMain: string;
	readonly mainSet: string;
	readonly deleteTheme: string;
	readonly deleteConfirm: string;
	readonly deleteError: string;
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
	readonly schemeLabel: string;
	readonly schemeSystem: string;
	readonly searchPlaceholder: string;
	readonly searchLabel: string;
	readonly newTheme: string;
	readonly filteredCount: (shown: number, total: number) => string;
	readonly noResults: string;
	readonly dialogCreateTitle: string;
	readonly dialogEditTitle: string;
	readonly tabGeneral: string;
	readonly tabColors: string;
	readonly tabTypography: string;
	readonly tabAssets: string;
	readonly cancel: string;
	readonly assetsNeedSave: string;
	readonly assetsListTitle: string;
	readonly assetsEmpty: string;
	readonly assetKindLogoLight: string;
	readonly assetKindLogoDark: string;
	readonly assetKindWordmark: string;
	readonly assetKindFavicon: string;
	readonly assetKindOgImage: string;
	readonly assetKindFont: string;
	readonly assetFontUpload: string;
	readonly assetStatusPending: string;
	readonly assetStatusReady: string;
	readonly assetStatusFailed: string;
	readonly assetGoogleFamily: string;
	readonly assetGoogleSlot: string;
	readonly brandRefsTitle: string;
	readonly editorBack: string;
	readonly editorThemeLabel: string;
	readonly editorNotFound: string;
	readonly dirtyBadge: string;
	readonly tabTokens: string;
	readonly tabComponents: string;
	readonly tabBlocks: string;
	readonly tokensTitle: string;
	readonly tokensDescription: string;
	readonly componentsTitle: string;
	readonly componentsDescription: string;
	readonly blocksTitle: string;
	readonly blocksDescription: string;
	readonly schemeLight: string;
	readonly schemeDark: string;
	readonly discardedToast: string;
	readonly galleryButtons: string;
	readonly galleryForms: string;
	readonly galleryFeedback: string;
	readonly gallerySurfaces: string;
	readonly blockStats: string;
	readonly blockSettings: string;
	readonly blockEmpty: string;
	readonly blockTable: string;
	readonly colStatus: string;
	readonly colColor: string;
	readonly contrastColPairing: string;
	readonly contrastColRatio: string;
	readonly contrastColMin: string;
	readonly tokenRefTitle: string;
	readonly tokenRefDesc: (scheme: string) => string;
	readonly tokenColToken: string;
	readonly tokenColValue: string;
	readonly tokenColSwatch: string;
	readonly radiusTitle: (radius: string) => string;
	readonly radiusCurrent: string;
	readonly galleryBtnDefault: string;
	readonly galleryBtnSecondary: string;
	readonly galleryBtnOutline: string;
	readonly galleryBtnGhost: string;
	readonly galleryBtnDestructive: string;
	readonly galleryBtnLink: string;
	readonly galleryBtnSmall: string;
	readonly galleryBtnLarge: string;
	readonly galleryBtnDisabled: string;
	readonly galleryInputLabel: string;
	readonly galleryInputPlaceholder: string;
	readonly galleryTextareaLabel: string;
	readonly galleryTextareaPlaceholder: string;
	readonly gallerySelectLabel: string;
	readonly galleryOptionA: string;
	readonly galleryOptionB: string;
	readonly galleryOptionOne: string;
	readonly galleryOptionTwo: string;
	readonly gallerySwitchNotifications: string;
	readonly gallerySwitchMarketing: string;
	readonly galleryAlertOkTitle: string;
	readonly galleryAlertOkDesc: string;
	readonly galleryAlertFailTitle: string;
	readonly galleryAlertFailDesc: string;
	readonly gallerySurfaceTeam: string;
	readonly gallerySurfaceRole: string;
	readonly gallerySurfaceMuted: string;
	readonly galleryStatActive: string;
	readonly galleryStatAssets: string;
	readonly galleryStatContrast: string;
	readonly gallerySettingsName: string;
	readonly gallerySettingsDesc: string;
	readonly gallerySettingsDescValue: string;
	readonly gallerySettingsEnabled: string;
	readonly gallerySettingsHighContrast: string;
	readonly gallerySettingsSave: string;
	readonly gallerySettingsReset: string;
	readonly galleryEmptyTitle: string;
	readonly galleryEmptyDesc: string;
	readonly galleryStatusReady: string;
	readonly galleryStatusDraft: string;
	readonly fontSampleHeading: string;
	readonly fontSampleSans: string;
	readonly fontSampleMono: string;
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
	fontsSourcesLabel: "Managed sources",
	fontSourceLabel: "Managed source",
	fontSourceCustom: "Custom (free-form)",
	fontSourceSearchPlaceholder: "Search provider or family…",
	fontSourceNoResults: "No fonts match your search.",
	fontSans: "Sans",
	fontHeading: "Heading",
	fontMono: "Mono",
	fontPreviewLabel: "Font preview",
	fontPreviewText: "The quick brown fox jumps over the lazy dog",
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
	badgeMain: "Main",
	setMain: "Set main",
	mainSet: "Main theme updated",
	deleteTheme: "Delete",
	deleteConfirm: "Delete this theme? This cannot be undone.",
	deleteError: "Could not delete theme",
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
	schemeLabel: "Appearance",
	schemeSystem: "System",
	searchPlaceholder: "Search by name, scope or id…",
	searchLabel: "Search themes",
	newTheme: "New theme",
	filteredCount: (shown, total) => `${shown} of ${total} themes`,
	noResults: "No themes match the search.",
	dialogCreateTitle: "New theme",
	dialogEditTitle: "Edit theme",
	tabGeneral: "General",
	tabColors: "Colors",
	tabTypography: "Typography",
	tabAssets: "Brand & assets",
	cancel: "Cancel",
	assetsNeedSave: "Save the theme once to enable asset uploads.",
	assetsListTitle: "Uploaded assets",
	assetsEmpty: "No assets uploaded yet.",
	assetKindLogoLight: "Logo (light)",
	assetKindLogoDark: "Logo (dark)",
	assetKindWordmark: "Wordmark",
	assetKindFavicon: "Favicon",
	assetKindOgImage: "OG image",
	assetKindFont: "Font file",
	assetFontUpload: "Upload font",
	assetStatusPending: "Pending",
	assetStatusReady: "Ready",
	assetStatusFailed: "Failed",
	assetGoogleFamily: "Google Fonts family",
	assetGoogleSlot: "Google font slot",
	brandRefsTitle: "Current brand references",
	editorBack: "Back to themes",
	editorThemeLabel: "Theme",
	editorNotFound: "Theme not found — it may have been deleted.",
	dirtyBadge: "Unsaved changes",
	tabTokens: "Tokens",
	tabComponents: "Components",
	tabBlocks: "Blocks",
	tokensTitle: "Design tokens",
	tokensDescription: "Derived CSS custom properties for both schemes.",
	componentsTitle: "Components",
	componentsDescription: "Design-system components rendered with the draft theme.",
	blocksTitle: "Blocks",
	blocksDescription: "Composed blocks rendered with the draft theme.",
	schemeLight: "Light",
	schemeDark: "Dark",
	discardedToast: "Empty theme discarded.",
	galleryButtons: "Buttons",
	galleryForms: "Form controls",
	galleryFeedback: "Feedback & data",
	gallerySurfaces: "Surfaces",
	blockStats: "Stats",
	blockSettings: "Settings",
	blockEmpty: "Empty state",
	blockTable: "Records",
	colStatus: "Status",
	colColor: "Color",
	contrastColPairing: "Pairing",
	contrastColRatio: "Ratio",
	contrastColMin: "Min",
	tokenRefTitle: "Token reference",
	tokenRefDesc: (scheme) => `${scheme} custom properties`,
	tokenColToken: "Token",
	tokenColValue: "Value",
	tokenColSwatch: "Swatch",
	radiusTitle: (radius) => `Radius — ${radius}`,
	radiusCurrent: "theme",
	galleryBtnDefault: "Default",
	galleryBtnSecondary: "Secondary",
	galleryBtnOutline: "Outline",
	galleryBtnGhost: "Ghost",
	galleryBtnDestructive: "Destructive",
	galleryBtnLink: "Link",
	galleryBtnSmall: "Small",
	galleryBtnLarge: "Large",
	galleryBtnDisabled: "Disabled",
	galleryInputLabel: "Input",
	galleryInputPlaceholder: "Placeholder text",
	galleryTextareaLabel: "Textarea",
	galleryTextareaPlaceholder: "Longer content…",
	gallerySelectLabel: "Native select styled control",
	galleryOptionA: "Option A",
	galleryOptionB: "Option B",
	galleryOptionOne: "Option one",
	galleryOptionTwo: "Option two",
	gallerySwitchNotifications: "Notifications",
	gallerySwitchMarketing: "Marketing emails",
	galleryAlertOkTitle: "Heads up",
	galleryAlertOkDesc: "Your changes were applied to the draft theme.",
	galleryAlertFailTitle: "Something failed",
	galleryAlertFailDesc: "Contrast ratio is below AA for this pairing.",
	gallerySurfaceTeam: "Platform team",
	gallerySurfaceRole: "Admin",
	gallerySurfaceMuted:
		"Muted surface — cards, separators and muted fills pick up the draft tokens.",
	galleryStatActive: "Active themes",
	galleryStatAssets: "Assets ready",
	galleryStatContrast: "Contrast failures",
	gallerySettingsName: "Display name",
	gallerySettingsDesc: "Description",
	gallerySettingsDescValue: "White-label theme for the platform shell.",
	gallerySettingsEnabled: "Enabled",
	gallerySettingsHighContrast: "High contrast",
	gallerySettingsSave: "Save changes",
	gallerySettingsReset: "Reset",
	galleryEmptyTitle: "No themes yet",
	galleryEmptyDesc: "Create a theme to start customizing the platform shell.",
	galleryStatusReady: "Ready",
	galleryStatusDraft: "Draft",
	fontSampleHeading: "Aa — Display heading",
	fontSampleSans: "Aa — Body text, buttons and inputs",
	fontSampleMono: "Aa — Code and identifiers",
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
	fontsSourcesLabel: "Fontes gerenciadas",
	fontSourceLabel: "Fonte gerenciada",
	fontSourceCustom: "Personalizada (texto livre)",
	fontSourceSearchPlaceholder: "Buscar provedor ou família…",
	fontSourceNoResults: "Nenhuma fonte corresponde à busca.",
	fontSans: "Sans",
	fontHeading: "Títulos",
	fontMono: "Mono",
	fontPreviewLabel: "Pré-visualização de fontes",
	fontPreviewText: "A rápida raposa marrom salta sobre o cão preguiçoso",
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
	badgeMain: "Principal",
	setMain: "Definir como principal",
	mainSet: "Tema principal atualizado",
	deleteTheme: "Excluir",
	deleteConfirm: "Excluir este tema? Esta ação não pode ser desfeita.",
	deleteError: "Não foi possível excluir o tema",
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
	schemeLabel: "Aparência",
	schemeSystem: "Sistema",
	searchPlaceholder: "Buscar por nome, escopo ou id…",
	searchLabel: "Buscar temas",
	newTheme: "Novo tema",
	filteredCount: (shown, total) => `${shown} de ${total} temas`,
	noResults: "Nenhum tema corresponde à busca.",
	dialogCreateTitle: "Novo tema",
	dialogEditTitle: "Editar tema",
	tabGeneral: "Geral",
	tabColors: "Cores",
	tabTypography: "Tipografia",
	tabAssets: "Marca e assets",
	cancel: "Cancelar",
	assetsNeedSave: "Salve o tema uma vez para habilitar uploads de assets.",
	assetsListTitle: "Assets enviados",
	assetsEmpty: "Nenhum asset enviado ainda.",
	assetKindLogoLight: "Logo (claro)",
	assetKindLogoDark: "Logo (escuro)",
	assetKindWordmark: "Wordmark",
	assetKindFavicon: "Favicon",
	assetKindOgImage: "Imagem OG",
	assetKindFont: "Arquivo de fonte",
	assetFontUpload: "Enviar fonte",
	assetStatusPending: "Pendente",
	assetStatusReady: "Pronto",
	assetStatusFailed: "Falhou",
	assetGoogleFamily: "Família do Google Fonts",
	assetGoogleSlot: "Slot do Google Fonts",
	brandRefsTitle: "Referências de marca atuais",
	editorBack: "Voltar aos temas",
	editorThemeLabel: "Tema",
	editorNotFound: "Tema não encontrado — pode ter sido excluído.",
	dirtyBadge: "Alterações não salvas",
	tabTokens: "Tokens",
	tabComponents: "Componentes",
	tabBlocks: "Blocos",
	tokensTitle: "Tokens de design",
	tokensDescription: "Propriedades CSS personalizadas derivadas para os dois esquemas.",
	componentsTitle: "Componentes",
	componentsDescription: "Componentes do design system renderizados com o tema em rascunho.",
	blocksTitle: "Blocos",
	blocksDescription: "Blocos compostos renderizados com o tema em rascunho.",
	schemeLight: "Claro",
	schemeDark: "Escuro",
	discardedToast: "Tema vazio descartado.",
	galleryButtons: "Botões",
	galleryForms: "Controles de formulário",
	galleryFeedback: "Feedback e dados",
	gallerySurfaces: "Superfícies",
	blockStats: "Indicadores",
	blockSettings: "Configurações",
	blockEmpty: "Estado vazio",
	blockTable: "Registros",
	colStatus: "Status",
	colColor: "Cor",
	contrastColPairing: "Par",
	contrastColRatio: "Razão",
	contrastColMin: "Mín",
	tokenRefTitle: "Referência de tokens",
	tokenRefDesc: (scheme) => `propriedades customizadas — ${scheme}`,
	tokenColToken: "Token",
	tokenColValue: "Valor",
	tokenColSwatch: "Amostra",
	radiusTitle: (radius) => `Raio — ${radius}`,
	radiusCurrent: "tema",
	galleryBtnDefault: "Padrão",
	galleryBtnSecondary: "Secundário",
	galleryBtnOutline: "Contorno",
	galleryBtnGhost: "Fantasma",
	galleryBtnDestructive: "Destrutivo",
	galleryBtnLink: "Link",
	galleryBtnSmall: "Pequeno",
	galleryBtnLarge: "Grande",
	galleryBtnDisabled: "Desativado",
	galleryInputLabel: "Campo de texto",
	galleryInputPlaceholder: "Texto de placeholder",
	galleryTextareaLabel: "Área de texto",
	galleryTextareaPlaceholder: "Conteúdo mais longo…",
	gallerySelectLabel: "Controle de seleção nativo estilizado",
	galleryOptionA: "Opção A",
	galleryOptionB: "Opção B",
	galleryOptionOne: "Opção um",
	galleryOptionTwo: "Opção dois",
	gallerySwitchNotifications: "Notificações",
	gallerySwitchMarketing: "E-mails de marketing",
	galleryAlertOkTitle: "Atenção",
	galleryAlertOkDesc: "Suas alterações foram aplicadas ao tema em rascunho.",
	galleryAlertFailTitle: "Algo falhou",
	galleryAlertFailDesc: "A razão de contraste está abaixo de AA para este par.",
	gallerySurfaceTeam: "Equipe da plataforma",
	gallerySurfaceRole: "Admin",
	gallerySurfaceMuted:
		"Superfície suave — cards, separadores e preenchimentos suaves usam os tokens do rascunho.",
	galleryStatActive: "Temas ativos",
	galleryStatAssets: "Assets prontos",
	galleryStatContrast: "Falhas de contraste",
	gallerySettingsName: "Nome de exibição",
	gallerySettingsDesc: "Descrição",
	gallerySettingsDescValue: "Tema white-label para o shell da plataforma.",
	gallerySettingsEnabled: "Ativado",
	gallerySettingsHighContrast: "Alto contraste",
	gallerySettingsSave: "Salvar alterações",
	gallerySettingsReset: "Redefinir",
	galleryEmptyTitle: "Nenhum tema ainda",
	galleryEmptyDesc: "Crie um tema para começar a personalizar o shell da plataforma.",
	galleryStatusReady: "Pronto",
	galleryStatusDraft: "Rascunho",
	fontSampleHeading: "Aa — Título de destaque",
	fontSampleSans: "Aa — Texto de corpo, botões e campos",
	fontSampleMono: "Aa — Código e identificadores",
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
	fontsSourcesLabel: "Fuentes gestionadas",
	fontSourceLabel: "Fuente gestionada",
	fontSourceCustom: "Personalizada (texto libre)",
	fontSourceSearchPlaceholder: "Buscar proveedor o familia…",
	fontSourceNoResults: "Ninguna fuente coincide con la búsqueda.",
	fontSans: "Sans",
	fontHeading: "Títulos",
	fontMono: "Mono",
	fontPreviewLabel: "Vista previa de fuentes",
	fontPreviewText: "El veloz murciélago hindú comía feliz cardillo y kiwi",
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
	badgeMain: "Principal",
	setMain: "Establecer como principal",
	mainSet: "Tema principal actualizado",
	deleteTheme: "Eliminar",
	deleteConfirm: "¿Eliminar este tema? Esta acción no se puede deshacer.",
	deleteError: "No se pudo eliminar el tema",
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
	schemeLabel: "Apariencia",
	schemeSystem: "Sistema",
	searchPlaceholder: "Buscar por nombre, ámbito o id…",
	searchLabel: "Buscar temas",
	newTheme: "Nuevo tema",
	filteredCount: (shown, total) => `${shown} de ${total} temas`,
	noResults: "Ningún tema coincide con la búsqueda.",
	dialogCreateTitle: "Nuevo tema",
	dialogEditTitle: "Editar tema",
	tabGeneral: "General",
	tabColors: "Colores",
	tabTypography: "Tipografía",
	tabAssets: "Marca y assets",
	cancel: "Cancelar",
	assetsNeedSave: "Guarde el tema una vez para habilitar las subidas de assets.",
	assetsListTitle: "Assets subidos",
	assetsEmpty: "Aún no hay assets subidos.",
	assetKindLogoLight: "Logo (claro)",
	assetKindLogoDark: "Logo (oscuro)",
	assetKindWordmark: "Wordmark",
	assetKindFavicon: "Favicon",
	assetKindOgImage: "Imagen OG",
	assetKindFont: "Archivo de fuente",
	assetFontUpload: "Subir fuente",
	assetStatusPending: "Pendiente",
	assetStatusReady: "Listo",
	assetStatusFailed: "Falló",
	assetGoogleFamily: "Familia de Google Fonts",
	assetGoogleSlot: "Espacio de Google Fonts",
	brandRefsTitle: "Referencias de marca actuales",
	editorBack: "Volver a los temas",
	editorThemeLabel: "Tema",
	editorNotFound: "Tema no encontrado — puede que haya sido eliminado.",
	dirtyBadge: "Cambios sin guardar",
	tabTokens: "Tokens",
	tabComponents: "Componentes",
	tabBlocks: "Bloques",
	tokensTitle: "Tokens de diseño",
	tokensDescription: "Propiedades CSS personalizadas derivadas para ambos esquemas.",
	componentsTitle: "Componentes",
	componentsDescription: "Componentes del design system renderizados con el tema en borrador.",
	blocksTitle: "Bloques",
	blocksDescription: "Bloques compuestos renderizados con el tema en borrador.",
	schemeLight: "Claro",
	schemeDark: "Oscuro",
	discardedToast: "Tema vacío descartado.",
	galleryButtons: "Botones",
	galleryForms: "Controles de formulario",
	galleryFeedback: "Comentarios y datos",
	gallerySurfaces: "Superficies",
	blockStats: "Indicadores",
	blockSettings: "Ajustes",
	blockEmpty: "Estado vacío",
	blockTable: "Registros",
	colStatus: "Estado",
	colColor: "Color",
	contrastColPairing: "Par",
	contrastColRatio: "Ratio",
	contrastColMin: "Mín",
	tokenRefTitle: "Referencia de tokens",
	tokenRefDesc: (scheme) => `propiedades personalizadas — ${scheme}`,
	tokenColToken: "Token",
	tokenColValue: "Valor",
	tokenColSwatch: "Muestra",
	radiusTitle: (radius) => `Radio — ${radius}`,
	radiusCurrent: "tema",
	galleryBtnDefault: "Predeterminado",
	galleryBtnSecondary: "Secundario",
	galleryBtnOutline: "Contorno",
	galleryBtnGhost: "Fantasma",
	galleryBtnDestructive: "Destructivo",
	galleryBtnLink: "Enlace",
	galleryBtnSmall: "Pequeño",
	galleryBtnLarge: "Grande",
	galleryBtnDisabled: "Desactivado",
	galleryInputLabel: "Campo de texto",
	galleryInputPlaceholder: "Texto de placeholder",
	galleryTextareaLabel: "Área de texto",
	galleryTextareaPlaceholder: "Contenido más largo…",
	gallerySelectLabel: "Control de selección nativo estilizado",
	galleryOptionA: "Opción A",
	galleryOptionB: "Opción B",
	galleryOptionOne: "Opción uno",
	galleryOptionTwo: "Opción dos",
	gallerySwitchNotifications: "Notificaciones",
	gallerySwitchMarketing: "Correos de marketing",
	galleryAlertOkTitle: "Atención",
	galleryAlertOkDesc: "Tus cambios se aplicaron al tema en borrador.",
	galleryAlertFailTitle: "Algo falló",
	galleryAlertFailDesc: "La razón de contraste está por debajo de AA para este par.",
	gallerySurfaceTeam: "Equipo de la plataforma",
	gallerySurfaceRole: "Admin",
	gallerySurfaceMuted:
		"Superficie atenuada — las tarjetas, separadores y rellenos toman los tokens del borrador.",
	galleryStatActive: "Temas activos",
	galleryStatAssets: "Assets listos",
	galleryStatContrast: "Fallos de contraste",
	gallerySettingsName: "Nombre visible",
	gallerySettingsDesc: "Descripción",
	gallerySettingsDescValue: "Tema white-label para el shell de la plataforma.",
	gallerySettingsEnabled: "Activado",
	gallerySettingsHighContrast: "Alto contraste",
	gallerySettingsSave: "Guardar cambios",
	gallerySettingsReset: "Restablecer",
	galleryEmptyTitle: "Aún no hay temas",
	galleryEmptyDesc: "Crea un tema para empezar a personalizar el shell de la plataforma.",
	galleryStatusReady: "Listo",
	galleryStatusDraft: "Borrador",
	fontSampleHeading: "Aa — Título destacado",
	fontSampleSans: "Aa — Texto de cuerpo, botones y campos",
	fontSampleMono: "Aa — Código e identificadores",
};

const CATALOGS: Record<ThemeLocale, ThemeMessages> = { en, "pt-BR": ptBR, es };

export const isThemeLocale = (locale: string): locale is ThemeLocale =>
	(THEME_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const themeMessages = (locale: string): ThemeMessages =>
	CATALOGS[isThemeLocale(locale) ? locale : BASE_LOCALE];
