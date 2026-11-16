/**
 * Portal shell copy, one typed catalog per locale. The shell is a
 * plugin view — it cannot import the host's Paraglide output (arch
 * lint), so the host route injects the active locale as a prop and the
 * chrome strings resolve here. A locale catalog must implement
 * `PortalMessages` in full — a missing key is a type error, not an
 * English fallback at runtime.
 */

export const PORTAL_LOCALES = ["en", "pt-BR", "es"] as const;
export type PortalLocale = (typeof PORTAL_LOCALES)[number];
export const BASE_LOCALE: PortalLocale = "en";

export interface PortalMessages {
	readonly switcherLabel: string;
	readonly overview: string;
	readonly backToApp: string;
	readonly signOut: string;
	readonly userFallback: string;
}

const en: PortalMessages = {
	switcherLabel: "Switch portal",
	overview: "Overview",
	backToApp: "back to app",
	signOut: "Sign out",
	userFallback: "account",
};

const ptBR: PortalMessages = {
	switcherLabel: "Trocar de portal",
	overview: "Visão geral",
	backToApp: "voltar ao app",
	signOut: "Sair",
	userFallback: "conta",
};

const es: PortalMessages = {
	switcherLabel: "Cambiar de portal",
	overview: "Visión general",
	backToApp: "volver a la app",
	signOut: "Cerrar sesión",
	userFallback: "cuenta",
};

const CATALOGS: Record<PortalLocale, PortalMessages> = { en, "pt-BR": ptBR, es };

export const isPortalLocale = (locale: string): locale is PortalLocale =>
	(PORTAL_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const portalMessages = (locale: string): PortalMessages =>
	CATALOGS[isPortalLocale(locale) ? locale : BASE_LOCALE];
