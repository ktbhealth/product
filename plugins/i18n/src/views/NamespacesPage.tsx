import { useMemo } from "react";

import { PSEUDO_LOCALE } from "@ktb/i18n";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import type { LocaleInfo, NamespaceCoverage, NamespaceInfo } from "../contract.ts";

export interface NamespacesPageData {
	readonly namespaces: readonly NamespaceInfo[];
	readonly coverage: readonly NamespaceCoverage[];
	readonly locales: readonly LocaleInfo[];
}

interface NamespaceRow {
	readonly namespace: string;
	readonly pluginId: string;
	readonly defaultLocale: string;
	readonly keyCount: number;
	readonly translated: Readonly<Record<string, number>> | undefined;
}

/**
 * /platform/i18n/namespaces — per-namespace translation coverage
 * (global scope). Read-only: namespaces come from the plugin
 * manifests, coverage from the published/draft message rows. The
 * two lists can disagree (a namespace may have rows but no manifest
 * entry, or vice versa), so rows are the union of both, sorted by
 * namespace name; coverage rows win on pluginId/defaultLocale when
 * the manifest side is missing.
 */
export function NamespacesPage({ data }: { data: NamespacesPageData }) {
	// qps is pseudo-localized at slice time — it has no stored rows,
	// so it would render as an all-"missing" column. Keep it out,
	// same as the messages matrix.
	const locales = useMemo(
		() => data.locales.filter((l) => l.enabled && l.code !== PSEUDO_LOCALE),
		[data.locales],
	);

	const rows = useMemo<readonly NamespaceRow[]>(() => {
		const nsByName = new Map(data.namespaces.map((n) => [n.namespace, n]));
		const covByName = new Map(data.coverage.map((c) => [c.namespace, c]));
		const names = [...new Set([...nsByName.keys(), ...covByName.keys()])].sort();
		return names.map((name) => {
			const ns = nsByName.get(name);
			const cov = covByName.get(name);
			return {
				namespace: name,
				pluginId: ns?.pluginId ?? cov?.pluginId ?? "",
				defaultLocale: ns?.defaultLocale ?? cov?.defaultLocale ?? "",
				keyCount: cov?.keyCount ?? ns?.messageCount ?? 0,
				translated: cov?.translated,
			};
		});
	}, [data.namespaces, data.coverage]);

	const summary = useMemo(() => {
		const totalKeys = rows.reduce((acc, r) => acc + r.keyCount, 0);
		// A locale counts as incomplete when at least one namespace
		// has keys missing a published live value for it.
		const incompleteLocales = locales.filter((l) =>
			rows.some((r) => {
				if (r.keyCount === 0) return false;
				return (r.translated?.[l.code] ?? 0) < r.keyCount;
			}),
		).length;
		return { totalKeys, incompleteLocales };
	}, [rows, locales]);

	return (
		<PageContainer>
			<PageHeader
				title="Namespaces"
				description="Registered message namespaces and per-locale translation coverage (global scope)."
			/>
			{rows.length > 0 && (
				<p className="mb-3 text-sm text-muted-foreground">
					{rows.length} {rows.length === 1 ? "namespace" : "namespaces"} · {summary.totalKeys}{" "}
					{summary.totalKeys === 1 ? "key" : "keys"} · {summary.incompleteLocales}{" "}
					{summary.incompleteLocales === 1 ? "locale" : "locales"} below full coverage
				</p>
			)}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Namespace</TableHead>
						<TableHead>Plugin</TableHead>
						<TableHead>Default locale</TableHead>
						<TableHead>Keys</TableHead>
						{locales.map((l) => (
							<TableHead key={l.code}>{l.endonym}</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.namespace}>
							<TableCell className="font-mono text-xs">{row.namespace}</TableCell>
							<TableCell className="text-xs text-muted-foreground">
								{row.pluginId === "" ? "—" : row.pluginId}
							</TableCell>
							<TableCell className="font-mono text-xs">
								{row.defaultLocale === "" ? (
									<span className="text-muted-foreground">—</span>
								) : (
									row.defaultLocale
								)}
							</TableCell>
							<TableCell>{row.keyCount}</TableCell>
							{locales.map((l) => {
								if (row.keyCount === 0) {
									return (
										<TableCell key={l.code}>
											<span className="text-muted-foreground">—</span>
										</TableCell>
									);
								}
								const translated = row.translated?.[l.code] ?? 0;
								const pct = Math.round((translated / row.keyCount) * 100);
								const missing = row.keyCount - translated;
								return (
									<TableCell key={l.code}>
										<div className="flex flex-col">
											<span className={pct === 100 ? "text-sm" : "text-sm text-warning"}>
												{translated}/{row.keyCount} · {pct}%
											</span>
											{missing > 0 && (
												<span className="text-xs text-muted-foreground">· {missing} missing</span>
											)}
										</div>
									</TableCell>
								);
							})}
						</TableRow>
					))}
					{rows.length === 0 && (
						<TableRow>
							<TableCell colSpan={4 + locales.length} className="text-center text-muted-foreground">
								No namespaces registered.
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
		</PageContainer>
	);
}
