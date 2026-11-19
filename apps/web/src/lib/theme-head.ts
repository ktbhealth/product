import type { ResolvedTheme } from "@ktb/theme/types";
import { themeHead, themeTitle } from "@ktb/theme/head";

/** Theme head projection shared by the portal-context dispatchers
 * (was duplicated across platform.tsx and portal.$instance.$.tsx):
 * favicon/OG/font links + title from the resolved instance theme.
 * The `:root`/`.dark` style block is NOT emitted here — PortalShell
 * owns the single style emitter via `themeCss`. */
export const themeHeadResult = (theme: ResolvedTheme | null | undefined) => {
	if (theme === null || theme === undefined) return {};
	const head = themeHead(theme);
	const title = themeTitle(theme);
	return {
		meta: [...(title !== null ? [{ title }] : []), ...head.meta],
		links: [...head.links],
	};
};
