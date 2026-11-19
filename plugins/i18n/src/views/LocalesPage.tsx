import { useState } from "react";

import { useRouter } from "@tanstack/react-router";
import { Badge } from "@ktbhealth/ui/components/badge";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Switch } from "@ktbhealth/ui/components/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

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
 */
export function LocalesPage({ data }: { data: LocalesPageData }) {
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

	return (
		<PageContainer>
			<PageHeader
				title="Locales"
				description="Enabled locales and fallback chains — runtime data, no rebuild needed."
			/>
			{error !== null && <p className="mb-3 text-sm text-destructive">{error}</p>}
			{notice !== null && <p className="mb-3 text-sm text-muted-foreground">{notice}</p>}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Locale</TableHead>
						<TableHead>Code</TableHead>
						<TableHead>Fallbacks</TableHead>
						<TableHead className="w-24">Enabled</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{data.locales.map((l) => (
						<TableRow key={l.code}>
							<TableCell>
								<span className="flex items-center gap-2">
									{l.endonym}
									{!l.enabled && <Badge variant="secondary">disabled</Badge>}
								</span>
							</TableCell>
							<TableCell className="font-mono text-xs">{l.code}</TableCell>
							<TableCell className="text-sm text-muted-foreground">
								{l.fallbacks.length > 0 ? l.fallbacks.join(" → ") : "—"}
							</TableCell>
							<TableCell>
								<Switch
									size="sm"
									checked={l.enabled}
									disabled={busy !== null}
									onCheckedChange={(c) => void toggle(l.code, c === true)}
									aria-label={`Toggle locale ${l.code}`}
								/>
							</TableCell>
						</TableRow>
					))}
					{data.locales.length === 0 && (
						<TableRow>
							<TableCell colSpan={4} className="text-center text-muted-foreground">
								No locales configured.
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
		</PageContainer>
	);
}
