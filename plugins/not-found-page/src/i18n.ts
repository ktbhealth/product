/**
 * Not-found-page plugin copy, one typed catalog per locale. Plugins
 * cannot import the host's Paraglide output (arch lint), so the host
 * passes the active locale through `BoundaryContext.locale` and the
 * boundary resolves its strings here. A locale catalog must implement
 * `NotFoundPageMessages` in full — a missing key is a type error, not
 * an English fallback at runtime. Copy stays documentation-only (T-021).
 */

/** Locales with a catalog; the host asserts it covers every app locale. */
export const NOT_FOUND_PAGE_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). The plugin
 * id is `not-found-page.boundary` — the namespace is the id minus its
 * last segment. */
export const I18N_NAMESPACE = "not-found-page";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): NotFoundPageMessages =>
	notFoundPageMessages(locale);
export type NotFoundPageLocale = (typeof NOT_FOUND_PAGE_LOCALES)[number];
export const BASE_LOCALE: NotFoundPageLocale = "en";

export interface NotFoundPageMessages {
	readonly title: string;
	readonly body: string;
}

const en: NotFoundPageMessages = {
	title: "Page not found",
	body: "The address does not exist or the page is not available to you.",
};

const ptBR: NotFoundPageMessages = {
	title: "Página não encontrada",
	body: "O endereço não existe ou a página não está disponível para você.",
};

const es: NotFoundPageMessages = {
	title: "Página no encontrada",
	body: "La dirección no existe o la página no está disponible para ti.",
};

const CATALOGS: Record<NotFoundPageLocale, NotFoundPageMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isNotFoundPageLocale = (locale: string): locale is NotFoundPageLocale =>
	(NOT_FOUND_PAGE_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const notFoundPageMessages = (locale: string): NotFoundPageMessages =>
	CATALOGS[isNotFoundPageLocale(locale) ? locale : BASE_LOCALE];
