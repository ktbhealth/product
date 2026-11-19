import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { DataToolbar } from "@ktbhealth/ui/components/data-toolbar";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { SearchInput } from "@ktbhealth/ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import { Toast, type ToastData } from "@ktbhealth/ui/components/app-toast";
import type { PanelPageContext } from "@ktb/kernel";

import { syncFontProviderFn } from "../fns.ts";
import { fontMessages } from "../i18n.ts";
import type { FontFamilyStatus, FontFamilySummary, FontProviderSummary } from "../types.ts";

export interface FontsPageData {
	readonly providers: readonly FontProviderSummary[];
	readonly families: readonly FontFamilySummary[];
}

const ALL = "__all__";

const STATUS_TONE: Record<FontFamilyStatus, "secondary" | "default" | "destructive"> = {
	pending: "secondary",
	ready: "default",
	failed: "destructive",
};

/**
 * `/platform/fonts` admin page — the synced family catalog across
 * providers: provider filter, per-provider (or all) sync, weight chips
 * and status badges.
 */
export function FontsPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const t = fontMessages(ctx.locale);
	const router = useRouter();
	const payload = data as FontsPageData | null;
	const providers = payload?.providers ?? [];
	const families = payload?.families ?? [];
	const providerName = new Map(providers.map((p) => [p.id, p.name]));

	const [q, setQ] = useState("");
	const [providerFilter, setProviderFilter] = useState<string>(ALL);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [toast, setToast] = useState<ToastData | null>(null);

	const needle = q.trim().toLowerCase();
	const filtered = families.filter((family) => {
		if (providerFilter !== ALL && String(family.providerId) !== providerFilter) return false;
		if (needle === "") return true;
		return [family.family, providerName.get(family.providerId) ?? ""]
			.join(" ")
			.toLowerCase()
			.includes(needle);
	});

	const statusLabel = (status: FontFamilyStatus): string =>
		status === "ready" ? t.statusReady : status === "failed" ? t.statusFailed : t.statusPending;

	const syncTargets =
		providerFilter === ALL ? providers.map((p) => p.id) : [Number(providerFilter)];

	const sync = async () => {
		if (busy || syncTargets.length === 0) return;
		setBusy(true);
		setNotice(null);
		try {
			for (const id of syncTargets) {
				await syncFontProviderFn({ data: { id } });
			}
			setToast({ id: Date.now(), text: t.syncedToast });
			await router.invalidate();
		} catch {
			setNotice(t.syncError);
		} finally {
			setBusy(false);
		}
	};

	return (
		<PageContainer>
			<PageHeader
				title={t.fontsTitle}
				description={t.fontsDescription}
				actions={
					<Button size="sm" onClick={() => void sync()} disabled={busy || syncTargets.length === 0}>
						{busy ? <Spinner className="size-4" /> : <RefreshCwIcon data-icon="inline-start" />}
						{busy ? t.syncing : t.sync}
					</Button>
				}
			/>

			{notice !== null ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

			{families.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyTitle>{t.emptyFamilies}</EmptyTitle>
					</EmptyHeader>
					<EmptyContent>
						<Button size="sm" onClick={() => void sync()} disabled={busy || providers.length === 0}>
							{busy ? <Spinner className="size-4" /> : <RefreshCwIcon data-icon="inline-start" />}
							{busy ? t.syncing : t.sync}
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<>
					<DataToolbar
						search={
							<SearchInput
								value={q}
								onChange={(e) => setQ(e.target.value)}
								placeholder={t.searchPlaceholder}
								aria-label={t.searchLabel}
								className="w-56 sm:w-64"
							/>
						}
						filters={
							providers.length > 0 ? (
								<Select
									items={[
										{ value: ALL, label: t.allProviders },
										...providers.map((p) => ({ value: String(p.id), label: p.name })),
									]}
									value={providerFilter}
									onValueChange={(v) => setProviderFilter(String(v))}
								>
									<SelectTrigger className="w-48" aria-label={t.providerFilterLabel}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ALL}>{t.allProviders}</SelectItem>
										{providers.map((p) => (
											<SelectItem key={p.id} value={String(p.id)}>
												{p.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : undefined
						}
					/>
					<div className="overflow-hidden rounded-lg border border-border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t.colFamily}</TableHead>
									<TableHead>{t.colProvider}</TableHead>
									<TableHead>{t.colWeights}</TableHead>
									<TableHead>{t.colStatus}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filtered.length === 0 ? (
									<TableRow>
										<TableCell colSpan={4} className="text-xs text-muted-foreground">
											{t.noResults}
										</TableCell>
									</TableRow>
								) : (
									filtered.map((family) => (
										<TableRow key={family.id}>
											<TableCell className="text-sm font-medium">{family.family}</TableCell>
											<TableCell className="text-sm text-muted-foreground">
												{providerName.get(family.providerId) ?? `#${family.providerId}`}
											</TableCell>
											<TableCell>
												<div className="flex flex-wrap gap-1">
													{family.weights.length === 0 ? (
														<span className="text-xs text-muted-foreground">{t.weightsNone}</span>
													) : (
														family.weights.map((w) => (
															<Badge key={w} variant="outline" className="tabular-nums">
																{w}
															</Badge>
														))
													)}
												</div>
											</TableCell>
											<TableCell>
												<Badge variant={STATUS_TONE[family.status]}>
													{statusLabel(family.status)}
												</Badge>
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</>
			)}

			<Toast toast={toast} onClose={() => setToast(null)} />
		</PageContainer>
	);
}
