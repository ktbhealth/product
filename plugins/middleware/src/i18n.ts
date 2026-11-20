import { paramMessage } from "@ktb/i18n";

/**
 * Middleware plugin copy, one typed catalog per locale — same contract
 * as the other console plugins (plugins cannot import the host's
 * Paraglide output; views resolve strings from the injected i18n
 * slice with this catalog as fallback).
 */
export const MIDDLEWARE_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "middleware";

/** Locale→merged messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): Record<string, unknown> => ({
	...middlewareMessages(locale),
});

export type MiddlewareLocale = (typeof MIDDLEWARE_LOCALES)[number];
export const BASE_LOCALE: MiddlewareLocale = "en";

export interface MiddlewareMessages {
	readonly title: string;
	readonly description: string;
	readonly stagesTitle: string;
	readonly stagesDescription: string;
	readonly colOrder: string;
	readonly colId: string;
	readonly colPlugin: string;
	readonly colOrigin: string;
	readonly colScope: string;
	readonly colEnabled: string;
	readonly originBuiltin: string;
	readonly originPlugin: string;
	readonly scopeAll: string;
	readonly enabled: string;
	readonly disabled: string;
	readonly routesTitle: string;
	readonly routesDescription: string;
	readonly colRoute: string;
	readonly colContext: string;
	readonly colChain: string;
	readonly chainEmpty: string;
	readonly unavailableTitle: string;
	readonly unavailableDescription: string;
	readonly stageCount: (n: number) => string;
	readonly routeCount: (n: number) => string;
}

const en: MiddlewareMessages = {
	title: "Middleware",
	description:
		"The ordered request pipeline: every stage that runs on a page dispatch, in run order, with the routes each one applies to.",
	stagesTitle: "Stages",
	stagesDescription:
		"Collected from plugin `middleware` contributions plus host built-ins. Read-only — ordering and scope are declared in code.",
	colOrder: "Order",
	colId: "Stage",
	colPlugin: "Plugin",
	colOrigin: "Origin",
	colScope: "Scope",
	colEnabled: "Enabled",
	originBuiltin: "builtin",
	originPlugin: "plugin",
	scopeAll: "all requests",
	enabled: "Enabled",
	disabled: "Disabled",
	routesTitle: "Per-route chains",
	routesDescription:
		"The effective stage chain each registered page route runs — enabled stages whose scope claims the route, in run order.",
	colRoute: "Route",
	colContext: "Context",
	colChain: "Chain",
	chainEmpty: "—",
	unavailableTitle: "Registry unavailable",
	unavailableDescription: "The middleware registry could not be read in this environment.",
	stageCount: paramMessage("en", "{n, plural, =1{{n} stage} other{{n} stages}}", ["n"]),
	routeCount: paramMessage("en", "{n, plural, =1{{n} route} other{{n} routes}}", ["n"]),
};

const ptBR: MiddlewareMessages = {
	title: "Middleware",
	description:
		"O pipeline de requisições ordenado: cada estágio executado no dispatch de página, em ordem de execução, com as rotas às quais se aplica.",
	stagesTitle: "Estágios",
	stagesDescription:
		"Coletados das contribuições `middleware` dos plugins mais os built-ins do host. Somente leitura — ordem e escopo são declarados em código.",
	colOrder: "Ordem",
	colId: "Estágio",
	colPlugin: "Plugin",
	colOrigin: "Origem",
	colScope: "Escopo",
	colEnabled: "Ativo",
	originBuiltin: "built-in",
	originPlugin: "plugin",
	scopeAll: "todas as requisições",
	enabled: "Ativo",
	disabled: "Inativo",
	routesTitle: "Cadeias por rota",
	routesDescription:
		"A cadeia efetiva de estágios que cada rota de página registrada executa — estágios ativos cujo escopo reivindica a rota, em ordem de execução.",
	colRoute: "Rota",
	colContext: "Contexto",
	colChain: "Cadeia",
	chainEmpty: "—",
	unavailableTitle: "Registro indisponível",
	unavailableDescription: "O registro de middleware não pôde ser lido neste ambiente.",
	stageCount: paramMessage("pt-BR", "{n, plural, =1{{n} estágio} other{{n} estágios}}", ["n"]),
	routeCount: paramMessage("pt-BR", "{n, plural, =1{{n} rota} other{{n} rotas}}", ["n"]),
};

const es: MiddlewareMessages = {
	title: "Middleware",
	description:
		"La canalización de peticiones ordenada: cada etapa que se ejecuta en el dispatch de página, en orden de ejecución, con las rutas a las que aplica.",
	stagesTitle: "Etapas",
	stagesDescription:
		"Recopiladas de las contribuciones `middleware` de los plugins más las built-in del host. Solo lectura — el orden y el alcance se declaran en código.",
	colOrder: "Orden",
	colId: "Etapa",
	colPlugin: "Plugin",
	colOrigin: "Origen",
	colScope: "Alcance",
	colEnabled: "Activo",
	originBuiltin: "built-in",
	originPlugin: "plugin",
	scopeAll: "todas las peticiones",
	enabled: "Activo",
	disabled: "Inactivo",
	routesTitle: "Cadenas por ruta",
	routesDescription:
		"La cadena efectiva de etapas que ejecuta cada ruta de página registrada — etapas activas cuyo alcance reclama la ruta, en orden de ejecución.",
	colRoute: "Ruta",
	colContext: "Contexto",
	colChain: "Cadena",
	chainEmpty: "—",
	unavailableTitle: "Registro no disponible",
	unavailableDescription: "El registro de middleware no se pudo leer en este entorno.",
	stageCount: paramMessage("es", "{n, plural, =1{{n} etapa} other{{n} etapas}}", ["n"]),
	routeCount: paramMessage("es", "{n, plural, =1{{n} ruta} other{{n} rutas}}", ["n"]),
};

const CATALOGS: Record<MiddlewareLocale, MiddlewareMessages> = { en, "pt-BR": ptBR, es };

export const isMiddlewareLocale = (locale: string): locale is MiddlewareLocale =>
	(MIDDLEWARE_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const middlewareMessages = (locale: string): MiddlewareMessages =>
	CATALOGS[isMiddlewareLocale(locale) ? locale : BASE_LOCALE];
