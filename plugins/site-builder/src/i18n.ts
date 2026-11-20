/**
 * Site-builder plugin copy, one typed catalog per locale — same
 * contract as plugins/builder-blocks/src/i18n.ts: plugins cannot
 * import the host's Paraglide output, so surfaces resolve strings here
 * from the active locale (PageContext.locale). A locale catalog must
 * implement `SiteBuilderMessages` in full.
 */

export const SITE_BUILDER_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "site-builder";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): SiteBuilderMessages => siteBuilderMessages(locale);

export type SiteBuilderLocale = (typeof SITE_BUILDER_LOCALES)[number];
const BASE_LOCALE: SiteBuilderLocale = "en";

export interface SiteBuilderMessages {
	/** Editor chrome. */
	readonly notFound: string;
	readonly unsavedHint: string;
	readonly saving: string;
	readonly saved: string;
	readonly saveError: string;
}

const en: SiteBuilderMessages = {
	notFound: "Nothing to edit here.",
	unsavedHint: "Publish to save changes",
	saving: "Saving…",
	saved: "Saved",
	saveError: "Save failed",
};

const ptBR: SiteBuilderMessages = {
	notFound: "Nada para editar aqui.",
	unsavedHint: "Publique para salvar as alterações",
	saving: "Salvando…",
	saved: "Salvo",
	saveError: "Falha ao salvar",
};

const es: SiteBuilderMessages = {
	notFound: "Nada que editar aquí.",
	unsavedHint: "Publica para guardar los cambios",
	saving: "Guardando…",
	saved: "Guardado",
	saveError: "Error al guardar",
};

const CATALOGS: Record<SiteBuilderLocale, SiteBuilderMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isSiteBuilderLocale = (locale: string): locale is SiteBuilderLocale =>
	(SITE_BUILDER_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const siteBuilderMessages = (locale: string | undefined): SiteBuilderMessages =>
	CATALOGS[isSiteBuilderLocale(locale ?? "") ? (locale as SiteBuilderLocale) : BASE_LOCALE];
