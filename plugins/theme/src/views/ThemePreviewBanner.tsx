import { useState } from "react";
import { XIcon } from "lucide-react";

import { Button } from "@ktbhealth/ui/components/button";

import { setThemePreviewFn } from "../fns.ts";
import { themeMessages } from "../i18n.ts";

/**
 * Dismissible banner rendered by shells while the resolved theme came
 * from the admin `ktb-theme-preview` cookie (`ResolvedTheme.preview`).
 * "Exit preview" clears the cookie server-side and reloads so every
 * loader re-resolves to the real theme. Rendered only for admins —
 * non-admin sessions never resolve a preview row.
 */
export function ThemePreviewBanner({ locale = "en" }: { readonly locale?: string }) {
	const t = themeMessages(locale);
	const [busy, setBusy] = useState(false);
	const exit = async () => {
		setBusy(true);
		try {
			await setThemePreviewFn({ data: { themeId: null } });
			window.location.reload();
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex items-center justify-center gap-3 border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
			<span>{t.bannerText}</span>
			<Button
				variant="ghost"
				size="sm"
				className="h-6 px-2 text-xs"
				disabled={busy}
				onClick={() => void exit()}
			>
				<XIcon className="mr-1 size-3" />
				{t.bannerExit}
			</Button>
		</div>
	);
}
