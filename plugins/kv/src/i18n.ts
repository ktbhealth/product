/**
 * KV admin console copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the page ctx and the view resolves its
 * strings here. A locale catalog must implement `KvMessages` in full
 * — a missing key is a type error, not an English fallback.
 */

import { paramMessage } from "@ktb/i18n";

export const KV_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "kv";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): KvMessages => kvMessages(locale);
export type KvLocale = (typeof KV_LOCALES)[number];
const BASE_LOCALE: KvLocale = "en";

export interface KvMessages {
	readonly title: string;
	readonly description: string;
	readonly newEntry: string;
	readonly edit: string;
	readonly delete: string;
	readonly save: string;
	readonly cancel: string;
	readonly create: string;
	readonly saving: string;
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	readonly loadFailed: string;
	readonly saveFailed: string;
	readonly invalidJson: string;
	readonly invalidTtl: string;
	readonly conflict: string;
	readonly searchPlaceholder: string;
	readonly allNamespaces: string;
	readonly namespacesTitle: string;
	readonly totalCount: (n: number) => string;
	readonly pageInfo: (page: number, pages: number) => string;
	readonly previous: string;
	readonly next: string;
	readonly colKey: string;
	readonly colNamespace: string;
	readonly colScope: string;
	readonly colValue: string;
	readonly colExpiry: string;
	readonly colVersion: string;
	readonly colActions: string;
	readonly scopeGlobal: string;
	readonly scopeTenant: (id: number) => string;
	readonly scopeOwner: (id: string) => string;
	readonly statusExpired: string;
	readonly statusNoExpiry: string;
	readonly expiresIn: (ms: number) => string;
	readonly fieldNamespace: string;
	readonly fieldKey: string;
	readonly fieldTenantId: string;
	readonly fieldOwnerId: string;
	readonly fieldValue: string;
	readonly fieldTtl: string;
	readonly ttlKeep: string;
	readonly ttlNone: string;
	readonly ttlCustom: string;
	readonly ttlSeconds: string;
	readonly fieldVersion: string;
	readonly scopeHint: string;
	readonly valueHint: string;
	readonly deleteTitle: string;
	readonly deleteBody: (key: string) => string;
	readonly deleteConfirm: string;
}

const en: KvMessages = {
	title: "Key-value store",
	description: "Browse and manage TTL'd namespaced key/value entries.",
	newEntry: "New entry",
	edit: "Edit",
	delete: "Delete",
	save: "Save",
	cancel: "Cancel",
	create: "Create",
	saving: "Saving…",
	emptyTitle: "No entries found",
	emptyDescription: "Adjust the filters or create the first entry.",
	loadFailed: "Could not load entries. Try again.",
	saveFailed: "Could not save the entry. Try again.",
	invalidJson: "Value must be valid JSON.",
	invalidTtl: "TTL must be a positive number of seconds.",
	conflict: "This entry changed since you loaded it — reload and try again.",
	searchPlaceholder: "Filter by key prefix…",
	allNamespaces: "All namespaces",
	namespacesTitle: "Namespaces",
	totalCount: (n) => `${n} ${n === 1 ? "entry" : "entries"}`,
	pageInfo: (page, pages) => `Page ${page} of ${pages}`,
	previous: "Previous",
	next: "Next",
	colKey: "Key",
	colNamespace: "Namespace",
	colScope: "Scope",
	colValue: "Value",
	colExpiry: "Expiry",
	colVersion: "Ver",
	colActions: "Actions",
	scopeGlobal: "Global",
	scopeTenant: (id) => `Tenant #${id}`,
	scopeOwner: (id) => `User ${id}`,
	statusExpired: "Expired",
	statusNoExpiry: "No expiry",
	expiresIn: (ms) => {
		const s = Math.max(0, Math.ceil(ms / 1000));
		if (s < 60) return `in ${s}s`;
		const m = Math.ceil(s / 60);
		if (m < 60) return `in ${m}m`;
		const h = Math.ceil(m / 60);
		if (h < 48) return `in ${h}h`;
		return `in ${Math.ceil(h / 24)}d`;
	},
	fieldNamespace: "Namespace",
	fieldKey: "Key",
	fieldTenantId: "Tenant ID (optional)",
	fieldOwnerId: "Owner ID (optional)",
	fieldValue: "Value (JSON)",
	fieldTtl: "TTL",
	ttlKeep: "Keep current",
	ttlNone: "No expiry",
	ttlCustom: "Custom",
	ttlSeconds: "Seconds",
	fieldVersion: "Version",
	scopeHint: "Leave both empty for a global entry. Tenant ID wins over Owner ID.",
	valueHint: "Must be valid JSON — objects, arrays, strings, numbers, booleans, null.",
	deleteTitle: "Delete entry",
	deleteBody: paramMessage("en", 'Delete "{key}"? This cannot be undone.', ["key"]),
	deleteConfirm: "Delete",
};

const ptBR: KvMessages = {
	title: "Armazenamento chave-valor",
	description: "Navegue e gerencie entradas chave/valor nomeadas com TTL.",
	newEntry: "Nova entrada",
	edit: "Editar",
	delete: "Excluir",
	save: "Salvar",
	cancel: "Cancelar",
	create: "Criar",
	saving: "Salvando…",
	emptyTitle: "Nenhuma entrada encontrada",
	emptyDescription: "Ajuste os filtros ou crie a primeira entrada.",
	loadFailed: "Não foi possível carregar as entradas. Tente novamente.",
	saveFailed: "Não foi possível salvar a entrada. Tente novamente.",
	invalidJson: "O valor deve ser um JSON válido.",
	invalidTtl: "O TTL deve ser um número positivo de segundos.",
	conflict: "Esta entrada mudou desde que você a carregou — recarregue e tente novamente.",
	searchPlaceholder: "Filtrar por prefixo da chave…",
	allNamespaces: "Todos os namespaces",
	namespacesTitle: "Namespaces",
	totalCount: (n) => `${n} ${n === 1 ? "entrada" : "entradas"}`,
	pageInfo: (page, pages) => `Página ${page} de ${pages}`,
	previous: "Anterior",
	next: "Próxima",
	colKey: "Chave",
	colNamespace: "Namespace",
	colScope: "Escopo",
	colValue: "Valor",
	colExpiry: "Expiração",
	colVersion: "Ver",
	colActions: "Ações",
	scopeGlobal: "Global",
	scopeTenant: (id) => `Tenant #${id}`,
	scopeOwner: (id) => `Usuário ${id}`,
	statusExpired: "Expirada",
	statusNoExpiry: "Sem expiração",
	expiresIn: (ms) => {
		const s = Math.max(0, Math.ceil(ms / 1000));
		if (s < 60) return `em ${s}s`;
		const m = Math.ceil(s / 60);
		if (m < 60) return `em ${m}m`;
		const h = Math.ceil(m / 60);
		if (h < 48) return `em ${h}h`;
		return `em ${Math.ceil(h / 24)}d`;
	},
	fieldNamespace: "Namespace",
	fieldKey: "Chave",
	fieldTenantId: "ID do tenant (opcional)",
	fieldOwnerId: "ID do proprietário (opcional)",
	fieldValue: "Valor (JSON)",
	fieldTtl: "TTL",
	ttlKeep: "Manter atual",
	ttlNone: "Sem expiração",
	ttlCustom: "Personalizado",
	ttlSeconds: "Segundos",
	fieldVersion: "Versão",
	scopeHint:
		"Deixe ambos vazios para uma entrada global. O ID do tenant tem precedência sobre o do proprietário.",
	valueHint: "Deve ser um JSON válido — objetos, arrays, strings, números, booleanos, null.",
	deleteTitle: "Excluir entrada",
	deleteBody: paramMessage("pt-BR", 'Excluir "{key}"? Esta ação não pode ser desfeita.', ["key"]),
	deleteConfirm: "Excluir",
};

const es: KvMessages = {
	title: "Almacén clave-valor",
	description: "Explora y gestiona entradas clave/valor con nombrespacio y TTL.",
	newEntry: "Nueva entrada",
	edit: "Editar",
	delete: "Eliminar",
	save: "Guardar",
	cancel: "Cancelar",
	create: "Crear",
	saving: "Guardando…",
	emptyTitle: "No se encontraron entradas",
	emptyDescription: "Ajusta los filtros o crea la primera entrada.",
	loadFailed: "No se pudieron cargar las entradas. Inténtalo de nuevo.",
	saveFailed: "No se pudo guardar la entrada. Inténtalo de nuevo.",
	invalidJson: "El valor debe ser un JSON válido.",
	invalidTtl: "El TTL debe ser un número positivo de segundos.",
	conflict: "Esta entrada cambió desde que la cargaste — recarga e inténtalo de nuevo.",
	searchPlaceholder: "Filtrar por prefijo de clave…",
	allNamespaces: "Todos los namespaces",
	namespacesTitle: "Namespaces",
	totalCount: (n) => `${n} ${n === 1 ? "entrada" : "entradas"}`,
	pageInfo: (page, pages) => `Página ${page} de ${pages}`,
	previous: "Anterior",
	next: "Siguiente",
	colKey: "Clave",
	colNamespace: "Namespace",
	colScope: "Ámbito",
	colValue: "Valor",
	colExpiry: "Expiración",
	colVersion: "Ver",
	colActions: "Acciones",
	scopeGlobal: "Global",
	scopeTenant: (id) => `Tenant #${id}`,
	scopeOwner: (id) => `Usuario ${id}`,
	statusExpired: "Expirada",
	statusNoExpiry: "Sin expiración",
	expiresIn: (ms) => {
		const s = Math.max(0, Math.ceil(ms / 1000));
		if (s < 60) return `en ${s}s`;
		const m = Math.ceil(s / 60);
		if (m < 60) return `en ${m}m`;
		const h = Math.ceil(m / 60);
		if (h < 48) return `en ${h}h`;
		return `en ${Math.ceil(h / 24)}d`;
	},
	fieldNamespace: "Namespace",
	fieldKey: "Clave",
	fieldTenantId: "ID de tenant (opcional)",
	fieldOwnerId: "ID de propietario (opcional)",
	fieldValue: "Valor (JSON)",
	fieldTtl: "TTL",
	ttlKeep: "Mantener actual",
	ttlNone: "Sin expiración",
	ttlCustom: "Personalizado",
	ttlSeconds: "Segundos",
	fieldVersion: "Versión",
	scopeHint:
		"Deja ambos vacíos para una entrada global. El ID de tenant tiene prioridad sobre el de propietario.",
	valueHint: "Debe ser un JSON válido — objetos, arrays, strings, números, booleanos, null.",
	deleteTitle: "Eliminar entrada",
	deleteBody: paramMessage("es", '¿Eliminar "{key}"? Esta acción no se puede deshacer.', ["key"]),
	deleteConfirm: "Eliminar",
};

const CATALOGS: Record<KvLocale, KvMessages> = { en, "pt-BR": ptBR, es };

export const isKvLocale = (locale: string): locale is KvLocale =>
	(KV_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const kvMessages = (locale: string | undefined): KvMessages =>
	CATALOGS[isKvLocale(locale ?? "") ? (locale as KvLocale) : BASE_LOCALE];
