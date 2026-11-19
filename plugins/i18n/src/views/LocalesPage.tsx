import { useState } from "react";

import { useRouter } from "@tanstack/react-router";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Switch } from "@ktbhealth/ui/components/switch";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { viewsMessages } from "@ktb/views";
import { TablePage, type Column } from "@ktb/views/table";

import { i18nSetLocaleFn } from "../fns.ts";
import type { LocaleInfo } from "../contract.ts";
import { i18nAdminMessages, I18N_NAMESPACE } from "../i18n.ts";

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
	i18n,
}: {
	data: LocalesPageData;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
	/** Resolved DB-catalog slice — absent on surfaces without it. */
	i18n?: PageI18nSlice;
}) {
	const router = useRouter();
	const m = sliceMessages(i18n, I18N_NAMESPACE, i18nAdminMessages(locale));
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
				setError(res.error ?? m.locales.toggleDenied(code));
				return;
			}
			setNotice(enabled ? m.locales.noticeEnabled(code) : m.locales.noticeDisabled(code));
			await router.invalidate();
		} finally {
			setBusy(null);
		}
	};

	const columns: Column<LocaleInfo>[] = [
		{
			key: "endonym",
			header: m.locales.colLocale,
			render: (l) => (
				<span className="flex items-center gap-2">
					{l.endonym}
					{!l.enabled && <Badge variant="secondary">{m.common.disabled}</Badge>}
				</span>
			),
		},
		{
			key: "code",
			header: m.locales.colCode,
			render: (l) => <span className="font-mono text-xs">{l.code}</span>,
		},
		{
			key: "fallbacks",
			header: m.locales.colFallbacks,
			render: (l) => (
				<span className="text-muted-foreground">
					{l.fallbacks.length > 0 ? l.fallbacks.join(" → ") : "—"}
				</span>
			),
		},
		{
			key: "enabled",
			header: m.locales.colEnabled,
			width: "6rem",
			render: (l) => (
				<Switch
					size="sm"
					checked={l.enabled}
					disabled={busy !== null}
					onCheckedChange={(c) => void toggle(l.code, c === true)}
					aria-label={m.locales.toggle(l.code)}
				/>
			),
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header title={m.locales.title} description={m.locales.description} />
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			{notice !== null && <p className="text-sm text-muted-foreground">{notice}</p>}
			<TablePage.Table
				columns={columns}
				rows={data.locales}
				rowKey={(l) => l.code}
				total={data.locales.length}
				empty={{ title: m.locales.empty }}
				locale={locale}
			/>
		</TablePage>
	);
}
