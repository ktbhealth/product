/**
 * Error-page plugin copy, one typed catalog per locale — same contract
 * as plugins/views/src/i18n.ts: plugins cannot import the host's
 * Paraglide output, so the boundary resolves strings here from the
 * active locale (BoundaryContext.locale). A locale catalog must
 * implement `ErrorPageMessages` in full. The surface is documentation-
 * only: friendly localized copy, never a stack trace (T-021).
 */

export const ERROR_PAGE_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). Derived
 * from the plugin id `error-page.boundary` → `error-page`. */
export const I18N_NAMESPACE = "error-page";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): ErrorPageMessages => errorPageMessages(locale);
export type ErrorPageLocale = (typeof ERROR_PAGE_LOCALES)[number];

export interface ErrorPageMessages {
	/** Heading of the error surface. */
	readonly title: string;
	/** Supporting line under the heading. */
	readonly body: string;
	/** Label of the retry button — calls the host-injected `reset`. */
	readonly retry: string;
}

const en: ErrorPageMessages = {
	title: "Something went wrong",
	body: "An unexpected error occurred. You can try again.",
	retry: "Try again",
};

const ptBR: ErrorPageMessages = {
	title: "Algo deu errado",
	body: "Ocorreu um erro inesperado. Você pode tentar novamente.",
	retry: "Tentar novamente",
};

const es: ErrorPageMessages = {
	title: "Algo salió mal",
	body: "Ocurrió un error inesperado. Puedes intentarlo de nuevo.",
	retry: "Reintentar",
};

const CATALOGS: Record<ErrorPageLocale, ErrorPageMessages> = { en, "pt-BR": ptBR, es };

/** Resolve the messages catalog for `locale`; unknown locales fall
 * back to the base locale (en). */
export const errorPageMessages = (locale: string): ErrorPageMessages =>
	CATALOGS[locale as ErrorPageLocale] ?? en;
