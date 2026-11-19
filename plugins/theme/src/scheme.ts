import { THEME_SCHEME_COOKIE, type ThemeColorScheme } from "./types.ts";

export const COLOR_SCHEMES = ["light", "dark", "system"] as const;

export const readColorScheme = (): ThemeColorScheme => {
	if (typeof document === "undefined") return "system";
	for (const part of document.cookie.split(";")) {
		const i = part.indexOf("=");
		if (part.slice(0, i).trim() === THEME_SCHEME_COOKIE) {
			const v = part.slice(i + 1).trim();
			if (v === "light" || v === "dark" || v === "system") return v;
		}
	}
	return "system";
};

/** Persist the preference and apply `.dark` immediately — no reload. */
export const applyColorScheme = (next: ThemeColorScheme) => {
	document.cookie = `${THEME_SCHEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
	const dark =
		next === "dark" ||
		(next === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("dark", dark);
};
