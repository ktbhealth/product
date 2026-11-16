import { useEffect, useState } from "react";
import { PaletteIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Button } from "@ktbhealth/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ktbhealth/ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ktbhealth/ui/components/tooltip";

import { listThemesFn, setThemePreviewFn } from "../fns.ts";
import { themeMessages, I18N_NAMESPACE } from "../i18n.ts";
import type { ThemeScopeKind, ThemeSummary } from "../types.ts";

const SCOPE_LABEL: Record<ThemeScopeKind, string> = {
	platform: "platform",
	tenant: "tenant",
	"portal-instance": "portal",
};

/**
 * Header action contributed via `portal.header.actions` chrome (P-082):
 * a popover listing every defined theme with a Preview button that sets
 * the admin-only `ktb-theme-preview` cookie and reloads, plus a link to
 * the /platform/theme editor. Renders nothing until the (admin-gated)
 * list resolves — non-admins see an empty popover-free trigger state
 * degrade to nothing at all.
 *
 * Degradation contract mirrors JobsHeaderAction: the contribution
 * declares `optionalDeps: [platform.header]` so a host without the
 * extension point simply drops the entry; the data path (server fns)
 * independently re-checks PlatformAdmin, so this component never
 * exposes preview controls to non-admins.
 */
export function ThemeHeaderAction({
	i18n,
	locale = "en",
}: {
	readonly i18n?: PageI18nSlice;
	readonly locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, themeMessages(locale));
	const [themes, setThemes] = useState<readonly ThemeSummary[] | null>(null);
	const [busy, setBusy] = useState<number | "off" | null>(null);

	useEffect(() => {
		let cancelled = false;
		listThemesFn()
			.then((rows) => {
				if (!cancelled) setThemes(rows);
			})
			.catch(() => {
				if (!cancelled) setThemes([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Non-admins / failures resolve to an empty list — hide entirely.
	if (themes === null || themes.length === 0) return null;

	const preview = async (themeId: number | null) => {
		// "off" is reserved for a future exit-preview action — rows only
		// ever preview a concrete theme id today.
		/* v8 ignore next -- preview() is only invoked with a theme id */
		setBusy(themeId ?? "off");
		try {
			await setThemePreviewFn({ data: { themeId } });
			window.location.reload();
		} finally {
			setBusy(null);
		}
	};

	return (
		<TooltipProvider>
			<Popover>
				<Tooltip>
					<TooltipTrigger
						render={
							<PopoverTrigger
								render={<Button variant="ghost" size="icon" aria-label={t.headerLabel} />}
							/>
						}
					>
						<PaletteIcon className="size-4" />
					</TooltipTrigger>
					<TooltipContent>{t.headerLabel}</TooltipContent>
				</Tooltip>
				<PopoverContent align="end" className="w-80 p-0">
					<PopoverHeader className="border-b border-border px-3 py-2">
						<PopoverTitle className="text-sm">{t.headerLabel}</PopoverTitle>
					</PopoverHeader>
					<div className="flex max-h-80 flex-col gap-1 overflow-y-auto p-2">
						{themes.map((theme) => (
							<div
								key={theme.id}
								className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
							>
								<div className="min-w-0">
									<div className="truncate text-sm">
										{theme.appName ?? `${SCOPE_LABEL[theme.scope]} · ${theme.scopeId || "—"}`}
									</div>
									<div className="text-xs text-muted-foreground">
										{SCOPE_LABEL[theme.scope]}
										{theme.scopeId === "" ? "" : ` · ${theme.scopeId}`}
										{theme.enabled ? "" : " · disabled"}
									</div>
								</div>
								<Button
									variant="outline"
									size="sm"
									disabled={busy !== null || !theme.enabled}
									onClick={() => void preview(theme.id)}
								>
									{busy === theme.id ? t.previewing : t.headerPreview}
								</Button>
							</div>
						))}
					</div>
					<div className="border-t border-border p-2">
						{/* Panel pages dispatch through the /platform/$ splat —
						    a plain anchor avoids depending on generated route
						    types for a contributed path. */}
						<a href="/platform/theme" className="block">
							<Button variant="ghost" size="sm" className="w-full">
								{t.headerManage}
							</Button>
						</a>
					</div>
				</PopoverContent>
			</Popover>
		</TooltipProvider>
	);
}
