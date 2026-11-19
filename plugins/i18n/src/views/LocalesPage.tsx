import { useState } from "react";

import { useRouter } from "@tanstack/react-router";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Switch } from "@ktbhealth/ui/components/switch";
import { viewsMessages } from "@ktb/views";
import { TablePage, type Column } from "@ktb/views/table";

import { i18nSetLocaleFn } from "../fns.ts";
import type { LocaleInfo } from "../contract.ts";

export interface LocalesPageData {
	readonly locales: readonly LocaleInfo[];
}

/**
 * /platform/i18n/locales — locale administration: enable/disable
 * toggles plus the resolved fallback chain per locale. Locales are
 * runtime data (`i18n_locales`), so changes take effect without a
 * rebuild; disabled locales drop out of the messages matrix columns.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell + `Column` model. The toggle stays a manual mutation — the
 * kit's `useServerMutation` only reports a boolean and this page
 * surfaces the server's `error` string verbatim.
 */
export function LocalesPage({
	data,
	locale = "en",
}: {
	data: LocalesPageData;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const toggle = async (code: string, enabled: boolean) => {
		setError(null);
		setNotice(null);
		setBusy(code);
		try {
			const res = (await i18nSetLocaleFn({ data: { code, enabled } })) as {
				ok?: boolean;
				error?: string;
			} | null;
			if (res?.ok === false) {
				setError(res.error ?? `denied toggling ${code}`);
				return;
			}
			setNotice(`${code} ${enabled ? "enabled" : "disabled"}.`);
			await router.invalidate();
		} finally {
			setBusy(null);
		}
	};

	const columns: Column<LocaleInfo>[] = [
		{
			key: "endonym",
			header: "Locale",
			render: (l) => (
				<span className="flex items-center gap-2">
					{l.endonym}
					{!l.enabled && <Badge variant="secondary">disabled</Badge>}
				</span>
			),
		},
		{
			key: "code",
			header: "Code",
			render: (l) => <span className="font-mono text-xs">{l.code}</span>,
		},
		{
			key: "fallbacks",
			header: "Fallbacks",
			render: (l) => (
				<span className="text-muted-foreground">
					{l.fallbacks.length > 0 ? l.fallbacks.join(" → ") : "—"}
				</span>
			),
		},
		{
			key: "enabled",
			header: "Enabled",
			width: "6rem",
			render: (l) => (
				<Switch
					size="sm"
					checked={l.enabled}
					disabled={busy !== null}
					onCheckedChange={(c) => void toggle(l.code, c === true)}
					aria-label={`Toggle locale ${l.code}`}
				/>
			),
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title="Locales"
				description="Enabled locales and fallback chains — runtime data, no rebuild needed."
			/>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			{notice !== null && <p className="text-sm text-muted-foreground">{notice}</p>}
			<TablePage.Table
				columns={columns}
				rows={data.locales}
				rowKey={(l) => l.code}
				total={data.locales.length}
				empty={{ title: "No locales configured." }}
				locale={locale}
			/>
		</TablePage>
	);
}
