import { LanguageToggle } from "@ktbhealth/ui/components/language-toggle";
import type { ChromeProps } from "@ktb/kernel";

/**
 * Locale picker contributed to `app.header.actions`: every value comes
 * from the host-injected ChromeProps (plugins cannot import the host's
 * i18n runtime); the menu label falls back to English when the host
 * doesn't fill `labels.langMenu`.
 *
 * The app-shell brand block moved to the theme plugin (PL-006 phase 7)
 * — brand lives in theme data (`app.header.brand` ← theme.brand), so
 * @ktb/site no longer contributes one.
 */
export function SiteLocaleToggle({ locale, locales, localeName, setLocale, labels }: ChromeProps) {
	return (
		<LanguageToggle
			locales={locales}
			value={locale}
			onValueChange={setLocale}
			labels={Object.fromEntries(locales.map((l) => [l, localeName(l)]))}
			label={labels.langMenu ?? "Language"}
		/>
	);
}
