/**
 * i18n admin plugin copy, one typed catalog per locale — the console
 * eats its own dog food. Plugins cannot import the host's Paraglide
 * output (arch lint); the host injects the active locale
 * (`ctx.locale` on pages, `getLocale()` in fns) and copy resolves
 * here. A locale catalog must implement `I18nAdminMessages` in full —
 * a missing key is a type error, not an English fallback at runtime.
 */

import { paramMessage } from "@ktb/i18n";

export const I18N_ADMIN_LOCALES = ["en", "pt-BR", "es"] as const;
export type I18nAdminLocale = (typeof I18N_ADMIN_LOCALES)[number];
export const BASE_LOCALE: I18nAdminLocale = "en";

export interface I18nAdminMessages {
	readonly common: {
		readonly global: string;
		readonly tenant: string;
		readonly portal: string;
		readonly draft: string;
		readonly missing: string;
		readonly disabled: string;
		readonly loading: string;
		readonly denied: string;
		readonly cancel: string;
		readonly publish: string;
		readonly discard: string;
	};
	/** /platform/i18n/messages — the key×locale matrix. */
	readonly messages: {
		readonly title: string;
		readonly description: string;
		readonly exportBtn: string;
		readonly importBtn: string;
		readonly colKey: string;
		readonly scopeIdPortal: string;
		readonly scopeIdTenant: string;
		readonly emptyEnterScopeId: (scope: string) => string;
		readonly emptyNone: string;
		readonly editCell: (key: string, locale: string) => string;
		readonly kindText: string;
		readonly kindRich: string;
		readonly draftPending: string;
		readonly compareWith: string;
		readonly compareNone: string;
		readonly compareEmpty: (locale: string) => string;
		readonly editorRichAria: string;
		readonly previewRichAria: string;
		readonly lintLiveValue: string;
		readonly lintLocaleLive: (locale: string) => string;
		readonly paramMismatch: (label: string, detail: string) => string;
		readonly lintExtra: (params: string) => string;
		readonly lintMissing: (params: string) => string;
		readonly discardDraft: string;
		readonly saveDraft: string;
		readonly discardTitle: string;
		readonly discardDesc: string;
		readonly discardConfirm: string;
		readonly discardKeep: string;
		readonly importTitle: (namespace: string) => string;
		readonly importDesc: (locales: number, keys: number, entries: number) => string;
		readonly importConfirm: string;
		readonly importNotice: (entries: number, namespace: string) => string;
		readonly exportDenied: string;
		readonly importDenied: string;
		readonly invalidJson: string;
	};
	/** /platform/i18n/locales — locale toggles + fallback chains. */
	readonly locales: {
		readonly title: string;
		readonly description: string;
		readonly colLocale: string;
		readonly colCode: string;
		readonly colFallbacks: string;
		readonly colEnabled: string;
		readonly toggle: (code: string) => string;
		readonly empty: string;
		readonly noticeEnabled: (code: string) => string;
		readonly noticeDisabled: (code: string) => string;
		readonly toggleDenied: (code: string) => string;
	};
	/** /platform/i18n/drafts — staged edits awaiting publish. */
	readonly drafts: {
		readonly title: string;
		readonly description: string;
		readonly filter: string;
		readonly selectAll: string;
		readonly selectRow: (label: string) => string;
		readonly colKey: string;
		readonly colLocale: string;
		readonly colScope: string;
		readonly colLive: string;
		readonly colDraft: string;
		readonly colUpdated: string;
		readonly publishSelected: (count: number) => string;
		readonly discardSelected: (count: number) => string;
		readonly discardTitle: (count: number) => string;
		readonly discardDesc: string;
		readonly empty: string;
		readonly noMatch: string;
		readonly noticePublished: (label: string) => string;
		readonly noticeDiscarded: (label: string) => string;
		readonly bulkOk: (verb: string, count: number) => string;
		readonly bulkPartial: (verb: string, ok: number, failed: number, errorSuffix: string) => string;
		readonly verbPublished: string;
		readonly verbDiscarded: string;
	};
	/** /platform/i18n/namespaces — per-locale coverage matrix. */
	readonly namespaces: {
		readonly title: string;
		readonly description: string;
		readonly summary: (namespaces: number, keys: number, locales: number) => string;
		readonly summaryDrift: (namespaces: number) => string;
		readonly search: string;
		readonly filterIncomplete: string;
		readonly sortName: string;
		readonly sortWorst: string;
		readonly sortKeys: string;
		readonly colNamespace: string;
		readonly colPlugin: string;
		readonly colDefaultLocale: string;
		readonly colKeys: string;
		readonly driftBadge: string;
		readonly cellMissing: (count: number) => string;
		readonly showMissing: (count: number, namespace: string, locale: string) => string;
		readonly empty: string;
		readonly noMatch: string;
		readonly missingDesc: (locale: string) => string;
		readonly allTranslated: string;
	};
}

const en: I18nAdminMessages = {
	common: {
		global: "global",
		tenant: "tenant",
		portal: "portal",
		draft: "draft",
		missing: "missing",
		disabled: "disabled",
		loading: "Loading…",
		denied: "denied",
		cancel: "Cancel",
		publish: "Publish",
		discard: "Discard",
	},
	messages: {
		title: "Messages",
		description: "DB-canonical UI copy — edits stage as drafts until published.",
		exportBtn: "Export",
		importBtn: "Import",
		colKey: "Key",
		scopeIdPortal: "portal instance id",
		scopeIdTenant: "tenant id",
		emptyEnterScopeId: paramMessage("en", "Enter a {scope} id to load scoped messages.", ["scope"]),
		emptyNone: "No messages in this namespace yet.",
		editCell: paramMessage("en", "Edit {key} in {locale}", ["key", "locale"]),
		kindText: "text",
		kindRich: "rich",
		draftPending: "draft pending",
		compareWith: "Compare with",
		compareNone: "None",
		compareEmpty: paramMessage("en", "No translation for {locale}.", ["locale"]),
		editorRichAria: "Message rich text",
		previewRichAria: "Rich text preview",
		lintLiveValue: "live value",
		lintLocaleLive: paramMessage("en", "{locale} live value", ["locale"]),
		paramMismatch: paramMessage("en", "Param mismatch vs {label}: {detail}", ["label", "detail"]),
		lintExtra: paramMessage("en", "extra: {params}", ["params"]),
		lintMissing: paramMessage("en", "missing: {params}", ["params"]),
		discardDraft: "Discard draft",
		saveDraft: "Save draft",
		discardTitle: "Discard unsaved changes?",
		discardDesc: "The edits in this dialog haven't been saved as a draft.",
		discardConfirm: "Discard",
		discardKeep: "Keep editing",
		importTitle: paramMessage("en", 'Import into "{namespace}"?', ["namespace"]),
		importDesc: paramMessage(
			"en",
			"{locales} locales · {keys} keys · {entries} entries. Matching keys land as drafts — nothing goes live.",
			["locales", "keys", "entries"],
		),
		importConfirm: "Import",
		importNotice: paramMessage("en", "Imported {entries} entries into {namespace}.", [
			"entries",
			"namespace",
		]),
		exportDenied: "export denied",
		importDenied: "import denied",
		invalidJson: "invalid JSON file",
	},
	locales: {
		title: "Locales",
		description: "Enabled locales and fallback chains — runtime data, no rebuild needed.",
		colLocale: "Locale",
		colCode: "Code",
		colFallbacks: "Fallbacks",
		colEnabled: "Enabled",
		toggle: paramMessage("en", "Toggle locale {code}", ["code"]),
		empty: "No locales configured.",
		noticeEnabled: paramMessage("en", "{code} enabled.", ["code"]),
		noticeDisabled: paramMessage("en", "{code} disabled.", ["code"]),
		toggleDenied: paramMessage("en", "denied toggling {code}", ["code"]),
	},
	drafts: {
		title: "Pending drafts",
		description: "Staged edits awaiting publish — nothing here is live yet.",
		filter: "Filter by namespace.key",
		selectAll: "Select all visible drafts",
		selectRow: paramMessage("en", "Select {label}", ["label"]),
		colKey: "Key",
		colLocale: "Locale",
		colScope: "Scope",
		colLive: "Live",
		colDraft: "Draft",
		colUpdated: "Updated",
		publishSelected: paramMessage("en", "Publish {count} selected", ["count"]),
		discardSelected: paramMessage("en", "Discard {count} selected", ["count"]),
		discardTitle: paramMessage(
			"en",
			"Discard {count, plural, =1{{count} draft} other{{count} drafts}}?",
			["count"],
		),
		discardDesc:
			"The selected drafts will be permanently discarded — never-published messages are deleted.",
		empty: "No pending drafts.",
		noMatch: "No pending drafts.",
		noticePublished: paramMessage("en", "Published {label}.", ["label"]),
		noticeDiscarded: paramMessage("en", "Discarded draft for {label}.", ["label"]),
		bulkOk: paramMessage("en", "{verb} {count, plural, =1{{count} draft} other{{count} drafts}}.", [
			"verb",
			"count",
		]),
		bulkPartial: paramMessage("en", "{verb} {ok}, failed {failed}{errorSuffix}.", [
			"verb",
			"ok",
			"failed",
			"errorSuffix",
		]),
		verbPublished: "Published",
		verbDiscarded: "Discarded",
	},
	namespaces: {
		title: "Namespaces",
		description:
			"Registered message namespaces and per-locale translation coverage (global scope).",
		summary: paramMessage(
			"en",
			"{namespaces, plural, =1{{namespaces} namespace} other{{namespaces} namespaces}} · {keys, plural, =1{{keys} key} other{{keys} keys}} · {locales, plural, =1{{locales} locale} other{{locales} locales}} below full coverage",
			["namespaces", "keys", "locales"],
		),
		summaryDrift: paramMessage(
			"en",
			"{namespaces, plural, =1{{namespaces} namespace} other{{namespaces} namespaces}} with contract drift",
			["namespaces"],
		),
		search: "Filter namespaces",
		filterIncomplete: "Below 100% only",
		sortName: "Sort: name",
		sortWorst: "Sort: worst coverage",
		sortKeys: "Sort: most keys",
		colNamespace: "Namespace",
		colPlugin: "Plugin",
		colDefaultLocale: "Default locale",
		colKeys: "Keys",
		driftBadge: "contract changed",
		cellMissing: paramMessage("en", "· {count} missing", ["count"]),
		showMissing: paramMessage("en", "Show {count} missing {namespace} keys for {locale}", [
			"count",
			"namespace",
			"locale",
		]),
		empty: "No namespaces registered.",
		noMatch: "No namespaces match the current filters.",
		missingDesc: paramMessage("en", "Keys with no published {locale} value.", ["locale"]),
		allTranslated: "All keys translated.",
	},
};

const ptBR: I18nAdminMessages = {
	common: {
		global: "global",
		tenant: "tenant",
		portal: "portal",
		draft: "rascunho",
		missing: "ausente",
		disabled: "desativado",
		loading: "Carregando…",
		denied: "negado",
		cancel: "Cancelar",
		publish: "Publicar",
		discard: "Descartar",
	},
	messages: {
		title: "Mensagens",
		description: "Copy de UI canônica no banco — edições viram rascunhos até serem publicadas.",
		exportBtn: "Exportar",
		importBtn: "Importar",
		colKey: "Chave",
		scopeIdPortal: "id da instância do portal",
		scopeIdTenant: "id do tenant",
		emptyEnterScopeId: paramMessage(
			"pt-BR",
			"Informe um id de {scope} para carregar mensagens do escopo.",
			["scope"],
		),
		emptyNone: "Nenhuma mensagem neste namespace ainda.",
		editCell: paramMessage("pt-BR", "Editar {key} em {locale}", ["key", "locale"]),
		kindText: "texto",
		kindRich: "rico",
		draftPending: "rascunho pendente",
		compareWith: "Comparar com",
		compareNone: "Nenhum",
		compareEmpty: paramMessage("pt-BR", "Sem tradução para {locale}.", ["locale"]),
		editorRichAria: "Texto rico da mensagem",
		previewRichAria: "Prévia do texto rico",
		lintLiveValue: "valor publicado",
		lintLocaleLive: paramMessage("pt-BR", "valor publicado em {locale}", ["locale"]),
		paramMismatch: paramMessage("pt-BR", "Divergência de parâmetros vs {label}: {detail}", [
			"label",
			"detail",
		]),
		lintExtra: paramMessage("pt-BR", "extras: {params}", ["params"]),
		lintMissing: paramMessage("pt-BR", "ausentes: {params}", ["params"]),
		discardDraft: "Descartar rascunho",
		saveDraft: "Salvar rascunho",
		discardTitle: "Descartar alterações não salvas?",
		discardDesc: "As edições deste diálogo ainda não foram salvas como rascunho.",
		discardConfirm: "Descartar",
		discardKeep: "Continuar editando",
		importTitle: paramMessage("pt-BR", 'Importar para "{namespace}"?', ["namespace"]),
		importDesc: paramMessage(
			"pt-BR",
			"{locales} locales · {keys} chaves · {entries} entradas. Chaves existentes viram rascunhos — nada vai ao ar.",
			["locales", "keys", "entries"],
		),
		importConfirm: "Importar",
		importNotice: paramMessage("pt-BR", "{entries} entradas importadas para {namespace}.", [
			"entries",
			"namespace",
		]),
		exportDenied: "exportação negada",
		importDenied: "importação negada",
		invalidJson: "arquivo JSON inválido",
	},
	locales: {
		title: "Locales",
		description: "Locales ativos e cadeias de fallback — dado de runtime, sem rebuild.",
		colLocale: "Locale",
		colCode: "Código",
		colFallbacks: "Fallbacks",
		colEnabled: "Ativo",
		toggle: paramMessage("pt-BR", "Alternar locale {code}", ["code"]),
		empty: "Nenhum locale configurado.",
		noticeEnabled: paramMessage("pt-BR", "{code} ativado.", ["code"]),
		noticeDisabled: paramMessage("pt-BR", "{code} desativado.", ["code"]),
		toggleDenied: paramMessage("pt-BR", "alternância de {code} negada", ["code"]),
	},
	drafts: {
		title: "Rascunhos pendentes",
		description: "Edições em staging aguardando publicação — nada aqui está no ar.",
		filter: "Filtrar por namespace.chave",
		selectAll: "Selecionar todos os rascunhos visíveis",
		selectRow: paramMessage("pt-BR", "Selecionar {label}", ["label"]),
		colKey: "Chave",
		colLocale: "Locale",
		colScope: "Escopo",
		colLive: "Publicado",
		colDraft: "Rascunho",
		colUpdated: "Atualizado",
		publishSelected: paramMessage("pt-BR", "Publicar {count} selecionados", ["count"]),
		discardSelected: paramMessage("pt-BR", "Descartar {count} selecionados", ["count"]),
		discardTitle: paramMessage(
			"pt-BR",
			"Descartar {count, plural, =1{{count} rascunho} other{{count} rascunhos}}?",
			["count"],
		),
		discardDesc:
			"Os rascunhos selecionados serão descartados permanentemente — mensagens nunca publicadas são excluídas.",
		empty: "Nenhum rascunho pendente.",
		noMatch: "Nenhum rascunho pendente.",
		noticePublished: paramMessage("pt-BR", "{label} publicado.", ["label"]),
		noticeDiscarded: paramMessage("pt-BR", "Rascunho de {label} descartado.", ["label"]),
		bulkOk: paramMessage(
			"pt-BR",
			"{verb} {count, plural, =1{{count} rascunho} other{{count} rascunhos}}.",
			["verb", "count"],
		),
		bulkPartial: paramMessage("pt-BR", "{verb} {ok}, falharam {failed}{errorSuffix}.", [
			"verb",
			"ok",
			"failed",
			"errorSuffix",
		]),
		verbPublished: "Publicados",
		verbDiscarded: "Descartados",
	},
	namespaces: {
		title: "Namespaces",
		description:
			"Namespaces de mensagens registrados e cobertura de tradução por locale (escopo global).",
		summary: paramMessage(
			"pt-BR",
			"{namespaces, plural, =1{{namespaces} namespace} other{{namespaces} namespaces}} · {keys, plural, =1{{keys} chave} other{{keys} chaves}} · {locales, plural, =1{{locales} locale} other{{locales} locales}} abaixo da cobertura total",
			["namespaces", "keys", "locales"],
		),
		summaryDrift: paramMessage(
			"pt-BR",
			"{namespaces, plural, =1{{namespaces} namespace} other{{namespaces} namespaces}} com divergência de contrato",
			["namespaces"],
		),
		search: "Filtrar namespaces",
		filterIncomplete: "Apenas abaixo de 100%",
		sortName: "Ordenar: nome",
		sortWorst: "Ordenar: pior cobertura",
		sortKeys: "Ordenar: mais chaves",
		colNamespace: "Namespace",
		colPlugin: "Plugin",
		colDefaultLocale: "Locale padrão",
		colKeys: "Chaves",
		driftBadge: "contrato alterado",
		cellMissing: paramMessage("pt-BR", "· {count} ausentes", ["count"]),
		showMissing: paramMessage(
			"pt-BR",
			"Mostrar {count} chaves ausentes de {namespace} em {locale}",
			["count", "namespace", "locale"],
		),
		empty: "Nenhum namespace registrado.",
		noMatch: "Nenhum namespace corresponde aos filtros atuais.",
		missingDesc: paramMessage("pt-BR", "Chaves sem valor publicado em {locale}.", ["locale"]),
		allTranslated: "Todas as chaves traduzidas.",
	},
};

const es: I18nAdminMessages = {
	common: {
		global: "global",
		tenant: "tenant",
		portal: "portal",
		draft: "borrador",
		missing: "faltante",
		disabled: "desactivado",
		loading: "Cargando…",
		denied: "denegado",
		cancel: "Cancelar",
		publish: "Publicar",
		discard: "Descartar",
	},
	messages: {
		title: "Mensajes",
		description:
			"Copy de UI canónico en la base de datos — las ediciones quedan como borradores hasta publicarse.",
		exportBtn: "Exportar",
		importBtn: "Importar",
		colKey: "Clave",
		scopeIdPortal: "id de instancia del portal",
		scopeIdTenant: "id del tenant",
		emptyEnterScopeId: paramMessage(
			"es",
			"Ingrese un id de {scope} para cargar mensajes del ámbito.",
			["scope"],
		),
		emptyNone: "Aún no hay mensajes en este namespace.",
		editCell: paramMessage("es", "Editar {key} en {locale}", ["key", "locale"]),
		kindText: "texto",
		kindRich: "enriquecido",
		draftPending: "borrador pendiente",
		compareWith: "Comparar con",
		compareNone: "Ninguno",
		compareEmpty: paramMessage("es", "Sin traducción para {locale}.", ["locale"]),
		editorRichAria: "Texto enriquecido del mensaje",
		previewRichAria: "Vista previa del texto enriquecido",
		lintLiveValue: "valor publicado",
		lintLocaleLive: paramMessage("es", "valor publicado en {locale}", ["locale"]),
		paramMismatch: paramMessage("es", "Discrepancia de parámetros vs {label}: {detail}", [
			"label",
			"detail",
		]),
		lintExtra: paramMessage("es", "extras: {params}", ["params"]),
		lintMissing: paramMessage("es", "faltantes: {params}", ["params"]),
		discardDraft: "Descartar borrador",
		saveDraft: "Guardar borrador",
		discardTitle: "¿Descartar cambios no guardados?",
		discardDesc: "Las ediciones de este diálogo aún no se guardaron como borrador.",
		discardConfirm: "Descartar",
		discardKeep: "Seguir editando",
		importTitle: paramMessage("es", '¿Importar en "{namespace}"?', ["namespace"]),
		importDesc: paramMessage(
			"es",
			"{locales} locales · {keys} claves · {entries} entradas. Las claves existentes quedan como borradores — nada sale en vivo.",
			["locales", "keys", "entries"],
		),
		importConfirm: "Importar",
		importNotice: paramMessage("es", "{entries} entradas importadas en {namespace}.", [
			"entries",
			"namespace",
		]),
		exportDenied: "exportación denegada",
		importDenied: "importación denegada",
		invalidJson: "archivo JSON inválido",
	},
	locales: {
		title: "Locales",
		description: "Locales habilitados y cadenas de fallback — dato de runtime, sin rebuild.",
		colLocale: "Locale",
		colCode: "Código",
		colFallbacks: "Fallbacks",
		colEnabled: "Activo",
		toggle: paramMessage("es", "Alternar locale {code}", ["code"]),
		empty: "No hay locales configurados.",
		noticeEnabled: paramMessage("es", "{code} activado.", ["code"]),
		noticeDisabled: paramMessage("es", "{code} desactivado.", ["code"]),
		toggleDenied: paramMessage("es", "cambio de {code} denegado", ["code"]),
	},
	drafts: {
		title: "Borradores pendientes",
		description: "Ediciones en staging esperando publicación — nada aquí está en vivo.",
		filter: "Filtrar por namespace.clave",
		selectAll: "Seleccionar todos los borradores visibles",
		selectRow: paramMessage("es", "Seleccionar {label}", ["label"]),
		colKey: "Clave",
		colLocale: "Locale",
		colScope: "Ámbito",
		colLive: "Publicado",
		colDraft: "Borrador",
		colUpdated: "Actualizado",
		publishSelected: paramMessage("es", "Publicar {count} seleccionados", ["count"]),
		discardSelected: paramMessage("es", "Descartar {count} seleccionados", ["count"]),
		discardTitle: paramMessage(
			"es",
			"¿Descartar {count, plural, =1{{count} borrador} other{{count} borradores}}?",
			["count"],
		),
		discardDesc:
			"Los borradores seleccionados se descartarán permanentemente — los mensajes nunca publicados se eliminan.",
		empty: "No hay borradores pendientes.",
		noMatch: "No hay borradores pendientes.",
		noticePublished: paramMessage("es", "{label} publicado.", ["label"]),
		noticeDiscarded: paramMessage("es", "Borrador de {label} descartado.", ["label"]),
		bulkOk: paramMessage(
			"es",
			"{verb} {count, plural, =1{{count} borrador} other{{count} borradores}}.",
			["verb", "count"],
		),
		bulkPartial: paramMessage("es", "{verb} {ok}, fallaron {failed}{errorSuffix}.", [
			"verb",
			"ok",
			"failed",
			"errorSuffix",
		]),
		verbPublished: "Publicados",
		verbDiscarded: "Descartados",
	},
	namespaces: {
		title: "Namespaces",
		description:
			"Namespaces de mensajes registrados y cobertura de traducción por locale (ámbito global).",
		summary: paramMessage(
			"es",
			"{namespaces, plural, =1{{namespaces} namespace} other{{namespaces} namespaces}} · {keys, plural, =1{{keys} clave} other{{keys} claves}} · {locales, plural, =1{{locales} locale} other{{locales} locales}} por debajo de la cobertura total",
			["namespaces", "keys", "locales"],
		),
		summaryDrift: paramMessage(
			"es",
			"{namespaces, plural, =1{{namespaces} namespace} other{{namespaces} namespaces}} con divergencia de contrato",
			["namespaces"],
		),
		search: "Filtrar namespaces",
		filterIncomplete: "Solo debajo de 100%",
		sortName: "Ordenar: nombre",
		sortWorst: "Ordenar: peor cobertura",
		sortKeys: "Ordenar: más claves",
		colNamespace: "Namespace",
		colPlugin: "Plugin",
		colDefaultLocale: "Locale por defecto",
		colKeys: "Claves",
		driftBadge: "contrato cambiado",
		cellMissing: paramMessage("es", "· {count} faltantes", ["count"]),
		showMissing: paramMessage("es", "Mostrar {count} claves faltantes de {namespace} en {locale}", [
			"count",
			"namespace",
			"locale",
		]),
		empty: "No hay namespaces registrados.",
		noMatch: "Ningún namespace coincide con los filtros actuales.",
		missingDesc: paramMessage("es", "Claves sin valor publicado en {locale}.", ["locale"]),
		allTranslated: "Todas las claves traducidas.",
	},
};

const CATALOGS: Record<I18nAdminLocale, I18nAdminMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isI18nAdminLocale = (locale: string): locale is I18nAdminLocale =>
	(I18N_ADMIN_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const i18nAdminMessages = (locale: string): I18nAdminMessages =>
	CATALOGS[isI18nAdminLocale(locale) ? locale : BASE_LOCALE];

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "i18n.admin";

/** Manifest importer entrypoint (tools/gen-i18n-manifest.mjs). */
export const i18nMessagesFor = (locale: string): I18nAdminMessages => i18nAdminMessages(locale);
