import { useEffect, useState } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Button } from "@ktbhealth/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ktbhealth/ui/components/dropdown-menu";

import { I18N_NAMESPACE, themeMessages } from "../i18n.ts";
import { applyColorScheme, COLOR_SCHEMES, readColorScheme } from "../scheme.ts";
import type { ThemeColorScheme } from "../types.ts";

const SCHEME_ICON = {
	light: SunIcon,
	dark: MoonIcon,
	system: MonitorIcon,
} as const;

/**
 * Landing-nav color-scheme toggle (light|dark|system) — available to
 * every session, unlike the admin-only theme preview popover. Writes
 * the `ktb-color-scheme` cookie and applies `.dark` instantly; the
 * __root__ head script keeps it correct across reloads and OS changes.
 */
export function ColorSchemeToggle({
	i18n,
	locale = "en",
}: {
	readonly i18n?: PageI18nSlice;
	readonly locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, themeMessages(locale));
	const [scheme, setScheme] = useState<ThemeColorScheme>("system");

	useEffect(() => {
		setScheme(readColorScheme());
	}, []);

	const label =
		scheme === "light" ? t.schemeLight : scheme === "dark" ? t.schemeDark : t.schemeSystem;
	const Icon = SCHEME_ICON[scheme];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Button variant="ghost" size="icon" aria-label={`${t.schemeLabel}: ${label}`} />}
			>
				<Icon className="size-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup
					value={scheme}
					onValueChange={(v) => {
						const next = v as ThemeColorScheme;
						setScheme(next);
						applyColorScheme(next);
					}}
				>
					{COLOR_SCHEMES.map((s) => (
						<DropdownMenuRadioItem key={s} value={s}>
							{s === "light" ? t.schemeLight : s === "dark" ? t.schemeDark : t.schemeSystem}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
