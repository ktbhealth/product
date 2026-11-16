import { Link } from "@tanstack/react-router";

import type { ChromeProps } from "@ktb/kernel";

import type { ResolvedTheme } from "../types.ts";
import { ThemeBrandMark } from "./ThemeBrandMark.tsx";

/**
 * App-shell brand block contributed to `app.header.brand` (PL-006
 * phase 7): renders the resolved theme's brand mark — logo pair,
 * wordmark or app name — linking to "/". The theme arrives through the
 * host-injected `ChromeProps.theme` (kernel stays dependency-free, so
 * the payload is narrowed here); absent brand data renders nothing
 * rather than a hardcoded wordmark — brand lives in theme data only.
 */
export function ThemeAppBrand(props: ChromeProps) {
	const theme = (props.theme ?? null) as ResolvedTheme | null;
	if (theme === null || (theme.brand === null && (theme.appName ?? "") === "")) {
		return null;
	}
	return (
		<Link to="/" className="flex items-center gap-2.5" aria-label={theme.appName ?? undefined}>
			<ThemeBrandMark theme={theme} />
		</Link>
	);
}
