import type { ResolvedTheme } from "../types.ts";

/**
 * Brand mark rendered inside PortalShell's fixed `brand` slot (P-082):
 * the theme's logo (light/dark variants picked by CSS `dark:` classes —
 * `.dark` stays user-preference driven) or, failing assets, the app
 * name as text. Renders null when the theme carries no brand data so
 * the host's default wordmark shows through.
 */
export function ThemeBrandMark({ theme }: { readonly theme: ResolvedTheme | null | undefined }) {
	const brand = theme?.brand;
	const appName = theme?.appName ?? brand?.appName ?? null;
	const logoLight = brand?.logoLight ?? null;
	const logoDark = brand?.logoDark ?? null;
	const wordmark = brand?.wordmark ?? null;

	if (logoLight !== null || logoDark !== null) {
		return (
			<span className="flex h-8 items-center">
				{logoLight !== null ? (
					<img src={logoLight} alt={appName ?? ""} className="h-8 w-auto dark:hidden" />
				) : null}
				{logoDark !== null ? (
					<img src={logoDark} alt={appName ?? ""} className="hidden h-8 w-auto dark:block" />
				) : null}
			</span>
		);
	}
	if (wordmark !== null) {
		return <img src={wordmark} alt={appName ?? ""} className="h-8 w-auto" />;
	}
	if (appName !== null && appName !== "") {
		return <span className="truncate text-sm font-semibold">{appName}</span>;
	}
	return null;
}
