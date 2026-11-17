import { createCatalogT, I18N_BASE_CATALOG } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

/**
 * `app.*` copy catalog (PL-008 Phase 5). The DB route slice wins; the
 * generated English baseline (`messages/en.json` → I18N_BASE_CATALOG)
 * is the last-resort layer so copy never degrades to raw keys.
 */

/** `app.*`-prefixed English baseline entries. */
export const APP_EN: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(I18N_BASE_CATALOG).map(([key, value]) => [`app.${key}`, value]),
);

/** Catalog `t` over `app.*` keys: DB slice over the English baseline. */
export const appCatalogT = (
	slice: PageI18nSlice | undefined,
): ((key: string, params?: Readonly<Record<string, unknown>>) => string) =>
	createCatalogT({ ...APP_EN, ...(slice?.catalog ?? {}) }, slice?.locale ?? "en");
